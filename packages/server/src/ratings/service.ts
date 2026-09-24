// The player's o!TR and Skill Issue ratings, cached in `external_ratings`. Pages read the cache
// and ask for a background refresh, so a slow or down site never holds up the matches page.

import type { Sql } from "../db/index.ts";
import { sqlJson } from "../db/index.ts";
import { errorMessage } from "../errors.ts";
import {
  fetchOtrRating,
  fetchSkillIssueRating,
  type FetchResult,
  type OtrRating,
  type ProviderOptions,
  type SkillIssueRating,
} from "./providers.ts";

export const RATING_PROVIDERS = ["otr", "skillissue"] as const;
export type RatingProvider = (typeof RATING_PROVIDERS)[number];

/** Ratings move after matches, not by the minute. */
const STALE_MS = 6 * 3600_000;
/** After a failure, wait this long before a page load tries again. */
const RETRY_MS = 30 * 60_000;

export interface ProviderState<T> {
  /** Whether its key is set in `.env`. */
  configured: boolean;
  /** Null until fetched, or when the site has no rating for the player. */
  data: T | null;
  /** Fetched successfully, but the site has no rating for the player. */
  unrated: boolean;
  fetched_at: Date | null;
  error: string | null;
  refreshing: boolean;
}

export interface RatingsOverview {
  otr: ProviderState<OtrRating>;
  skillissue: ProviderState<SkillIssueRating>;
}

export interface RatingsOptions extends Pick<ProviderOptions, "fetch"> {
  sql: Sql;
  playerId: number;
  otrApiKey?: string | undefined;
  skillIssueSource?: string | undefined;
  /** Base URLs, for tests. */
  servers?: Partial<Record<RatingProvider, string>>;
  now?: () => number;
}

export interface RatingsService {
  read(): Promise<RatingsOverview>;
  /** Refetch whatever is configured and stale, waiting at most `waitMs` for it; the rest finishes in the background. */
  refreshStale(waitMs: number): Promise<void>;
  /** Refetch now, even if fresh, and wait for it. */
  refresh(): Promise<void>;
  /** Resolves once no fetch is running. */
  idle(): Promise<void>;
}

interface Row {
  provider: RatingProvider;
  data: unknown;
  fetched_at: Date | null;
  attempted_at: Date;
  error: string | null;
}

export function createRatingsService(options: RatingsOptions): RatingsService {
  const { sql, playerId } = options;
  const now = () => options.now?.() ?? Date.now();
  const inFlight = new Map<RatingProvider, Promise<void>>();

  const keys: Record<RatingProvider, string | undefined> = { otr: options.otrApiKey, skillissue: options.skillIssueSource };
  const configured = (provider: RatingProvider) => Boolean(keys[provider]);
  const providerOptions = (provider: RatingProvider): ProviderOptions => ({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.servers?.[provider] ? { server: options.servers[provider] } : {}),
  });

  function fetchProvider(provider: RatingProvider): Promise<FetchResult<unknown>> {
    const key = keys[provider]!;
    return provider === "otr"
      ? fetchOtrRating(key, playerId, { ...providerOptions(provider), now: now() })
      : fetchSkillIssueRating(key, playerId, providerOptions(provider));
  }

  async function rows(): Promise<Map<RatingProvider, Row>> {
    const list = await sql<Row[]>`
      select provider, data, fetched_at, attempted_at, error from external_ratings where user_id = ${playerId}`;
    return new Map(list.map((row) => [row.provider, row]));
  }

  function refreshOne(provider: RatingProvider): Promise<void> {
    const running = inFlight.get(provider);
    if (running) return running;
    const task = (async () => {
      const at = new Date(now());
      try {
        const result = await fetchProvider(provider);
        const data = result.found ? sqlJson(sql, result.data) : null;
        await sql`
          insert into external_ratings (provider, user_id, data, fetched_at, attempted_at, error)
          values (${provider}, ${playerId}, ${data}, ${at}, ${at}, null)
          on conflict (provider, user_id) do update set
            data = excluded.data, fetched_at = excluded.fetched_at, attempted_at = excluded.attempted_at, error = null`;
      } catch (error) {
        await sql`
          insert into external_ratings (provider, user_id, attempted_at, error)
          values (${provider}, ${playerId}, ${at}, ${errorMessage(error)})
          on conflict (provider, user_id) do update set attempted_at = excluded.attempted_at, error = excluded.error`;
      }
    })().finally(() => inFlight.delete(provider));
    inFlight.set(provider, task);
    return task;
  }

  const isStale = (row: Row | undefined) => {
    if (!row) return true;
    const t = now();
    if (row.error) return t - row.attempted_at.getTime() >= RETRY_MS;
    return !row.fetched_at || t - row.fetched_at.getTime() >= STALE_MS;
  };

  function state<T>(provider: RatingProvider, row: Row | undefined): ProviderState<T> {
    return {
      configured: configured(provider),
      data: (row?.data as T | null | undefined) ?? null,
      unrated: Boolean(row?.fetched_at) && row?.data === null,
      fetched_at: row?.fetched_at ?? null,
      error: row?.error ?? null,
      refreshing: inFlight.has(provider),
    };
  }

  return {
    async read() {
      const byProvider = await rows();
      return { otr: state<OtrRating>("otr", byProvider.get("otr")), skillissue: state<SkillIssueRating>("skillissue", byProvider.get("skillissue")) };
    },
    async refreshStale(waitMs) {
      if (!RATING_PROVIDERS.some(configured)) return;
      const byProvider = await rows();
      const due = RATING_PROVIDERS.filter((provider) => configured(provider) && isStale(byProvider.get(provider)));
      if (due.length === 0) return;
      // Failures are recorded in the table; only a lost database connection gets here.
      const all = Promise.all(due.map(refreshOne)).then(() => {}, () => {});
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([all, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
      clearTimeout(timer);
    },
    async refresh() {
      await Promise.all(RATING_PROVIDERS.filter(configured).map(refreshOne));
    },
    async idle() {
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
