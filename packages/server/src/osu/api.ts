import { RateLimiter, sleep as defaultSleep, type Sleep } from "./rate-limit.ts";
import type { ApiBeatmap, ApiMatch, ApiMatchList, ApiMostPlayed, ApiRoom, ApiRoomEvents, ApiScore, ApiUser } from "./types.ts";

const SERVER = "https://osu.ppy.sh";
const API_VERSION = "20250530";
const USER_AGENT = "kiai/0.1 (+https://github.com/dblopez04/kiai)";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 5;

export class OsuApiError extends Error {
  override name = "OsuApiError";
  /** HTTP status, or undefined when the request never got a response. */
  readonly status: number | undefined;

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

/** Everything the score library needs from osu!. Tests substitute a fake. */
export interface OsuClient {
  /** By id, or by username. Null if there is no such user. */
  getUser(user: number | string): Promise<ApiUser | null>;
  /** The profile's "most played" list: every beatmap the user has played, most plays first. */
  getMostPlayed(userId: number, limit: number, offset: number): Promise<ApiMostPlayed[]>;
  /** Full beatmap details for up to 50 ids. */
  getBeatmaps(ids: number[]): Promise<ApiBeatmap[]>;
  /** Recent passed osu!standard plays, stable and lazer, newest first. */
  getRecentScores(userId: number, limit: number, offset: number): Promise<ApiScore[]>;
  /** Every score the user has on a beatmap. Empty if the beatmap is gone. */
  getBeatmapUserScores(beatmapId: number, userId: number): Promise<ApiScore[]>;
  /** Null if the score no longer exists (overwritten or deleted). */
  getScore(scoreId: number): Promise<ApiScore | null>;
  /** The .osu file. Null if osu! doesn't have it. */
  getBeatmapFile(beatmapId: number): Promise<string | null>;
  /**
   * Up to 101 events of a stable match: the newest ones, or those after event `after`, oldest
   * first. Null if there is no such match; private matches throw with status 403.
   */
  getMatch(matchId: number, after?: number): Promise<ApiMatch | null>;
  /** osu!'s list of public stable lobbies (all of them, not only tournaments), by id. */
  listMatches(options: { sort: "id_asc" | "id_desc"; limit: number; cursorString?: string }): Promise<ApiMatchList>;
  /** Up to 101 events of a lazer realtime room (ranked play), like {@link getMatch}. */
  getRoomEvents(roomId: number, after?: number): Promise<ApiRoomEvents | null>;
  /** Ended ranked play rooms, most recently ended first. */
  listRankedPlayRooms(options: { limit: number; cursorString?: string }): Promise<ApiRoom[]>;
}

export interface OsuApiOptions {
  clientId: number;
  clientSecret: string;
  limiter?: RateLimiter;
  fetch?: typeof fetch;
  sleep?: Sleep;
  server?: string;
  timeoutMs?: number;
}

type Query = Record<string, string | number | readonly (string | number)[] | undefined>;

/**
 * Connection failures worth retrying: resets, DNS hiccups, timeouts. Walks `cause` chains
 * because fetch wraps the socket error in `TypeError: fetch failed`.
 */
export function isTransientNetworkError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const value = current as { name?: string; message?: string; code?: string; cause?: unknown };
    if (value.name === "TimeoutError") return true;
    if (value.name === "AbortError") return false;
    if (
      ["ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(
        value.code ?? "",
      ) ||
      /fetch failed|network error|socket hang up/i.test(value.message ?? "")
    ) {
      return true;
    }
    current = value.cause;
  }
  return false;
}

function backoffMs(attempt: number, response?: Response): number {
  const retryAfter = Number(response?.headers.get("retry-after"));
  const base = Math.min(2000 * 2 ** attempt, 60_000);
  return Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(retryAfter * 1000, base) : base;
}

/** osu! API v2 with a client-credentials token: only public data, so no user sign-in is needed. */
export class OsuApi implements OsuClient {
  #clientId: number;
  #clientSecret: string;
  #limiter: RateLimiter;
  #fetch: typeof fetch;
  #sleep: Sleep;
  #server: string;
  #timeoutMs: number;
  #token: { value: string; expiresAt: number } | null = null;
  #tokenRequest: Promise<string> | null = null;

  constructor(options: OsuApiOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#limiter = options.limiter ?? new RateLimiter();
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#server = options.server ?? SERVER;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  async getUser(user: number | string): Promise<ApiUser | null> {
    const key = typeof user === "number" ? String(user) : `@${user}`;
    return this.#getJson<ApiUser>(`/api/v2/users/${encodeURIComponent(key)}/osu`, {}, { nullOn404: true });
  }

  async getMostPlayed(userId: number, limit: number, offset: number): Promise<ApiMostPlayed[]> {
    return (await this.#getJson<ApiMostPlayed[]>(`/api/v2/users/${userId}/beatmapsets/most_played`, { limit, offset })) ?? [];
  }

  async getBeatmaps(ids: number[]): Promise<ApiBeatmap[]> {
    if (ids.length === 0) return [];
    const body = await this.#getJson<{ beatmaps: ApiBeatmap[] }>("/api/v2/beatmaps", { ids });
    return body?.beatmaps ?? [];
  }

  async getRecentScores(userId: number, limit: number, offset: number): Promise<ApiScore[]> {
    const query = { mode: "osu", legacy_only: 0, include_fails: 0, limit, offset };
    return (await this.#getJson<ApiScore[]>(`/api/v2/users/${userId}/scores/recent`, query)) ?? [];
  }

  async getBeatmapUserScores(beatmapId: number, userId: number): Promise<ApiScore[]> {
    const body = await this.#getJson<{ scores: ApiScore[] }>(
      `/api/v2/beatmaps/${beatmapId}/scores/users/${userId}/all`,
      { ruleset: "osu", legacy_only: 0 },
      { nullOn404: true },
    );
    return body?.scores ?? [];
  }

  async getScore(scoreId: number): Promise<ApiScore | null> {
    return this.#getJson<ApiScore>(`/api/v2/scores/${scoreId}`, {}, { nullOn404: true });
  }

  async getBeatmapFile(beatmapId: number): Promise<string | null> {
    const response = await this.#request(this.#url(`/osu/${beatmapId}`), { auth: false, nullOn404: true });
    if (!response) return null;
    const text = (await response.text()).trimStart();
    if (!text.startsWith("osu file format")) {
      throw new OsuApiError(`Beatmap ${beatmapId} download was not a beatmap file.`, response.status);
    }
    return text;
  }

  async getMatch(matchId: number, after?: number): Promise<ApiMatch | null> {
    return this.#getJson<ApiMatch>(`/api/v2/matches/${matchId}`, { after, limit: 101 }, { nullOn404: true });
  }

  async listMatches(options: { sort: "id_asc" | "id_desc"; limit: number; cursorString?: string }): Promise<ApiMatchList> {
    const query = { sort: options.sort, limit: options.limit, cursor_string: options.cursorString };
    return (await this.#getJson<ApiMatchList>("/api/v2/matches", query)) ?? { matches: [] };
  }

  async getRoomEvents(roomId: number, after?: number): Promise<ApiRoomEvents | null> {
    return this.#getJson<ApiRoomEvents>(`/api/v2/rooms/${roomId}/events`, { after, limit: 101 }, { nullOn404: true });
  }

  async listRankedPlayRooms(options: { limit: number; cursorString?: string }): Promise<ApiRoom[]> {
    const query = { type_group: "ranked-play", mode: "ended", sort: "ended", limit: options.limit, cursor_string: options.cursorString };
    // Older API versions return a bare array; newer ones wrap it with a cursor.
    const body = await this.#getJson<ApiRoom[] | { rooms?: ApiRoom[] }>("/api/v2/rooms", query);
    return Array.isArray(body) ? body : (body?.rooms ?? []);
  }

  #url(path: string, query: Query = {}): URL {
    const url = new URL(path, this.#server);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(`${key}[]`, String(item));
      else url.searchParams.set(key, String(value));
    }
    return url;
  }

  async #getJson<T>(path: string, query: Query, options: { nullOn404?: boolean } = {}): Promise<T | null> {
    const response = await this.#request(this.#url(path, query), { auth: true, nullOn404: options.nullOn404 ?? false });
    return response ? ((await response.json()) as T) : null;
  }

  /** Rate-limited GET with retries for connection failures, timeouts, 429 and 5xx. */
  async #request(url: URL, options: { auth: boolean; nullOn404: boolean }): Promise<Response | null> {
    let refreshedToken = false;
    for (let attempt = 0; ; attempt++) {
      await this.#limiter.wait();
      let response: Response;
      try {
        const headers: Record<string, string> = { Accept: "application/json", "x-api-version": API_VERSION, "User-Agent": USER_AGENT };
        if (options.auth) headers.Authorization = `Bearer ${await this.#accessToken()}`;
        response = await this.#fetch(url, { headers, signal: AbortSignal.timeout(this.#timeoutMs) });
      } catch (error) {
        if (error instanceof OsuApiError) throw error;
        if (attempt < MAX_RETRIES && isTransientNetworkError(error)) {
          await this.#sleep(backoffMs(attempt));
          continue;
        }
        throw new OsuApiError(`osu! request to ${url.pathname} failed: ${(error as Error).message}`, undefined, { cause: error });
      }

      if (response.ok) return response;
      await response.body?.cancel();
      if (response.status === 404 && options.nullOn404) return null;
      if (response.status === 401 && options.auth && !refreshedToken) {
        this.#token = null;
        refreshedToken = true;
        continue;
      }
      if (RETRY_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
        await this.#sleep(backoffMs(attempt, response));
        continue;
      }
      throw new OsuApiError(`osu! ${url.pathname} returned HTTP ${response.status}.`, response.status);
    }
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token.value;
    this.#tokenRequest ??= this.#fetchToken().finally(() => {
      this.#tokenRequest = null;
    });
    return this.#tokenRequest;
  }

  async #fetchToken(): Promise<string> {
    const response = await this.#fetch(new URL("/oauth/token", this.#server), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        grant_type: "client_credentials",
        scope: "public",
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (response.status === 400 || response.status === 401) {
      throw new OsuApiError("osu! rejected OSU_CLIENT_ID / OSU_CLIENT_SECRET. Check the OAuth application's credentials.", response.status);
    }
    if (!response.ok) throw new OsuApiError(`osu! token request returned HTTP ${response.status}.`, response.status);
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new OsuApiError("osu! token response had no access_token.", response.status);
    this.#token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}
