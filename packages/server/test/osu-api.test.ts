import { describe, expect, it } from "vitest";
import { isTransientNetworkError, OsuApi, OsuApiError } from "../src/osu/api.ts";
import { RateLimiter } from "../src/osu/rate-limit.ts";

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function client(handler: Handler) {
  const requests: string[] = [];
  const sleeps: number[] = [];
  const api = new OsuApi({
    clientId: 1,
    clientSecret: "secret",
    limiter: new RateLimiter(0),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetch: (async (input: URL, init: RequestInit) => {
      const url = new URL(String(input));
      requests.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`);
      if (url.pathname === "/oauth/token") return Response.json({ access_token: `token-${requests.length}`, expires_in: 86400 });
      return handler(url, init);
    }) as typeof fetch,
  });
  return { api, requests, sleeps };
}

const connectionReset = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });

describe("OsuApi", () => {
  it("gets a client-credentials token once and sends the API version", async () => {
    const seen: (string | null)[] = [];
    const { api, requests } = client((_url, init) => {
      const headers = new Headers(init.headers);
      seen.push(headers.get("authorization"), headers.get("x-api-version"));
      return Response.json({ id: 5, username: "x" });
    });
    await api.getUser(5);
    await api.getUser("Some Name");
    expect(requests).toEqual(["POST /oauth/token", "GET /api/v2/users/5/osu", "GET /api/v2/users/%40Some%20Name/osu"]);
    expect(seen).toEqual(["Bearer token-1", "20250530", "Bearer token-1", "20250530"]);
  });

  it("encodes id lists the way osu! expects and unwraps envelopes", async () => {
    const { api, requests } = client((url) =>
      url.pathname === "/api/v2/beatmaps" ? Response.json({ beatmaps: [{ id: 1 }, { id: 2 }] }) : Response.json({ scores: [{ id: 9 }] }),
    );
    expect(await api.getBeatmaps([1, 2])).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await api.getBeatmapUserScores(7, 5)).toEqual([{ id: 9 }]);
    expect(requests.slice(1)).toEqual(["GET /api/v2/beatmaps?ids%5B%5D=1&ids%5B%5D=2", "GET /api/v2/beatmaps/7/scores/users/5/all?ruleset=osu&legacy_only=0"]);
  });

  it("returns null or empty for 404s where that means 'gone'", async () => {
    const { api } = client(() => new Response("not found", { status: 404 }));
    expect(await api.getScore(1)).toBeNull();
    expect(await api.getUser(1)).toBeNull();
    expect(await api.getBeatmapUserScores(1, 1)).toEqual([]);
    expect(await api.getBeatmapFile(1)).toBeNull();
    await expect(api.getRecentScores(1, 100, 0)).rejects.toMatchObject({ status: 404 });
  });

  it("retries rate limits and server errors with backoff, honouring Retry-After", async () => {
    let calls = 0;
    const { api, sleeps } = client(() => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 429, headers: { "retry-after": "7" } });
      if (calls === 2) return new Response(null, { status: 502 });
      return Response.json([{ id: 1 }]);
    });
    expect(await api.getRecentScores(1, 100, 0)).toEqual([{ id: 1 }]);
    expect(sleeps).toEqual([7000, 4000]);
  });

  it("retries dropped connections but gives up after five retries", async () => {
    let calls = 0;
    const { api } = client(() => {
      calls += 1;
      if (calls <= 2) throw connectionReset();
      return Response.json({ id: 3, user_id: 1 });
    });
    expect(await api.getScore(3)).toEqual({ id: 3, user_id: 1 });

    const down = client(() => {
      throw connectionReset();
    });
    await expect(down.api.getScore(3)).rejects.toBeInstanceOf(OsuApiError);
    expect(down.requests.filter((r) => r.includes("/scores/3"))).toHaveLength(6);
  });

  it("refreshes the token once on 401", async () => {
    let calls = 0;
    const { api, requests } = client(() => (++calls === 1 ? new Response(null, { status: 401 }) : Response.json([])));
    expect(await api.getMostPlayed(1, 100, 0)).toEqual([]);
    expect(requests.filter((r) => r.startsWith("POST"))).toHaveLength(2);
  });

  it("does not retry other client errors", async () => {
    const { api, requests } = client(() => new Response(null, { status: 403 }));
    await expect(api.getMostPlayed(1, 100, 0)).rejects.toMatchObject({ status: 403 });
    expect(requests).toHaveLength(2);
  });

  it("rejects downloads that aren't beatmaps", async () => {
    const { api } = client(() => new Response("<html>maintenance</html>"));
    await expect(api.getBeatmapFile(1)).rejects.toThrow(/not a beatmap file/);
  });

  it("classifies transient network errors through cause chains", () => {
    expect(isTransientNetworkError(connectionReset())).toBe(true);
    expect(isTransientNetworkError(Object.assign(new Error("timed out"), { name: "TimeoutError" }))).toBe(true);
    expect(isTransientNetworkError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
    expect(isTransientNetworkError(new Error("boom"))).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("spaces calls apart", async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(1100, () => now, async (ms) => {
      waits.push(ms);
    });
    await limiter.wait();
    await limiter.wait();
    await limiter.wait();
    now = 5000;
    await limiter.wait();
    expect(waits).toEqual([1100, 2200]);
  });
});
