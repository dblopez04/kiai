import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClip, formatTimestamp, getClip, parseClipRange, parseTimestamp } from "../src/clips/store.ts";
import { ffmpegClipper, runNextClip, type Clipper } from "../src/clips/worker.ts";
import { CLIP_COMMAND, handleInteraction, replayChoice, runDiscordBot, type BotDeps } from "../src/discord/bot.ts";
import { runGateway } from "../src/discord/gateway.ts";
import { UserError } from "../src/errors.ts";
import { createPublicApp } from "../src/http/public.ts";
import { ensureMediaDirs, mediaPaths, type MediaPaths } from "../src/media.ts";
import type { Renderer } from "../src/render/danser.ts";
import { installOsz } from "../src/render/maps.ts";
import { discordNotifier } from "../src/render/notify.ts";
import { enqueueRender } from "../src/render/queue.ts";
import { runNextRender } from "../src/render/worker.ts";
import { getReplay, saveReplay, searchReplays } from "../src/replays/store.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { fakeOsu, osuFile, trackUser, USER_ID } from "./helpers/fake-osu.ts";
import { buildOsr, buildZip, md5Of } from "./helpers/replay-files.ts";

const OWNER = "123456789012345678";
const PUBLIC_URL = "https://replays.example.com";

let db: TestDb;
let dir: string;
let media: MediaPaths;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  await db.sql`truncate osu_users, beatmaps, scores, replays, render_jobs, beatmap_files, clip_jobs cascade`;
  await trackUser(db.sql);
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kiai-clips-"));
  media = mediaPaths(dir);
  await ensureMediaDirs(media);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const MAP = osuFile().replace("[Difficulty]", "[Metadata]\nTitle:Clip Song\nArtist:kiai\nCreator:mapper\nVersion:Insane\nBeatmapID:0\nBeatmapSetID:-1\n\n[Difficulty]");
const MAP_MD5 = md5Of(MAP);

let renderFails = false;
const fakeRenderer: Renderer = {
  async render(input) {
    if (renderFails) throw new Error("danser exited with code 2.");
    const out = path.join(media.videos, `${input.outputName}.mp4`);
    await fs.writeFile(out, Buffer.alloc(4096, 1));
    return out;
  },
};

/** Writes a small file in place of the clip, and remembers what it was asked to cut. */
function fakeClipper(cuts: { source: string; startMs: number; endMs: number }[] = []): Clipper {
  return {
    async cut(input) {
      cuts.push({ source: input.source, startMs: input.startMs, endMs: input.endMs });
      await fs.writeFile(input.output, Buffer.alloc(2048, 2));
      return { endMs: input.endMs };
    },
  };
}

type Request = { method: string; url: string; body: unknown };
function discordFetch(sent: Request[], status: (url: string) => number = () => 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const code = status(url);
    if (code !== 200) return new Response("gone", { status: code });
    if (url.endsWith("/users/@me/channels")) return Response.json({ id: "555" });
    return Response.json({ id: "1" });
  }) as typeof fetch;
}

/** An uploaded replay of MAP (HDDT) with its map installed. Rendered when `render` is set. */
async function replay(options: { render?: boolean; player?: string } = {}): Promise<string> {
  const zip = path.join(dir, "set.osz");
  await fs.writeFile(zip, buildZip({ "map.osu": MAP, "audio.mp3": "x" }));
  await installOsz(db.sql, media, zip, "upload-test", "upload");
  const { id } = await saveReplay(
    db.sql,
    media,
    buildOsr({ beatmapMd5: MAP_MD5, modBits: 8 | 64, counts: [40, 0, 0, 0, 0, 0], maxCombo: 40, ...(options.player ? { playerName: options.player } : {}) }),
    null,
  );
  if (options.render) {
    await enqueueRender(db.sql, id, "default");
    await render();
  }
  return id;
}

const render = () =>
  runNextRender({ sql: db.sql, osu: fakeOsu(), paths: media, renderer: fakeRenderer, mirrors: [], playerId: USER_ID, log: () => {} });

const botDeps = (sent: Request[] = []): BotDeps => ({ sql: db.sql, botToken: "bot", ownerId: OWNER, publicUrl: PUBLIC_URL, fetch: discordFetch(sent), log: () => {} });

function command(options: Record<string, string>, userId = OWNER, type = 2) {
  return {
    id: "900",
    application_id: "app1",
    token: "tok1",
    type,
    data: { name: "clip", options: Object.entries(options).map(([name, value]) => ({ name, value, ...(type === 4 && name === "query" ? { focused: true } : {}) })) },
    member: { user: { id: userId } },
  };
}

/** The text of a Components V2 message's container, and its video if it has one. */
function card(message: unknown): { text: string; video: string | undefined } {
  const m = message as { flags?: number; components: { components: { type: number; content?: string; items?: { media: { url: string } }[] }[] }[] };
  const parts = m.components[0]!.components;
  return { text: parts.find((c) => c.type === 10)!.content!, video: parts.find((c) => c.type === 12)?.items?.[0]?.media.url };
}

describe("clip timestamps", () => {
  it("reads seconds, m:ss and h:mm:ss", () => {
    expect(parseTimestamp("83")).toBe(83_000);
    expect(parseTimestamp("1:23")).toBe(83_000);
    expect(parseTimestamp(" 1:23.5 ")).toBe(83_500);
    expect(parseTimestamp("1:02:03")).toBe(3_723_000);
    expect(parseTimestamp("0:07.25")).toBe(7_250);
    for (const bad of ["", "1:75", "1:60:00", "abc", "-5", "1::2", "1:2:3:4"]) expect(parseTimestamp(bad), bad).toBeNull();
    expect(formatTimestamp(83_000)).toBe("1:23");
    expect(formatTimestamp(83_500)).toBe("1:23.5");
    expect(formatTimestamp(7_000)).toBe("0:07");
    expect(formatTimestamp(3_723_000)).toBe("1:02:03");
  });

  it("checks the range", () => {
    expect(parseClipRange("1:00", "1:30")).toEqual({ startMs: 60_000, endMs: 90_000 });
    expect(() => parseClipRange("1:30", "1:00")).toThrow("after the start");
    expect(() => parseClipRange("0:00", "6:00")).toThrow("up to 5:00");
    expect(() => parseClipRange("soon", "1:00")).toThrow(UserError);
  });
});

describe("replay search", () => {
  it("matches every word against the map, player and mods", async () => {
    const id = await replay({ player: "cookiezi" });
    expect((await searchReplays(db.sql, "clip song insane")).map((r) => r.id)).toEqual([id]);
    expect((await searchReplays(db.sql, "COOKIEZI hddt")).map((r) => r.id)).toEqual([id]);
    expect((await searchReplays(db.sql, "dt")).map((r) => r.id)).toEqual([id]);
    expect(await searchReplays(db.sql, "clip song hr")).toEqual([]);
    expect((await searchReplays(db.sql, "")).map((r) => r.id)).toEqual([id]);
  });

  it("names autocomplete choices within Discord's 100 characters", async () => {
    const r = (await getReplay(db.sql, await replay({ player: "tester" })))!;
    expect(replayChoice(r)).toEqual({ name: expect.stringMatching(/^kiai - Clip Song \[Insane\] · 100\.00% HDDT · tester · \d{4}-\d\d-\d\d$/), value: r.id });
    const long = { ...r, beatmap: { ...r.beatmap!, title: "x".repeat(200) } };
    expect(replayChoice(long).name).toHaveLength(100);
    expect(replayChoice(long).name).toContain("… · 100.00% HDDT");
  });
});

describe("/clip", () => {
  it("offers the owner's replays as autocomplete choices, and nobody else's", async () => {
    const id = await replay();
    expect(await handleInteraction(botDeps(), command({ query: "clip" }, OWNER, 4))).toEqual({
      type: 8,
      data: { choices: [expect.objectContaining({ value: id })] },
    });
    expect(await handleInteraction(botDeps(), command({ query: "clip" }, "999", 4))).toEqual({ type: 8, data: { choices: [] } });
  });

  it("answers mistakes privately, without queuing anything", async () => {
    await replay({ render: true });
    const reply = async (options: Record<string, string>, userId = OWNER) =>
      (await handleInteraction(botDeps(), command(options, userId))) as { type: number; data: { content: string; flags: number } };
    const stranger = await reply({ query: "clip", start: "0:01", end: "0:02" }, "999");
    expect(stranger.data.flags).toBe(64);
    expect(stranger.data.content).toContain("Only the bot's owner");
    expect((await reply({ query: "clip", start: "0:05", end: "0:02" })).data.content).toContain("after the start");
    expect((await reply({ query: "no such map", start: "0:01", end: "0:02" })).data.content).toContain('No replay matches "no such map"');
    const noPublicUrl = (await handleInteraction({ ...botDeps(), publicUrl: undefined }, command({ query: "clip", start: "1", end: "2" }))) as { data: { content: string } };
    expect(noPublicUrl.data.content).toContain("PUBLIC_URL");
    expect(await db.sql`select id from clip_jobs`).toEqual([]);
    expect(await handleInteraction(botDeps(), { ...command({}), data: { name: "other" } })).toBeNull();
  });

  it("clips a rendered replay and edits the reply into the clip", async () => {
    const id = await replay({ render: true });
    const reply = (await handleInteraction(botDeps(), command({ query: id, start: "0:01", end: "0:03.5" }))) as { type: number; data: unknown };
    expect(reply.type).toBe(4);
    expect((reply.data as { flags: number }).flags).toBe(1 << 15);
    expect(card(reply.data).text).toContain("-# ✂️ 0:01–0:03.5 · clipping…");
    expect(card(reply.data).video).toBeUndefined();
    const [clip] = await db.sql<{ id: string; discord: unknown }[]>`select id, discord from clip_jobs`;
    expect(clip!.discord).toEqual({ application_id: "app1", token: "tok1", user_id: OWNER });

    const sent: Request[] = [];
    const cuts: { source: string; startMs: number; endMs: number }[] = [];
    const notifier = discordNotifier({ botToken: "bot", userId: OWNER, publicUrl: PUBLIC_URL, fetch: discordFetch(sent) });
    expect(await runNextClip({ sql: db.sql, paths: media, clipper: fakeClipper(cuts), notifier, log: () => {} })).toBe(true);
    const [job] = await db.sql<{ video_path: string }[]>`select video_path from render_jobs where replay_id = ${id} and status = 'success'`;
    expect(cuts).toEqual([{ source: path.join(media.root, job!.video_path), startMs: 1000, endMs: 3500 }]);
    expect((await getClip(db.sql, clip!.id))).toMatchObject({ status: "success", video_path: `videos/clip-${clip!.id}.mp4`, video_bytes: 2048 });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("PATCH");
    expect(sent[0]!.url).toBe("https://discord.com/api/v10/webhooks/app1/tok1/messages/@original");
    const edited = card(sent[0]!.body);
    expect(edited.text.split("\n")[0]).toBe(`**[kiai - Clip Song \\[Insane\\]](${PUBLIC_URL}/r/${id})**`);
    expect(edited.text).toMatch(/-# ✂️ 0:01–0:03\.5 · [\d.]+★ · AR/);
    expect(edited.video).toBe(`${PUBLIC_URL}/c/${clip!.id}/video.mp4`);

    // Nothing left to cut.
    expect(await runNextClip({ sql: db.sql, paths: media, clipper: fakeClipper(), notifier, log: () => {} })).toBe(false);
  });

  it("renders an unrendered replay first, then clips it", async () => {
    const id = await replay();
    const reply = (await handleInteraction(botDeps(), command({ query: "clip song", start: "2", end: "4" }))) as { data: unknown };
    expect(card(reply.data).text).toContain("rendering the replay first, then clipping…");
    expect(await db.sql`select status from render_jobs where replay_id = ${id}`).toEqual([{ status: "queued" }]);

    const deps = { sql: db.sql, paths: media, clipper: fakeClipper(), notifier: null, log: () => {} };
    expect(await runNextClip(deps)).toBe(false);
    await render();
    expect(await runNextClip(deps)).toBe(true);
    expect(await db.sql`select status from clip_jobs`).toEqual([{ status: "success" }]);
  });

  it("fails the clip when its render fails, and says so", async () => {
    await replay();
    await handleInteraction(botDeps(), command({ query: "clip", start: "2", end: "4" }));
    renderFails = true;
    try {
      await render();
    } finally {
      renderFails = false;
    }
    const sent: Request[] = [];
    const notifier = discordNotifier({ botToken: "bot", userId: OWNER, publicUrl: PUBLIC_URL, fetch: discordFetch(sent) });
    expect(await runNextClip({ sql: db.sql, paths: media, clipper: fakeClipper(), notifier, log: () => {} })).toBe(false);
    const [clip] = await db.sql<{ status: string; error_text: string }[]>`select status, error_text from clip_jobs`;
    expect(clip).toEqual({ status: "failed", error_text: expect.stringContaining("The replay failed to render: danser exited with code 2.") });
    expect(card(sent[0]!.body).text).toContain("no clip: The replay failed to render");
  });

  it("sends the clip as a new message once the reply can't be edited", async () => {
    const id = await replay({ render: true });
    const { clip } = await createClip(db.sql, { replayId: id, startMs: 0, endMs: 1000, discord: { application_id: "app1", token: "gone", user_id: OWNER } });
    const sent: Request[] = [];
    const notifier = discordNotifier({ botToken: "bot", userId: OWNER, publicUrl: PUBLIC_URL, fetch: discordFetch(sent, (url) => (url.includes("/webhooks/") ? 404 : 200)) });
    await runNextClip({ sql: db.sql, paths: media, clipper: fakeClipper(), notifier, log: () => {} });
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      "PATCH https://discord.com/api/v10/webhooks/app1/gone/messages/@original",
      "POST https://discord.com/api/v10/users/@me/channels",
      "POST https://discord.com/api/v10/channels/555/messages",
    ]);
    expect(card(sent[2]!.body).video).toBe(`${PUBLIC_URL}/c/${clip.id}/video.mp4`);

    // Past the token's 15 minutes, it doesn't even try the edit.
    const { clip: old } = await createClip(db.sql, { replayId: id, startMs: 0, endMs: 1000, discord: { application_id: "app1", token: "old", user_id: OWNER } });
    await db.sql`update clip_jobs set created_at = now() - interval '20 minutes' where id = ${old.id}`;
    sent.length = 0;
    await runNextClip({ sql: db.sql, paths: media, clipper: fakeClipper(), notifier, log: () => {} });
    expect(sent.map((s) => s.url)).toEqual(["https://discord.com/api/v10/channels/555/messages"]);
  });

  it("fails a clip the cutter refuses, and one whose worker died", async () => {
    const id = await replay({ render: true });
    await createClip(db.sql, { replayId: id, startMs: 600_000, endMs: 601_000, discord: null });
    const refusing: Clipper = { cut: async () => Promise.reject(new UserError("The video is only 0:40 long, so 10:00 is past its end.")) };
    await runNextClip({ sql: db.sql, paths: media, clipper: refusing, log: () => {} });
    expect(await db.sql`select status, error_text from clip_jobs`).toEqual([{ status: "failed", error_text: "The video is only 0:40 long, so 10:00 is past its end." }]);

    await db.sql`truncate clip_jobs`;
    const { clip } = await createClip(db.sql, { replayId: id, startMs: 0, endMs: 1000, discord: null });
    await db.sql`update clip_jobs set status = 'running', started_at = now() - interval '1 hour' where id = ${clip.id}`;
    expect(await runNextClip({ sql: db.sql, paths: media, clipper: fakeClipper(), log: () => {} })).toBe(false);
    expect(await getClip(db.sql, clip.id)).toMatchObject({ status: "failed", error_text: "The render worker stopped while cutting this clip." });
  });

  it("serves finished clips on the public site, and nothing else", async () => {
    const id = await replay({ render: true });
    const { clip } = await createClip(db.sql, { replayId: id, startMs: 0, endMs: 1000, discord: null });
    const app = createPublicApp({ sql: db.sql, media, publicUrl: PUBLIC_URL });
    expect((await app.request(`/c/${clip.id}/video.mp4`)).status).toBe(404);
    await runNextClip({ sql: db.sql, paths: media, clipper: fakeClipper(), log: () => {} });
    const video = await app.request(`/c/${clip.id}/video.mp4`, { headers: { range: "bytes=0-9" } });
    expect(video.status).toBe(206);
    expect(video.headers.get("content-range")).toBe("bytes 0-9/2048");
    expect((await app.request("/c/nonexistent/video.mp4")).status).toBe(404);
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("ffmpeg clipper", () => {
  const run = promisify(execFile);
  const duration = async (file: string) =>
    Number((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file])).stdout);

  it("cuts on the exact time, stops at the video's end, and refuses a start past it", async () => {
    const source = path.join(dir, "source.mp4");
    await run("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=160x120:rate=30", "-f", "lavfi", "-i", "sine=duration=3",
      "-c:v", "libx264", "-g", "300", "-c:a", "aac", "-shortest", source,
    ]);
    const clipper = ffmpegClipper({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
    const signal = new AbortController().signal;

    const out = path.join(dir, "clip.mp4");
    expect(await clipper.cut({ source, output: out, startMs: 1000, endMs: 2000 }, signal)).toEqual({ endMs: 2000 });
    expect(await duration(out)).toBeCloseTo(1, 1);
    // The audio is copied, not re-encoded: danser's ffmpeg can't decode it.
    const audio = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", out]);
    expect(audio.stdout.trim()).toBe("aac");

    const tail = path.join(dir, "tail.mp4");
    expect((await clipper.cut({ source, output: tail, startMs: 2000, endMs: 60_000 }, signal)).endMs).toBeGreaterThanOrEqual(2900);
    expect(await duration(tail)).toBeLessThan(1.2);

    await expect(clipper.cut({ source, output: path.join(dir, "none.mp4"), startMs: 10_000, endMs: 11_000 }, signal)).rejects.toThrow("past its end");
  });
});

/** Stands in for a WebSocket: records what's sent, and lets the test play Discord. */
class FakeSocket extends EventTarget {
  static all: FakeSocket[] = [];
  url: string;
  sent: { op: number; d: unknown }[] = [];
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as { op: number; d: unknown });
  }
  close(code = 1000, reason = "") {
    queueMicrotask(() => this.dispatchEvent(Object.assign(new Event("close"), { code, reason })));
  }
  receive(payload: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const READY = { session_id: "sess", resume_gateway_url: "wss://resume.example", application: { id: "app1" }, user: { username: "kiai" } };

describe("Discord gateway", () => {
  beforeEach(() => {
    FakeSocket.all = [];
  });

  it("identifies, heartbeats, dispatches, resumes after a reconnect, and gives up on a bad token", async () => {
    const events: string[] = [];
    const done = runGateway({
      token: "bot",
      onDispatch: (event) => void events.push(event),
      log: () => {},
      signal: new AbortController().signal,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      backoffMs: 1,
    });
    const caught = done.catch((error: Error) => error);
    await waitFor(() => FakeSocket.all.length === 1, "the first connection");
    const first = FakeSocket.all[0]!;
    expect(first.url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    first.receive({ op: 10, d: { heartbeat_interval: 20 } });
    expect(first.sent[0]).toEqual({ op: 2, d: expect.objectContaining({ token: "bot", intents: 0 }) });
    first.receive({ op: 0, t: "READY", s: 1, d: READY });
    first.receive({ op: 0, t: "INTERACTION_CREATE", s: 2, d: {} });
    await waitFor(() => events.length === 2, "the dispatches");
    expect(events).toEqual(["READY", "INTERACTION_CREATE"]);
    await waitFor(() => first.sent.some((p) => p.op === 1), "a heartbeat");
    expect(first.sent.find((p) => p.op === 1)!.d).toBe(2);

    first.receive({ op: 7, d: null });
    await waitFor(() => FakeSocket.all.length === 2, "the reconnect");
    const second = FakeSocket.all[1]!;
    expect(second.url).toBe("wss://resume.example/?v=10&encoding=json");
    second.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
    expect(second.sent[0]).toEqual({ op: 6, d: { token: "bot", session_id: "sess", seq: 2 } });

    second.close(4004, "Authentication failed.");
    expect(String(await caught)).toContain("Check DISCORD_BOT_TOKEN");
  });

  it("reconnects when heartbeats go unanswered", async () => {
    const stop = new AbortController();
    const done = runGateway({ token: "bot", onDispatch: () => {}, log: () => {}, signal: stop.signal, WebSocket: FakeSocket as unknown as typeof WebSocket, backoffMs: 1 });
    await waitFor(() => FakeSocket.all.length === 1, "the first connection");
    FakeSocket.all[0]!.receive({ op: 10, d: { heartbeat_interval: 10 } });
    await waitFor(() => FakeSocket.all.length === 2, "the reconnect");
    stop.abort();
    FakeSocket.all[1]!.close(1000);
    await done;
  });
});

describe("Discord bot", () => {
  beforeEach(() => {
    FakeSocket.all = [];
  });

  it("registers /clip when it connects and answers interactions", async () => {
    await replay();
    const sent: Request[] = [];
    const stop = new AbortController();
    const done = runDiscordBot({ ...botDeps(sent), signal: stop.signal, WebSocket: FakeSocket as unknown as typeof WebSocket });
    await waitFor(() => FakeSocket.all.length === 1, "the connection");
    const socket = FakeSocket.all[0]!;
    socket.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
    socket.receive({ op: 0, t: "READY", s: 1, d: READY });
    await waitFor(() => sent.length === 1, "the command registration");
    expect(sent[0]).toEqual({ method: "PUT", url: "https://discord.com/api/v10/applications/app1/commands", body: [CLIP_COMMAND] });

    socket.receive({ op: 0, t: "INTERACTION_CREATE", s: 2, d: command({ query: "clip" }, OWNER, 4) });
    await waitFor(() => sent.length === 2, "the autocomplete answer");
    expect(sent[1]!.url).toBe("https://discord.com/api/v10/interactions/900/tok1/callback");
    expect(sent[1]!.body).toEqual({ type: 8, data: { choices: [expect.objectContaining({ name: expect.stringContaining("Clip Song") })] } });

    stop.abort();
    await done;
  });
});
