// The private web UI and API for the score library. There is no login: it must only be reachable
// from your own machine or network, which `private.ts` enforces. Public replay pages will be
// served by a separate app on a separate port.

import fs from "node:fs";
import { Hono, type Context } from "hono";
import type { Config } from "../config.ts";
import type { Sql } from "../db/index.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { OsuClient } from "../osu/api.ts";
import type { Player } from "../player.ts";
import { scoreCsv } from "../scores/csv.ts";
import { getScore, listScores, parseScoreFilters, scoreStats } from "../scores/query.ts";
import { SYNC_MODES, type SyncMode } from "../sync/checkpoint.ts";
import { enqueueSync, syncOverview } from "../sync/queue.ts";
import { mountMatchRoutes } from "./match-routes.ts";
import { checkPrivateRequest } from "./private.ts";
import { dashboardPage, messagePage, scorePage, syncStatus } from "./views.ts";

export interface AppDeps {
  sql: Sql;
  /** Null when osu! credentials aren't configured: browsing works, imports don't. */
  osu: OsuClient | null;
  player: Player;
  config: Pick<Config, "RECENT_WINDOW_HOURS" | "PRIVATE_HOSTS"> & Partial<Pick<Config, "MATCH_DISCOVERY">>;
}

const ASSETS: Record<string, { type: string; body: string }> = {
  "app.css": { type: "text/css; charset=utf-8", body: fs.readFileSync(new URL("./assets/app.css", import.meta.url), "utf8") },
  "app.js": { type: "text/javascript; charset=utf-8", body: fs.readFileSync(new URL("./assets/app.js", import.meta.url), "utf8") },
};

const LINK_RECHECK_MS = 60 * 60 * 1000;
const PRIVATE = { "Cache-Control": "private, no-store" };

function positiveId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function createApp(deps: AppDeps): Hono {
  const { sql, player } = deps;
  const app = new Hono();
  const isApi = (c: Context) => c.req.path.startsWith("/api/");

  app.onError((error, c) => {
    const status = error instanceof UserError ? 400 : 500;
    if (status === 500) console.error(error);
    const message = error instanceof UserError ? error.message : "Something went wrong. Check the server log.";
    return isApi(c) ? c.json({ error: message }, status) : c.html(messagePage("Error", message, player), status);
  });

  // Health checks come from the container runtime, before any hostname applies.
  app.get("/healthz", (c) => c.text("ok"));

  app.use("*", async (c, next) => {
    const check = checkPrivateRequest(c.req.method, { get: (name) => c.req.header(name) }, deps.config.PRIVATE_HOSTS);
    if (check.ok) return next();
    const message = `This page is private to your own network. The request ${check.reason}.`;
    return isApi(c) ? c.json({ error: message }, 403) : c.text(message, 403);
  });

  app.get("/assets/:name", (c) => {
    const asset = ASSETS[c.req.param("name")];
    if (!asset) return c.notFound();
    return c.body(asset.body, 200, { "Content-Type": asset.type, "Cache-Control": "no-cache" });
  });

  async function queue(mode: SyncMode, trigger: "manual" | "api", windowHours?: number) {
    if (!deps.osu) throw new UserError("Imports need OSU_CLIENT_ID and OSU_CLIENT_SECRET to be configured.");
    return enqueueSync(sql, { userId: player.id, mode, trigger, recentWindowHours: windowHours ?? deps.config.RECENT_WINDOW_HOURS });
  }

  mountMatchRoutes(app, deps);

  // ---------- pages ----------

  app.get("/", async (c) => {
    const filters = parseScoreFilters(new URL(c.req.url).searchParams);
    const [page, stats, overview] = await Promise.all([listScores(sql, player.id, filters), scoreStats(sql, player.id), syncOverview(sql, player.id)]);
    return c.html(
      dashboardPage({ player, filters, page, stats, overview, osuConfigured: deps.osu !== null, notice: c.req.query("notice") }),
      200,
      PRIVATE,
    );
  });

  app.get("/scores/:id", async (c) => {
    const id = positiveId(c.req.param("id"));
    const score = id ? await getScore(sql, player.id, id) : null;
    if (!score) return c.html(messagePage("Not found", "That score isn't in the library.", player), 404);
    return c.html(scorePage(score, player), 200, PRIVATE);
  });

  app.get("/partials/sync", async (c) => c.html(syncStatus(await syncOverview(sql, player.id)), 200, PRIVATE));

  app.post("/sync", async (c) => {
    const form = await c.req.parseBody();
    const mode = form.mode;
    if (typeof mode !== "string" || !(SYNC_MODES as readonly string[]).includes(mode)) throw new UserError("Unknown sync mode.");
    if (mode === "reset" && form.confirm !== "RESET") throw new UserError("Type RESET to confirm clearing and reimporting the library.");
    const result = await queue(mode as SyncMode, "manual");
    const notice = result.alreadyQueued ? "An import is already queued or running." : "Queued. You can close this tab; the worker keeps going.";
    return c.redirect(`/?notice=${encodeURIComponent(notice)}`, 303);
  });

  // ---------- JSON API ----------

  app.get("/api/player", (c) => c.json(player, 200, PRIVATE));

  app.get("/api/scores", async (c) =>
    c.json(await listScores(sql, player.id, parseScoreFilters(new URL(c.req.url).searchParams)), 200, PRIVATE),
  );

  app.get("/api/scores/stats", async (c) => c.json(await scoreStats(sql, player.id), 200, PRIVATE));

  app.get("/api/scores/export", (c) => {
    const filters = parseScoreFilters(new URL(c.req.url).searchParams);
    const body = ReadableStream.from(scoreCsv(sql, player.id, filters)).pipeThrough(new TextEncoderStream());
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="osu-scores-${player.id}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "X-Content-Type-Options": "nosniff",
        ...PRIVATE,
      },
    });
  });

  app.get("/api/scores/:id", async (c) => {
    const id = positiveId(c.req.param("id"));
    const score = id ? await getScore(sql, player.id, id) : null;
    return score ? c.json(score, 200, PRIVATE) : c.json({ error: "Score not found." }, 404);
  });

  /** Check whether the score still exists on osu!. Cached for an hour. */
  app.post("/api/scores/:id/link", async (c) => {
    const id = positiveId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid score id." }, 400);
    const [row] = await sql<{ score_link_status: string; score_link_checked_at: Date | null }[]>`
      select score_link_status, score_link_checked_at from scores where id = ${id} and user_id = ${player.id}`;
    if (!row) return c.json({ error: "Score not found." }, 404);
    let available = row.score_link_status === "available";
    const fresh = row.score_link_checked_at && Date.now() - row.score_link_checked_at.getTime() < LINK_RECHECK_MS;
    if (!fresh || row.score_link_status === "unknown") {
      if (!deps.osu) return c.json({ error: "osu! credentials aren't configured." }, 503);
      try {
        const live = await deps.osu.getScore(id);
        available = live !== null && live.id === id && live.user_id === player.id;
      } catch (error) {
        return c.json({ error: `Couldn't check osu! right now: ${errorMessage(error)}` }, 503);
      }
      await sql`
        update scores set score_link_status = ${available ? "available" : "unavailable"}, score_link_checked_at = now()
        where id = ${id} and user_id = ${player.id}`;
    }
    return c.json({ available, url: available ? `https://osu.ppy.sh/scores/${id}` : null });
  });

  app.get("/api/sync", async (c) => c.json({ ...(await syncOverview(sql, player.id)), osu_configured: deps.osu !== null }, 200, PRIVATE));

  /** Queue a sync: `{"mode": "recent" | "history" | "refresh", "recent_window_hours": 24}`. */
  app.post("/api/sync", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { mode?: unknown; recent_window_hours?: unknown };
    const mode = body.mode ?? "recent";
    if (typeof mode !== "string" || !(SYNC_MODES as readonly string[]).includes(mode) || mode === "reset") {
      return c.json({ error: "mode must be recent, history or refresh. Reset is only available from the web UI." }, 400);
    }
    const hours = Number(body.recent_window_hours);
    const result = await queue(mode as SyncMode, "api", Number.isInteger(hours) && hours > 0 ? hours : undefined);
    return c.json({ run_id: result.runId, already_queued: result.alreadyQueued }, result.alreadyQueued ? 200 : 202);
  });

  return app;
}
