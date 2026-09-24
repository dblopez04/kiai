import os from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/http/app.ts";
import { mediaPaths } from "../src/media.ts";
import { resolvePlayer, type Player } from "../src/player.ts";
import { fetchOtrRating, fetchSkillIssueRating } from "../src/ratings/providers.ts";
import { createRatingsService, type RatingsService } from "../src/ratings/service.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { fakeOsu } from "./helpers/fake-osu.ts";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function otrStats(osuId: number) {
  return {
    playerInfo: { id: 777, osuId, username: "tester", country: "US", defaultRuleset: 0, osuRestricted: false },
    ruleset: 0,
    rating: {
      ruleset: 0,
      rating: 1480.4,
      volatility: 210.2,
      percentile: 91.37,
      globalRank: 1523,
      countryRank: 311,
      player: { id: 777, osuId, username: "tester", country: "US", defaultRuleset: 0, osuRestricted: false },
      tournamentsPlayed: 12,
      matchesPlayed: 48,
      winRate: 0.5625,
      isProvisional: false,
      tierProgress: {
        currentTier: "Gold",
        currentSubTier: 2,
        nextTier: "Gold",
        nextSubTier: 1,
        ratingForNextTier: 19.6,
        ratingForNextMajorTier: 120,
        nextMajorTier: "Platinum",
        subTierFillPercentage: 0.4,
        majorTierFillPercentage: 0.6,
      },
      adjustments: [
        { timestamp: iso(NOW - 200 * DAY), ratingBefore: 1200, ratingAfter: 1350 },
        { timestamp: iso(NOW - 90 * DAY), ratingBefore: 1350, ratingAfter: 1512 },
        { timestamp: iso(NOW - 20 * DAY), ratingBefore: 1512, ratingAfter: 1470 },
        { timestamp: iso(NOW - 3 * DAY), ratingBefore: 1470, ratingAfter: 1480.4 },
      ],
    },
    matchStats: null,
    modStats: [],
    frequentTeammates: [],
    frequentOpponents: [],
  };
}

const sip = (name: string, value: number, globalRank = 900) => ({
  accuracy: 0.62,
  combo: 0.38,
  countryRank: 120,
  globalRank,
  name,
  pp: value - 40,
  sr: 6.12,
  value,
});

function skillIssueRatings(osuId: number) {
  return {
    activeUsername: "tester",
    countryCode: "US",
    playerId: osuId,
    rating: sip("rating", 2150),
    modifications: { "Double Time": sip("Double Time", 1980), NoMod: sip("NoMod", 2210), Hidden: sip("Hidden", 2100) },
    skillsets: { Aim: sip("Aim", 2050), "Low AR": sip("Low AR", 2300, 0) },
  };
}

interface FakeSite {
  fetch: typeof fetch;
  calls: { url: string; headers: Headers }[];
  respond: (url: URL) => Response;
}

function fakeSites(osuId: number): FakeSite {
  const site: FakeSite = {
    calls: [],
    respond: (url) => {
      if (url.hostname === "otr.test") return Response.json(otrStats(osuId));
      if (url.hostname === "si.test") return Response.json(skillIssueRatings(osuId));
      return new Response("", { status: 500 });
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      site.calls.push({ url: url.toString(), headers: new Headers(init?.headers) });
      return site.respond(url);
    }) as typeof fetch,
  };
  return site;
}

const servers = { otr: "https://otr.test", skillissue: "https://si.test" };

describe("rating providers", () => {
  it("reads an o!TR player's osu!standard rating, rank, tier and recent change", async () => {
    const site = fakeSites(4242);
    const result = await fetchOtrRating("secret-key", 4242, { fetch: site.fetch, server: servers.otr, now: NOW });
    expect(site.calls[0]!.url).toBe("https://otr.test/api/players/4242/stats?keyType=osu&ruleset=0");
    expect(site.calls[0]!.headers.get("authorization")).toBe("Bearer secret-key");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.data).toMatchObject({
      otr_id: 777,
      rating: 1480.4,
      global_rank: 1523,
      country_rank: 311,
      tier: "Gold",
      sub_tier: 2,
      tournaments: 12,
      matches: 48,
      peak: 1512,
    });
    // 1480.4 now, 1512 before the first adjustment in the last 30 days.
    expect(result.data.change_30d).toBeCloseTo(-31.6);
  });

  it("treats an unknown or unrated o!TR player as not found and reports API errors", async () => {
    const site = fakeSites(1);
    site.respond = () => new Response("Not found", { status: 404 });
    expect(await fetchOtrRating("k", 1, { fetch: site.fetch, server: servers.otr })).toEqual({ found: false });

    site.respond = () => Response.json({ ...otrStats(1), rating: null });
    expect(await fetchOtrRating("k", 1, { fetch: site.fetch, server: servers.otr })).toEqual({ found: false });

    site.respond = () => Response.json({ error: "Invalid API key" }, { status: 401 });
    await expect(fetchOtrRating("k", 1, { fetch: site.fetch, server: servers.otr })).rejects.toThrow("o!TR answered HTTP 401: Invalid API key");
  });

  it("reads Skill Issue's rating with mods in pool order and skillsets strongest first", async () => {
    const site = fakeSites(4242);
    const result = await fetchSkillIssueRating("kiai-source", 4242, { fetch: site.fetch, server: servers.skillissue });
    expect(site.calls[0]!.url).toBe("https://si.test/ratings/4242");
    expect(site.calls[0]!.headers.get("source")).toBe("kiai-source");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.data.rating).toMatchObject({ value: 2150, sr: 6.12, global_rank: 900, country_rank: 120, accuracy: 0.62 });
    expect(result.data.mods.map((m) => m.name)).toEqual(["NoMod", "Hidden", "Double Time"]);
    expect(result.data.skillsets.map((m) => m.name)).toEqual(["Low AR", "Aim"]);
  });

  it("accepts PascalCase from Skill Issue and explains a refused source key", async () => {
    const site = fakeSites(5);
    site.respond = () => Response.json({ ActiveUsername: "x", Rating: { Name: "rating", Value: 1000, SR: 5, PP: 900, GlobalRank: 1, CountryRank: 1, Accuracy: 0.5, Combo: 0.5 } });
    const result = await fetchSkillIssueRating("s", 5, { fetch: site.fetch, server: servers.skillissue });
    expect(result.found && result.data.rating.value).toBe(1000);

    site.respond = () => Response.json({ activeUsername: "x", countryCode: "US", playerId: 5 });
    expect(await fetchSkillIssueRating("s", 5, { fetch: site.fetch, server: servers.skillissue })).toEqual({ found: false });

    site.respond = () => new Response(null, { status: 403 });
    await expect(fetchSkillIssueRating("s", 5, { fetch: site.fetch, server: servers.skillissue })).rejects.toThrow("refused the SKILLISSUE_SOURCE key");
  });
});

describe("ratings cache and matches page", () => {
  let db: TestDb;
  let player: Player;
  let site: FakeSite;
  let now: number;
  let ratings: RatingsService;
  let app: Hono;

  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "localhost:8080");
    return app.request(`http://localhost:8080${path}`, { ...init, headers });
  };

  const build = (keys: { otr?: string; skillissue?: string }) => {
    ratings = createRatingsService({
      sql: db.sql,
      playerId: player.id,
      otrApiKey: keys.otr,
      skillIssueSource: keys.skillissue,
      fetch: site.fetch,
      servers,
      now: () => now,
    });
    app = createApp({ sql: db.sql, osu: null, player, media: mediaPaths(os.tmpdir()), config: { RECENT_WINDOW_HOURS: 24, PRIVATE_HOSTS: [] }, ratings });
  };

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.sql`truncate osu_users cascade`;
    player = await resolvePlayer(db.sql, fakeOsu(), "tester");
    site = fakeSites(player.id);
    now = NOW;
  });

  it("explains how to set up each site when no key is configured", async () => {
    build({});
    const body = await (await request("/matches")).text();
    expect(body).toContain("Tournament ratings");
    expect(body).toContain("OTR_API_KEY");
    expect(body).toContain("SKILLISSUE_SOURCE");
    expect(body).not.toContain('action="/matches/ratings/refresh"');
    expect(site.calls).toHaveLength(0);
  });

  it("fetches both ratings on the first visit and serves the cache until it's stale", async () => {
    build({ otr: "otr-key", skillissue: "si-source" });
    const body = await (await request("/matches")).text();
    await ratings.idle();
    expect(body).toContain("1,480 TR");
    expect(body).toContain("Gold II");
    expect(body).toContain("#1,523");
    expect(body).toContain("−32");
    expect(body).toContain("2,150 SIP");
    expect(body).toContain("6.12★");
    expect(body).toContain("Double Time");
    expect(body).toContain('href="https://otr.stagec.net/players/777"');
    expect(site.calls).toHaveLength(2);

    await request("/matches");
    now += 5 * 3600_000;
    await request("/matches");
    expect(site.calls).toHaveLength(2);

    now += 2 * 3600_000;
    await request("/matches");
    await ratings.idle();
    expect(site.calls).toHaveLength(4);

    const api = (await (await request("/api/matches/ratings")).json()) as { otr: { data: { rating: number } }; skillissue: { data: { rating: { value: number } } } };
    expect(api.otr.data.rating).toBe(1480.4);
    expect(api.skillissue.data.rating.value).toBe(2150);
  });

  it("keeps the last rating when a site fails, waits before retrying, and refreshes on request", async () => {
    build({ otr: "otr-key" });
    await request("/matches");
    await ratings.idle();

    site.respond = () => new Response("", { status: 502 });
    now += 7 * 3600_000;
    let body = await (await request("/matches")).text();
    await ratings.idle();
    body = await (await request("/matches")).text();
    expect(body).toContain("1,480 TR");
    expect(body).toContain("Couldn&#39;t update o!TR: o!TR answered HTTP 502.");
    expect(site.calls).toHaveLength(2);

    now += 10 * 60_000;
    await request("/matches");
    expect(site.calls).toHaveLength(2);

    site.respond = () => Response.json({ ...otrStats(player.id), rating: { ...otrStats(player.id).rating, rating: 1500 } });
    const refreshed = await request("/matches/ratings/refresh", { method: "POST", headers: { origin: "http://localhost:8080" } });
    expect(refreshed.status).toBe(303);
    expect(refreshed.headers.get("location")).toContain("Ratings%20updated");
    body = await (await request("/matches")).text();
    expect(body).toContain("1,500 TR");
    expect(body).not.toContain("Couldn&#39;t update");
  });

  it("says so when a site has never rated the player", async () => {
    site.respond = () => new Response("Not found", { status: 404 });
    build({ otr: "otr-key", skillissue: "si-source" });
    await request("/matches");
    await ratings.idle();
    const body = await (await request("/matches")).text();
    expect(body).toContain("o!TR has no osu! rating for you yet");
    expect(body).toContain("Skill Issue hasn't rated you yet");
  });
});
