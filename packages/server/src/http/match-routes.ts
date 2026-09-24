// Match database pages and API. Mounted by `createApp` behind the private-network guard.

import type { Hono } from "hono";
import { UserError } from "../errors.ts";
import { discoveryState, scanStableFrom, setDiscoveryEnabled } from "../matches/discovery.ts";
import { parseMatchRefs, type ParsedRefs } from "../matches/import.ts";
import {
  MATCH_SOURCES,
  findMatch,
  getMatchDetail,
  listMatches,
  listTournamentScores,
  matchStats,
  parseMatchFilters,
  parseTournamentScoreFilters,
} from "../matches/query.ts";
import { clearFailed, enqueueMatches, queueOverview, retryFailed } from "../matches/queue.ts";
import { updateMatchSettings } from "../matches/store.ts";
import { createRatingsService } from "../ratings/service.ts";
import type { AppDeps } from "./app.ts";
import { matchesPage, matchPage, tournamentScoresPage } from "./match-views.ts";
import { messagePage } from "./views.ts";

const PRIVATE = { "Cache-Control": "private, no-store" };
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
/** How long the matches page waits for stale ratings before showing the cached ones. */
const RATINGS_WAIT_MS = 1500;

function positiveId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const bounded = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function importNotice(parsed: ParsedRefs, result: { queued: number; known: number }): string {
  if (parsed.refs.length === 0) {
    return parsed.hidden
      ? `No match links found; ${parsed.hidden} hidden qualifier links were skipped.`
      : "No match links found. Paste mp links, ranked play room links, or an Elitebotix history file.";
  }
  const parts = [`Queued ${result.queued} match${result.queued === 1 ? "" : "es"}.`];
  if (result.known) parts.push(`${result.known} already saved.`);
  if (parsed.hidden) parts.push(`${parsed.hidden} hidden qualifier links skipped (Elitebotix hides recent ones).`);
  return parts.join(" ");
}

export function mountMatchRoutes(app: Hono, deps: AppDeps): void {
  const { sql, player } = deps;
  const requireOsu = () => {
    if (!deps.osu) throw new UserError("Fetching matches needs OSU_CLIENT_ID and OSU_CLIENT_SECRET to be configured.");
  };
  const ratings =
    deps.ratings ??
    createRatingsService({ sql, playerId: player.id, otrApiKey: deps.config.OTR_API_KEY, skillIssueSource: deps.config.SKILLISSUE_SOURCE });
  const back = (notice: string, to = "/matches") => `${to}${to.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`;

  async function importText(text: string) {
    const parsed = parseMatchRefs(text);
    const result = await enqueueMatches(sql, parsed.refs, { addedVia: "import" });
    return { parsed, result };
  }

  // ---------- pages ----------

  app.get("/matches", async (c) => {
    const filters = parseMatchFilters(new URL(c.req.url).searchParams);
    await ratings.refreshStale(RATINGS_WAIT_MS);
    const [page, stats, queue, discovery, ratingsOverview] = await Promise.all([
      listMatches(sql, player.id, filters),
      matchStats(sql, player.id),
      queueOverview(sql),
      discoveryState(sql),
      ratings.read(),
    ]);
    return c.html(
      matchesPage({
        player,
        filters,
        page,
        stats,
        ratings: ratingsOverview,
        queue,
        discovery,
        discoveryEnabled: deps.config.MATCH_DISCOVERY ?? true,
        osuConfigured: deps.osu !== null,
        notice: c.req.query("notice"),
      }),
      200,
      PRIVATE,
    );
  });

  app.get("/matches/scores", async (c) => {
    const filters = parseTournamentScoreFilters(new URL(c.req.url).searchParams);
    return c.html(tournamentScoresPage(player, filters, await listTournamentScores(sql, player.id, filters)), 200, PRIVATE);
  });

  app.get("/matches/:id{[0-9]+}", async (c) => {
    const id = positiveId(c.req.param("id"));
    const detail = id ? await getMatchDetail(sql, player.id, id) : null;
    if (!detail) return c.html(messagePage("Not found", "That match isn't in the database.", player), 404);
    return c.html(matchPage(detail, player, c.req.query("notice")), 200, PRIVATE);
  });

  /** `/mp/<id>`: the saved copy of a stable match, like osu!'s short link. */
  app.get("/mp/:id{[0-9]+}", async (c) => {
    const externalId = positiveId(c.req.param("id"));
    const id = externalId ? await findMatch(sql, "stable", externalId) : null;
    if (id) return c.redirect(`/matches/${id}`, 302);
    return c.html(
      messagePage("Not saved yet", `Match ${externalId ?? ""} isn't in the database. Add it from the Matches page to fetch it.`, player),
      404,
    );
  });

  app.post("/matches/add", async (c) => {
    requireOsu();
    const form = await c.req.parseBody();
    const parsed = parseMatchRefs(typeof form.link === "string" ? form.link : "");
    const [ref] = parsed.refs;
    if (!ref) throw new UserError("Paste an mp link (osu.ppy.sh/community/matches/<id>), a ranked play room link (osu.ppy.sh/multiplayer/rooms/<id>) or a match id.");
    const existing = await findMatch(sql, ref.source, ref.externalId);
    if (existing) return c.redirect(`/matches/${existing}`, 303);
    await enqueueMatches(sql, [ref], { addedVia: "manual" });
    return c.redirect(back(`Queued ${ref.source === "stable" ? "match" : "room"} ${ref.externalId}. It appears here once it's fetched.`), 303);
  });

  app.post("/matches/import", async (c) => {
    requireOsu();
    const form = await c.req.parseBody();
    let text = typeof form.text === "string" ? form.text : "";
    const file = form.file;
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_IMPORT_BYTES) throw new UserError("That file is too large to be a match history (over 5 MB).");
      text += `\n${await file.text()}`;
    }
    const { parsed, result } = await importText(text);
    return c.redirect(back(importNotice(parsed, result)), 303);
  });

  app.post("/matches/:id{[0-9]+}/settings", async (c) => {
    const id = positiveId(c.req.param("id"))!;
    const form = await c.req.parseBody();
    const ok = await updateMatchSettings(sql, id, {
      warmups: Math.trunc(bounded(form.warmups, 0, 50, 0)),
      skipLast: Math.trunc(bounded(form.skip_last, 0, 50, 0)),
      ezMultiplier: bounded(form.ez_multiplier, 0.1, 10, 1),
    });
    if (!ok) return c.html(messagePage("Not found", "That match isn't in the database.", player), 404);
    return c.redirect(`/matches/${id}`, 303);
  });

  app.post("/matches/:id{[0-9]+}/refresh", async (c) => {
    requireOsu();
    const id = positiveId(c.req.param("id"))!;
    const [match] = await sql<{ source: "stable" | "lazer"; external_id: number }[]>`select source, external_id from matches where id = ${id}`;
    if (!match) return c.html(messagePage("Not found", "That match isn't in the database.", player), 404);
    await enqueueMatches(sql, [{ source: match.source, externalId: match.external_id }], { addedVia: "manual", refetch: true });
    return c.redirect(back("Queued to be fetched again.", `/matches/${id}`), 303);
  });

  app.post("/matches/ratings/refresh", async (c) => {
    await ratings.refresh();
    const { otr, skillissue } = await ratings.read();
    const failed = [otr, skillissue].filter((p) => p.configured && p.error).length;
    return c.redirect(back(failed ? "Couldn't update every rating; see the ratings card." : "Ratings updated."), 303);
  });

  app.post("/matches/queue/retry", async (c) => c.redirect(back(`Retrying ${await retryFailed(sql)} matches.`), 303));
  app.post("/matches/queue/clear", async (c) => c.redirect(back(`Forgot ${await clearFailed(sql)} matches.`), 303));

  app.post("/matches/discovery", async (c) => {
    const form = await c.req.parseBody();
    const source = form.source;
    if (typeof source !== "string" || !(MATCH_SOURCES as readonly string[]).includes(source)) throw new UserError("Unknown discovery source.");
    await setDiscoveryEnabled(sql, source as "stable" | "lazer", form.enabled === "true");
    return c.redirect("/matches", 303);
  });

  app.post("/matches/discovery/scan", async (c) => {
    const form = await c.req.parseBody();
    const from = positiveId(typeof form.from === "string" ? form.from.trim() : undefined);
    if (!from) throw new UserError("Enter a match id to scan from.");
    await scanStableFrom(sql, from);
    return c.redirect(back(`Discovery will scan stable lobbies from match ${from} onwards.`), 303);
  });

  // ---------- JSON API ----------

  app.get("/api/matches", async (c) => c.json(await listMatches(sql, player.id, parseMatchFilters(new URL(c.req.url).searchParams)), 200, PRIVATE));
  app.get("/api/matches/ratings", async (c) => c.json(await ratings.read(), 200, PRIVATE));
  app.get("/api/matches/stats", async (c) => c.json(await matchStats(sql, player.id), 200, PRIVATE));
  app.get("/api/matches/queue", async (c) => c.json({ queue: await queueOverview(sql), discovery: await discoveryState(sql) }, 200, PRIVATE));
  app.get("/api/matches/scores", async (c) =>
    c.json(await listTournamentScores(sql, player.id, parseTournamentScoreFilters(new URL(c.req.url).searchParams)), 200, PRIVATE),
  );
  app.get("/api/matches/:id{[0-9]+}", async (c) => {
    const id = positiveId(c.req.param("id"));
    const detail = id ? await getMatchDetail(sql, player.id, id) : null;
    return detail ? c.json(detail, 200, PRIVATE) : c.json({ error: "Match not found." }, 404);
  });

  /** Queue matches: `{"text": "<mp links, room links or an Elitebotix history file>"}`. */
  app.post("/api/matches/import", async (c) => {
    requireOsu();
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== "string") return c.json({ error: "Send {\"text\": \"...\"} with match links." }, 400);
    const { parsed, result } = await importText(body.text);
    return c.json({ found: parsed.refs.length, queued: result.queued, known: result.known, hidden: parsed.hidden }, result.queued ? 202 : 200);
  });
}
