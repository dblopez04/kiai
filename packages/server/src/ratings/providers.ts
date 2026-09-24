// Clients for the two tournament rating sites: o!TR (osu! Tournament Rating) and the Skill Issue
// bot. Both are keyed by osu! user id and only read osu!standard ratings.

import { z } from "zod";

const USER_AGENT = "kiai/0.1 (+https://github.com/dblopez04/kiai)";
const TIMEOUT_MS = 15_000;

export const OTR_SERVER = "https://otr.stagec.net";
export const SKILLISSUE_SERVER = "https://skillissue.app";

export class RatingFetchError extends Error {
  override name = "RatingFetchError";
}

/** What a site answered: a rating, or nothing because it has never rated the player. */
export type FetchResult<T> = { found: true; data: T } | { found: false };

export interface ProviderOptions {
  fetch?: typeof fetch;
  server?: string;
}

async function getJson(url: string, headers: Record<string, string>, options: ProviderOptions, site: string): Promise<unknown | null> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = (error as { name?: string }).name === "TimeoutError" ? "timed out" : "couldn't be reached";
    throw new RatingFetchError(`${site} ${reason}.`, { cause: error });
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = /^\s*\{/.test(body) ? (JSON.parse(body) as { error?: unknown; message?: unknown }) : null;
    const message = typeof detail?.error === "string" ? detail.error : typeof detail?.message === "string" ? detail.message : "";
    throw Object.assign(new RatingFetchError(`${site} answered HTTP ${response.status}${message ? `: ${message}` : "."}`), { status: response.status });
  }
  return response.json();
}

// ---------- o!TR ----------

/** osu!standard; o!TR numbers rulesets like osu! does. */
const OTR_RULESET = 0;
const DAY_MS = 86_400_000;

const otrStats = z.object({
  playerInfo: z.object({ id: z.number(), username: z.string() }),
  rating: z
    .object({
      rating: z.number(),
      volatility: z.number(),
      percentile: z.number(),
      globalRank: z.number(),
      countryRank: z.number(),
      tournamentsPlayed: z.number().default(0),
      matchesPlayed: z.number().default(0),
      winRate: z.number().nullable().default(null),
      isProvisional: z.boolean().default(false),
      tierProgress: z.object({
        currentTier: z.string(),
        currentSubTier: z.number().nullable(),
        nextTier: z.string().nullable().default(null),
        nextSubTier: z.number().nullable().default(null),
        ratingForNextTier: z.number().nullable().default(null),
      }),
      adjustments: z.array(z.object({ timestamp: z.string(), ratingBefore: z.number(), ratingAfter: z.number() })).default([]),
    })
    .nullable(),
});

export interface OtrRating {
  otr_id: number;
  username: string;
  rating: number;
  volatility: number;
  /** 0–100: the share of rated players below. */
  percentile: number;
  global_rank: number;
  country_rank: number;
  tier: string;
  sub_tier: number | null;
  next_tier: string | null;
  next_sub_tier: number | null;
  /** Rating still needed to reach the next tier. */
  rating_for_next_tier: number | null;
  provisional: boolean;
  tournaments: number;
  matches: number;
  /** 0–1. */
  win_rate: number | null;
  peak: number;
  /** Rating gained or lost over the 30 days before the fetch. */
  change_30d: number;
}

/** Sign in at otr.stagec.net and create a key under Settings → API keys. 60 requests a minute. */
export async function fetchOtrRating(apiKey: string, osuId: number, options: ProviderOptions & { now?: number } = {}): Promise<FetchResult<OtrRating>> {
  const url = `${options.server ?? OTR_SERVER}/api/players/${osuId}/stats?keyType=osu&ruleset=${OTR_RULESET}`;
  const json = await getJson(url, { Authorization: `Bearer ${apiKey}` }, options, "o!TR");
  if (json === null) return { found: false };
  const parsed = otrStats.safeParse(json);
  if (!parsed.success) throw new RatingFetchError("o!TR sent a response kiai doesn't understand; its API may have changed.");
  const { playerInfo, rating } = parsed.data;
  if (!rating) return { found: false };

  const since = (options.now ?? Date.now()) - 30 * DAY_MS;
  const recent = rating.adjustments.filter((a) => Date.parse(a.timestamp) >= since);
  return {
    found: true,
    data: {
      otr_id: playerInfo.id,
      username: playerInfo.username,
      rating: rating.rating,
      volatility: rating.volatility,
      percentile: rating.percentile,
      global_rank: rating.globalRank,
      country_rank: rating.countryRank,
      tier: rating.tierProgress.currentTier,
      sub_tier: rating.tierProgress.currentSubTier,
      next_tier: rating.tierProgress.nextTier,
      next_sub_tier: rating.tierProgress.nextSubTier,
      rating_for_next_tier: rating.tierProgress.ratingForNextTier,
      provisional: rating.isProvisional,
      tournaments: rating.tournamentsPlayed,
      matches: rating.matchesPlayed,
      win_rate: rating.winRate,
      peak: Math.max(rating.rating, ...rating.adjustments.map((a) => a.ratingAfter)),
      change_30d: recent.length ? rating.rating - recent[0]!.ratingBefore : 0,
    },
  };
}

export const otrProfileUrl = (r: Pick<OtrRating, "otr_id">) => `${OTR_SERVER}/players/${r.otr_id}`;

// ---------- Skill Issue ----------

// ASP.NET writes camelCase by default; accept PascalCase too in case that changes. Like .NET's
// camelCase policy, a leading run of capitals is lowercased whole: SR → sr, GlobalRank → globalRank.
const camel = (key: string) => key.replace(/^[A-Z]+(?=[A-Z][a-z]|$)|^[A-Z]/, (head) => head.toLowerCase());
const pascal = <T extends z.ZodRawShape>(shape: T) =>
  z.preprocess(
    (value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).map(([key, v]) => [camel(key), v]))
        : value,
    z.object(shape),
  );

const sipRating = pascal({
  name: z.string(),
  value: z.number(),
  sr: z.number(),
  pp: z.number(),
  globalRank: z.number(),
  countryRank: z.number(),
  accuracy: z.number(),
  combo: z.number(),
});

const sipResponse = pascal({
  activeUsername: z.string().nullable().default(null),
  countryCode: z.string().nullable().default(null),
  rating: sipRating.nullable().default(null),
  modifications: z.record(z.string(), sipRating).nullable().default(null),
  skillsets: z.record(z.string(), sipRating).nullable().default(null),
});

export interface SipRating {
  name: string;
  /** The rating itself (SIP): an OpenSkill ordinal on score. */
  value: number;
  /** The star rating Skill Issue expects the player to handle. */
  sr: number;
  /** The ordinal of the same rating judged on pp instead of score. */
  pp: number;
  /** 0 when unranked. */
  global_rank: number;
  country_rank: number;
  /** How much of the rating comes from accuracy rather than combo, 0–1. */
  accuracy: number;
}

export interface SkillIssueRating {
  username: string | null;
  rating: SipRating;
  /** NoMod, Hidden, Hard Rock, Double Time. */
  mods: SipRating[];
  /** Aim, Tapping, Technical, Low AR, High AR, High BPM, Precision. */
  skillsets: SipRating[];
}

const toSip = (r: z.infer<typeof sipRating>): SipRating => ({
  name: r.name,
  value: r.value,
  sr: r.sr,
  pp: r.pp,
  global_rank: r.globalRank,
  country_rank: r.countryRank,
  accuracy: r.accuracy,
});

const MOD_ORDER = ["NoMod", "Hidden", "Hard Rock", "Double Time"];
const byModOrder = (a: SipRating, b: SipRating) => (MOD_ORDER.indexOf(a.name) + 1 || 99) - (MOD_ORDER.indexOf(b.name) + 1 || 99);

/**
 * Skill Issue's API only answers callers whose `source` header its author has allowed; ask
 * JustRoxy on the Skill Issue Discord for one.
 */
export async function fetchSkillIssueRating(source: string, osuId: number, options: ProviderOptions = {}): Promise<FetchResult<SkillIssueRating>> {
  const url = `${options.server ?? SKILLISSUE_SERVER}/ratings/${osuId}`;
  let json: unknown;
  try {
    json = await getJson(url, { source }, options, "Skill Issue");
  } catch (error) {
    if ((error as { status?: number }).status === 403) {
      throw new RatingFetchError("Skill Issue refused the SKILLISSUE_SOURCE key. Check it with JustRoxy.", { cause: error });
    }
    throw error;
  }
  if (json === null) return { found: false };
  const parsed = sipResponse.safeParse(json);
  if (!parsed.success) throw new RatingFetchError("Skill Issue sent a response kiai doesn't understand; its API may have changed.");
  const { activeUsername, rating, modifications, skillsets } = parsed.data;
  // A player it knows but hasn't rated comes back without `rating`.
  if (!rating) return { found: false };
  return {
    found: true,
    data: {
      username: activeUsername,
      rating: toSip(rating),
      mods: Object.values(modifications ?? {}).map(toSip).sort(byModOrder),
      skillsets: Object.values(skillsets ?? {}).map(toSip).sort((a, b) => b.value - a.value),
    },
  };
}
