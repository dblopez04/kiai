import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/http/app.ts";
import { ensureMediaDirs, mediaPaths, type MediaPaths } from "../src/media.ts";
import { resolvePlayer, type Player } from "../src/player.ts";
import { danserCommand, danserRenderer, type Renderer } from "../src/render/danser.ts";
import { EMBED_MAX_BYTES, type Embedder } from "../src/render/embed.ts";
import { ensureBeatmap, installOsz, parseOsuMetadata } from "../src/render/maps.ts";
import { claimRender, enqueueRender, MAX_RENDER_ATTEMPTS } from "../src/render/queue.ts";
import { refreshLazerReplayMods, runNextRender, type RenderDeps } from "../src/render/worker.ts";
import { legacyMods, parseReplay, replayRank } from "../src/replays/osr.ts";
import { deleteRenderVideos, deleteReplays, listReplayPage, pruneSupersededRenders, replayStorage } from "../src/replays/manage.ts";
import { getReplay, linkReplays, normalizeDevserver, replayFile, saveReplay } from "../src/replays/store.ts";
import { runImport } from "../src/scores/importer.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { beatmap, fakeOsu, score, USER_ID, type FakeOsu } from "./helpers/fake-osu.ts";
import { buildOsr, buildZip, md5Of, osuText } from "./helpers/replay-files.ts";

const TOKEN = "test-upload-token-0123456789";
const PRESET = { name: "default", description: "", skin: "default", patch: { Recording: { FPS: 60 } }, skipIntro: false };
const ORIGIN = "http://localhost:8080";

let db: TestDb;
let osu: FakeOsu;
let dir: string;
let media: MediaPaths;
let player: Player;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  await db.sql`truncate osu_users, beatmaps, scores, user_played_maps, sync_runs, score_archives, replays, render_jobs, beatmap_files cascade`;
  osu = fakeOsu();
  player = await resolvePlayer(db.sql, osu, "tester");
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kiai-render-"));
  media = mediaPaths(dir);
  await ensureMediaDirs(media);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// A beatmap set as osu! and the mirrors know it: set 700, beatmap 70 (Insane) plus a second diff.
const SET_ID = 700;
const MAP_ID = 70;
const insane = osuText(MAP_ID, SET_ID, "Insane");
const hard = osuText(71, SET_ID, "Hard");
const MAP_MD5 = md5Of(insane);
const setZip = (osu = insane) => buildZip({ "Artist - Song (mapper) [Insane].osu": osu, "Artist - Song (mapper) [Hard].osu": hard, "audio.mp3": "not really audio", "sb/bg.jpg": "jpeg" });

function knowMap() {
  osu.checksums.set(MAP_MD5, beatmap(MAP_ID, { beatmapset_id: SET_ID, checksum: MAP_MD5, beatmapset: { id: SET_ID, artist: "Artist", title: "Song", creator: "mapper", status: "ranked" } }));
}

/** A fetch that serves `zip` for set downloads from mirror "b" and 404s on mirror "a". */
function mirrorFetch(zip: Buffer | null, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://a.example/") || !zip) return new Response("gone", { status: 404 });
    return new Response(new Uint8Array(zip), { status: 200, headers: { "content-type": "application/octet-stream" } });
  }) as typeof fetch;
}
const MIRRORS = ["https://a.example/d/{set}", "https://b.example/d/{set}"];

async function writeFile(name: string, content: Buffer | string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
}

describe("replay files", () => {
  it("reads the header of a replay", () => {
    const played = new Date("2026-09-01T18:30:00Z");
    const h = parseReplay(buildOsr({ beatmapMd5: MAP_MD5.toUpperCase(), playerName: "tester", modBits: 8 | 64 | 512, playedAt: played, onlineScoreId: 4_812_345_678n, maxCombo: 999, perfect: true }));
    expect(h).toMatchObject({ rulesetId: 0, beatmapMd5: MAP_MD5, playerName: "tester", count300: 400, count100: 10, countMiss: 0, maxCombo: 999, perfect: true, onlineScoreId: 4_812_345_678 });
    expect(h.playedAt.toISOString()).toBe(played.toISOString());
    expect(h.mods).toEqual([{ acronym: "HD" }, { acronym: "NC" }]);
  });

  it("reads 32-bit score ids from old replays", () => {
    const old = buildOsr({ gameVersion: 20130101 });
    // Old replays end in a 4-byte id: drop the last 4 bytes of the 8-byte one and set it.
    const trimmed = Buffer.concat([old.subarray(0, old.length - 8), Buffer.from([0x39, 0x30, 0, 0])]);
    expect(parseReplay(trimmed).onlineScoreId).toBe(12345);
  });

  it("takes mod settings such as a DT rate from lazer's score info", () => {
    const rated = parseReplay(buildOsr({ gameVersion: 30000019, modBits: 64, lazerMods: [{ acronym: "DT", settings: { speed_change: 1.2 } }] }));
    expect(rated.mods).toEqual([{ acronym: "DT", settings: { speed_change: 1.2 } }]);
    // Target Practice's accuracy sits between the score id and lazer's block.
    const tp = parseReplay(buildOsr({ gameVersion: 30000019, modBits: 1 << 23, targetAccuracy: 0.97, lazerMods: [{ acronym: "TP" }, { acronym: "HT", settings: { speed_change: 0.8 } }] }));
    expect(tp.mods.map((m) => m.acronym)).toEqual(["TP", "HT"]);
    // An unreadable block falls back to the mod bits.
    expect(parseReplay(buildOsr({ gameVersion: 30000019, modBits: 64, lazerMods: Buffer.from("not lzma") })).mods).toEqual([{ acronym: "DT" }]);
  });

  it("maps legacy mods and grades like stable", () => {
    expect(legacyMods(32 | 16384 | 16).map((m) => m.acronym)).toEqual(["HR", "PF"]);
    expect(replayRank({ count300: 100, count100: 0, count50: 0, countMiss: 0, mods: [{ acronym: "HD" }] })).toBe("XH");
    expect(replayRank({ count300: 95, count100: 5, count50: 0, countMiss: 0, mods: [] })).toBe("S");
    expect(replayRank({ count300: 95, count100: 4, count50: 0, countMiss: 1, mods: [] })).toBe("A");
    expect(replayRank({ count300: 50, count100: 50, count50: 0, countMiss: 0, mods: [] })).toBe("D");
  });

  it("refuses files that aren't replays", () => {
    expect(() => parseReplay(Buffer.from("hello"))).toThrow(/isn't an osu! replay/);
    expect(() => parseReplay(buildOsr().subarray(0, 60))).toThrow(/ends too early/);
  });

  it("reads .osu metadata", () => {
    expect(parseOsuMetadata(insane)).toEqual({ beatmapId: MAP_ID, beatmapsetId: SET_ID, artist: `Artist ${SET_ID}`, title: `Song ${SET_ID}`, version: "Insane", creator: "mapper" });
    expect(parseOsuMetadata("osu file format v14\n[Metadata]\nTitle:x\nBeatmapID:0\n")).toMatchObject({ beatmapId: null, title: "x" });
  });
});

describe("saving and linking replays", () => {
  it("stores a replay once, however often it's uploaded", async () => {
    const data = buildOsr({ beatmapMd5: MAP_MD5 });
    const first = await saveReplay(db.sql, media, data, null);
    const again = await saveReplay(db.sql, media, data, null);
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
    expect(first.id).toMatch(/^[a-z0-9]{10}$/);
    expect(await fs.readFile(path.join(media.replays, `${first.id}.osr`))).toEqual(data);
    await expect(saveReplay(db.sql, media, buildOsr({ rulesetId: 1 }), null)).rejects.toThrow(/Only osu!standard/);
  });

  it("normalizes the server a play was set on", () => {
    expect(normalizeDevserver("https://Gatari.pw/")).toBe("gatari.pw");
    expect(normalizeDevserver("bancho")).toBeNull();
    expect(normalizeDevserver(undefined)).toBeNull();
    expect(() => normalizeDevserver("not a host!")).toThrow(/isn't a server hostname/);
  });

  it("links replays to library plays by online id, or by the play itself", async () => {
    const byId = score(MAP_ID, { legacy_score_id: 4_000_000_001, beatmap: beatmap(MAP_ID) });
    const byPlay = score(MAP_ID, { max_combo: 321, statistics: { great: 300, ok: 3, meh: 0, miss: 2 }, total_score: 555_555, beatmap: beatmap(MAP_ID) });
    osu.recent = [byId, byPlay];
    await runImport({ sql: db.sql, osu, pp: null, userId: USER_ID, mode: "recent", recentWindowHours: 24, checkpoint: {}, assertActive: () => {}, saveCheckpoint: async () => {} });

    const a = await saveReplay(db.sql, media, buildOsr({ onlineScoreId: 4_000_000_001n, data: Buffer.from("a") }), null);
    const b = await saveReplay(db.sql, media, buildOsr({ playerName: "TESTER", counts: [300, 3, 0, 0, 0, 2], maxCombo: 321, totalScore: 555_555, data: Buffer.from("b") }), null);
    const onGatari = await saveReplay(db.sql, media, buildOsr({ onlineScoreId: 4_000_000_001n, data: Buffer.from("c") }), "gatari.pw");
    const someoneElse = await saveReplay(db.sql, media, buildOsr({ playerName: "rival", counts: [300, 3, 0, 0, 0, 2], maxCombo: 321, totalScore: 555_555, data: Buffer.from("d") }), null);
    await db.sql`update replays set beatmap_id = ${MAP_ID}`;

    expect(await linkReplays(db.sql, USER_ID)).toBe(2);
    expect((await getReplay(db.sql, a.id))?.score_id).toBe(byId.id);
    expect((await getReplay(db.sql, b.id))?.score_id).toBe(byPlay.id);
    expect((await getReplay(db.sql, onGatari.id))?.score_id).toBeNull();
    expect((await getReplay(db.sql, someoneElse.id))?.score_id).toBeNull();
  });

  it("re-reads the mods of lazer replays saved without their settings", async () => {
    const rate = [{ acronym: "DT", settings: { speed_change: 1.2 } }];
    const lazer = await saveReplay(db.sql, media, buildOsr({ gameVersion: 30000019, modBits: 64, lazerMods: rate }), null);
    const stable = await saveReplay(db.sql, media, buildOsr({ modBits: 64, data: Buffer.from("stable") }), null);
    expect((await getReplay(db.sql, lazer.id))?.mods).toEqual(rate);
    // As saved before the score info was read.
    await db.sql`update replays set mods = ${db.sql.json([{ acronym: "DT" }])} where id = ${lazer.id}`;

    const log: string[] = [];
    expect(await refreshLazerReplayMods({ sql: db.sql, paths: media, log: (m) => log.push(m) })).toBe(1);
    expect((await getReplay(db.sql, lazer.id))?.mods).toEqual(rate);
    expect((await getReplay(db.sql, stable.id))?.mods).toEqual([{ acronym: "DT" }]);
    expect(await refreshLazerReplayMods({ sql: db.sql, paths: media, log: (m) => log.push(m) })).toBe(0);
  });
});

describe("beatmaps", () => {
  it("unpacks an .osz and indexes every difficulty by MD5", async () => {
    const files = await installOsz(db.sql, media, await writeFile("set.osz", setZip()), "700", "mirror");
    expect(files.map((f) => f.md5).sort()).toEqual([MAP_MD5, md5Of(hard)].sort());
    expect(await fs.readFile(path.join(media.songs, "700", "sb", "bg.jpg"), "utf8")).toBe("jpeg");
    const [row] = await db.sql`select folder, beatmap_id, version, source from beatmap_files where md5 = ${MAP_MD5}`;
    expect(row).toEqual({ folder: "700", beatmap_id: MAP_ID, version: "Insane", source: "mirror" });
  });

  it("refuses archives that escape their folder, and ones without the replay's map", async () => {
    const evil = await writeFile("evil.osz", buildZip({ "a.osu": insane, "../../escaped.txt": "x" }));
    await expect(installOsz(db.sql, media, evil, "evil", "upload")).rejects.toThrow(/couldn't be unpacked|unsafe path/);
    await expect(fs.access(path.join(dir, "escaped.txt"))).rejects.toThrow();

    await installOsz(db.sql, media, await writeFile("set.osz", setZip()), "keep", "upload");
    const other = await writeFile("other.osz", buildZip({ "x.osu": osuText(1, 2) }));
    await expect(installOsz(db.sql, media, other, "keep", "upload", MAP_MD5)).rejects.toThrow(/doesn't contain the difficulty/);
    expect(await fs.readdir(path.join(media.songs, "keep"))).toContain("audio.mp3");
    await expect(installOsz(db.sql, media, await writeFile("junk.osz", "not a zip"), "junk", "upload")).rejects.toThrow(/isn't a \.osz file/);
  });

  it("asks osu! which set a replay's map is in, then downloads it from the first mirror that has it", async () => {
    knowMap();
    const calls: string[] = [];
    const result = await ensureBeatmap({ sql: db.sql, osu, paths: media, mirrors: MIRRORS, fetch: mirrorFetch(setZip(), calls) }, MAP_MD5, null);
    expect(result).toMatchObject({ ok: true, beatmapId: MAP_ID, file: { folder: "700" } });
    expect(calls).toEqual(["https://a.example/d/700", "https://b.example/d/700"]);
    expect(await db.sql`select id from beatmaps where id = ${MAP_ID}`).toHaveLength(1);

    // Next time it's already on disk: no lookups or downloads.
    osu.calls = [];
    calls.length = 0;
    expect((await ensureBeatmap({ sql: db.sql, osu, paths: media, mirrors: MIRRORS, fetch: mirrorFetch(setZip(), calls) }, MAP_MD5, MAP_ID)).ok).toBe(true);
    expect([...osu.calls, ...calls]).toEqual([]);
  });

  it("uses osu!'s current .osu when a mirror's copy is outdated", async () => {
    knowMap();
    osu.files.set(MAP_ID, insane);
    const stale = setZip(osuText(MAP_ID, SET_ID, "Insane (old)"));
    const result = await ensureBeatmap({ sql: db.sql, osu, paths: media, mirrors: MIRRORS, fetch: mirrorFetch(stale) }, MAP_MD5, null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.file).toMatch(/^kiai-70-/);
  });

  it("explains what's missing when no source has the map", async () => {
    const unknown = await ensureBeatmap({ sql: db.sql, osu, paths: media, mirrors: MIRRORS, fetch: mirrorFetch(setZip()) }, MAP_MD5, null);
    expect(unknown).toMatchObject({ ok: false, reason: expect.stringContaining("osu! doesn't know this version") });
    knowMap();
    const noMirror = await ensureBeatmap({ sql: db.sql, osu, paths: media, mirrors: MIRRORS, fetch: mirrorFetch(null) }, MAP_MD5, null);
    expect(noMirror).toMatchObject({ ok: false, beatmapId: MAP_ID, reason: expect.stringContaining("No mirror had beatmap set 700") });
    const noCredentials = await ensureBeatmap({ sql: db.sql, osu: null, paths: media, mirrors: MIRRORS }, md5Of("other"), null);
    expect(noCredentials).toMatchObject({ ok: false, reason: expect.stringContaining("OSU_CLIENT_ID") });
  });
});

/** Writes a small "video" and reports progress, like danser would. */
function fakeRenderer(behaviour: "ok" | "fail" | "big" = "ok"): Renderer & { inputs: string[] } {
  const inputs: string[] = [];
  return {
    inputs,
    async render(input) {
      inputs.push(input.outputName);
      input.onProgress(50);
      if (behaviour === "fail") throw new Error("danser exited with code 2.");
      const out = path.join(media.videos, `${input.outputName}.mp4`);
      await fs.writeFile(out, Buffer.alloc(2048, 7));
      // Sparse: too big for Discord without taking the disk space.
      if (behaviour === "big") await fs.truncate(out, EMBED_MAX_BYTES + 1);
      input.onProgress(100);
      return out;
    },
  };
}

function renderDeps(renderer: Renderer, fetchImpl = mirrorFetch(setZip())): RenderDeps {
  return { sql: db.sql, osu, paths: media, renderer, mirrors: MIRRORS, fetch: fetchImpl, playerId: USER_ID, log: () => {} };
}

describe("render queue and worker", () => {
  it("renders a queued replay into the videos directory", async () => {
    knowMap();
    const { id } = await saveReplay(db.sql, media, buildOsr({ beatmapMd5: MAP_MD5 }), null);
    await enqueueRender(db.sql, id, null);
    const renderer = fakeRenderer();
    expect(await runNextRender(renderDeps(renderer))).toBe(true);
    expect(await runNextRender(renderDeps(renderer))).toBe(false);

    const replay = await getReplay(db.sql, id);
    expect(replay?.render).toMatchObject({ status: "success", progress: 100, video_url: `/replays/${id}/video`, video_bytes: 2048 });
    expect(replay?.beatmap).toMatchObject({ id: MAP_ID, beatmapset_id: SET_ID });
    const [job] = await db.sql`select video_path from render_jobs`;
    expect(job?.video_path).toBe(`videos/${renderer.inputs[0]}.mp4`);
  });

  it("makes a copy Discord can play of a render too big for it, and goes on without one if that fails", async () => {
    knowMap();
    const shrunk: string[] = [];
    const embedder: Embedder = {
      async shrink(input) {
        shrunk.push(input.source);
        await fs.writeFile(input.output, Buffer.alloc(1024, 1));
        return 1024;
      },
    };
    const small = (await saveReplay(db.sql, media, buildOsr({ beatmapMd5: MAP_MD5 }), null)).id;
    await enqueueRender(db.sql, small, null);
    await runNextRender({ ...renderDeps(fakeRenderer()), embedder });
    expect(shrunk).toEqual([]);

    const big = (await saveReplay(db.sql, media, buildOsr({ beatmapMd5: MAP_MD5, totalScore: 2 }), null)).id;
    await enqueueRender(db.sql, big, null);
    const renderer = fakeRenderer("big");
    await runNextRender({ ...renderDeps(renderer), embedder });
    const [job] = await db.sql`select video_path, embed_path, embed_bytes from render_jobs where replay_id = ${big}`;
    expect(shrunk).toEqual([path.join(media.videos, `${renderer.inputs[0]}.mp4`)]);
    expect(job).toMatchObject({ video_path: `videos/${renderer.inputs[0]}.mp4`, embed_path: `videos/${renderer.inputs[0]}-embed.mp4`, embed_bytes: 1024 });
    expect((await fs.stat(path.join(media.root, job!.embed_path as string))).size).toBe(1024);

    const failing: Embedder = { shrink: async () => Promise.reject(new Error("ffmpeg failed: no NVENC")) };
    const again = (await saveReplay(db.sql, media, buildOsr({ beatmapMd5: MAP_MD5, totalScore: 3 }), null)).id;
    await enqueueRender(db.sql, again, null);
    await runNextRender({ ...renderDeps(fakeRenderer("big")), embedder: failing });
    expect((await getReplay(db.sql, again))?.render?.status).toBe("success");
    expect((await db.sql`select embed_path from render_jobs where replay_id = ${again}`)[0]?.embed_path).toBeNull();
    expect(await fs.readdir(media.tmp)).toEqual([]);
  });

  it("queues each replay once until its render finishes", async () => {
    const { id } = await saveReplay(db.sql, media, buildOsr(), null);
    const first = await enqueueRender(db.sql, id, "default");
    const second = await enqueueRender(db.sql, id, "default");
    expect(second).toMatchObject({ alreadyQueued: true, job: { id: first.job.id } });
  });

  it("records failures with danser's reason", async () => {
    knowMap();
    const { id } = await saveReplay(db.sql, media, buildOsr({ beatmapMd5: MAP_MD5 }), null);
    await enqueueRender(db.sql, id, "default");
    await runNextRender(renderDeps(fakeRenderer("fail")));
    expect((await getReplay(db.sql, id))?.render).toMatchObject({ status: "failed", error: "danser exited with code 2." });
  });

  it("parks a replay whose map can't be found until the map is uploaded", async () => {
    const { id } = await saveReplay(db.sql, media, buildOsr({ beatmapMd5: MAP_MD5 }), null);
    await enqueueRender(db.sql, id, "default");
    await runNextRender(renderDeps(fakeRenderer()));
    expect((await getReplay(db.sql, id))?.render).toMatchObject({ status: "needs_map", attempts: 0, error: expect.stringContaining("Upload the .osz") });
    expect(await claimRender(db.sql, crypto.randomUUID())).toBeNull();
  });

  it("takes over jobs from dead workers, and gives up after repeated deaths", async () => {
    const { id } = await saveReplay(db.sql, media, buildOsr(), null);
    await enqueueRender(db.sql, id, "default");
    const claimed = await claimRender(db.sql, crypto.randomUUID());
    expect(claimed?.attempts).toBe(1);
    expect(await claimRender(db.sql, crypto.randomUUID())).toBeNull();

    await db.sql`update render_jobs set heartbeat_at = now() - interval '10 minutes'`;
    expect((await claimRender(db.sql, crypto.randomUUID()))?.attempts).toBe(2);

    await db.sql`update render_jobs set heartbeat_at = now() - interval '10 minutes', attempts = ${MAX_RENDER_ATTEMPTS}`;
    expect(await claimRender(db.sql, crypto.randomUUID())).toBeNull();
    expect((await getReplay(db.sql, id))?.render).toMatchObject({ status: "failed", error: expect.stringContaining("stopped responding") });
  });
});

/** A replay of the known map, rendered `renders` times. */
async function renderedReplay(name: string, renders = 1): Promise<string> {
  knowMap();
  const { id } = await saveReplay(db.sql, media, buildOsr({ beatmapMd5: MAP_MD5, playerName: name, data: Buffer.from(name) }), null);
  for (let i = 0; i < renders; i++) {
    await enqueueRender(db.sql, id, "default");
    await runNextRender(renderDeps(fakeRenderer()));
  }
  return id;
}

const exists = (file: string) => fs.access(file).then(() => true, () => false);
const videoFiles = async () => (await fs.readdir(media.videos)).sort();

async function addClip(replayId: string, clipId: string): Promise<string> {
  const file = path.join(media.videos, `clip-${clipId}.mp4`);
  await fs.writeFile(file, Buffer.alloc(512));
  await db.sql`insert into clip_jobs (id, replay_id, start_ms, end_ms, status, video_path, video_bytes)
    values (${clipId}, ${replayId}, 0, 1000, 'success', ${`videos/clip-${clipId}.mp4`}, 512)`;
  return file;
}

describe("managing replays", () => {
  it("deletes replays with their file, renders, clips and videos, and nothing else", async () => {
    const gone = await renderedReplay("gone", 2);
    const kept = await renderedReplay("kept");
    await addClip(gone, "clipgone01");
    const keptClip = await addClip(kept, "clipkept01");
    expect(await videoFiles()).toHaveLength(5);

    expect(await deleteReplays(db.sql, media, [gone, "notanid", "nosuchone1"])).toBe(1);
    expect(await getReplay(db.sql, gone)).toBeNull();
    expect(await exists(replayFile(media, gone))).toBe(false);
    expect(await db.sql`select id from render_jobs where replay_id = ${gone}`).toHaveLength(0);
    expect(await videoFiles()).toEqual([`${kept}-${(await getReplay(db.sql, kept))!.render!.id}.mp4`, "clip-clipkept01.mp4"].sort());
    expect(await exists(replayFile(media, kept))).toBe(true);
    expect(await exists(keptClip)).toBe(true);
  });

  it("deletes only the videos, keeping the replay and its clips", async () => {
    const id = await renderedReplay("player", 2);
    const clip = await addClip(id, "clipclip01");
    await enqueueRender(db.sql, id, "default");

    expect(await deleteRenderVideos(db.sql, media, [id])).toBe(2);
    expect(await videoFiles()).toEqual(["clip-clipclip01.mp4"]);
    expect(await exists(clip)).toBe(true);
    // The queued render is left to run.
    expect((await getReplay(db.sql, id))?.render?.status).toBe("queued");
  });

  it("prunes only renders that a newer successful render replaced", async () => {
    const twice = await renderedReplay("twice", 3);
    const once = await renderedReplay("once");
    // A newer failed render doesn't replace the video the public page still serves.
    await enqueueRender(db.sql, once, "default");
    await runNextRender(renderDeps(fakeRenderer("fail")));

    expect(await replayStorage(db.sql)).toMatchObject({ replays: 2, render_bytes: 4 * 2048, superseded_videos: 2, superseded_bytes: 2 * 2048 });
    expect(await pruneSupersededRenders(db.sql, media)).toEqual({ videos: 2, bytes: 2 * 2048 });
    const latest = (await getReplay(db.sql, twice))!.render!;
    expect(await videoFiles()).toEqual([`${twice}-${latest.id}.mp4`, expect.stringMatching(new RegExp(`^${once}-`))].sort());
    expect(await db.sql`select id from render_jobs where replay_id = ${once} and status = 'success'`).toHaveLength(1);
    expect((await replayStorage(db.sql)).superseded_videos).toBe(0);
  });

  it("drops the video of a render whose replay was deleted while it rendered", async () => {
    knowMap();
    const { id } = await saveReplay(db.sql, media, buildOsr({ beatmapMd5: MAP_MD5 }), null);
    await enqueueRender(db.sql, id, "default");
    const renderer = fakeRenderer();
    const deletingRenderer: Renderer = {
      async render(input, signal) {
        await deleteReplays(db.sql, media, [id]);
        return renderer.render(input, signal);
      },
    };
    await runNextRender(renderDeps(deletingRenderer));
    expect(await videoFiles()).toEqual([]);
  });

  it("lists replays a page at a time, by search and render state", async () => {
    const rendered = await renderedReplay("alice");
    const { id: waiting } = await saveReplay(db.sql, media, buildOsr({ playerName: "bob", data: Buffer.from("bob") }), null);
    await enqueueRender(db.sql, waiting, null);
    const { id: bare } = await saveReplay(db.sql, media, buildOsr({ playerName: "carol", data: Buffer.from("carol"), modBits: 8 | 64 }), null);

    const ids = async (o: Partial<Parameters<typeof listReplayPage>[1]>) =>
      (await listReplayPage(db.sql, { query: "", render: "all", page: 1, pageSize: 50, ...o })).replays.map((r) => r.id);
    expect(await ids({})).toEqual([bare, waiting, rendered]);
    expect(await ids({ render: "rendered" })).toEqual([rendered]);
    expect(await ids({ render: "pending" })).toEqual([waiting]);
    expect(await ids({ render: "none" })).toEqual([bare]);
    expect(await ids({ query: "dthd" })).toEqual([bare]);
    expect(await ids({ query: "song alice" })).toEqual([rendered]);
    const second = await listReplayPage(db.sql, { query: "", render: "all", page: 2, pageSize: 2 });
    expect(second.replays.map((r) => r.id)).toEqual([rendered]);
    expect(second.pagination).toEqual({ page: 2, page_size: 2, total_count: 3, total_pages: 2 });
  });
});

describe("danser", () => {
  // Stands in for danser-cli: records its arguments, prints progress, writes <out>.mp4 unless told not to.
  async function fakeDanser(mode: "ok" | "missing-map", glRenderer = "NVIDIA GeForce GTX 1050 Ti/PCIe/SSE2"): Promise<string> {
    const script = path.join(dir, "fake-danser");
    await fs.writeFile(
      script,
      `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/args"
echo "2026/09/23 12:00:00 GL Renderer:   ${glRenderer}"
out=""
while [ $# -gt 0 ]; do [ "$1" = "-out" ] && out="$2"; shift; done
${mode === "ok"
  ? `echo "Progress: 10%, Speed: 2.00x, ETA: 5s"\necho "Progress: 60%, Speed: 2.00x, ETA: 2s" >&2\nprintf 'video' > "${media.videos}/$out.mp4"`
  : `echo "Beatmap not found, closing..."`}
exit 0
`,
      { mode: 0o755 },
    );
    return script;
  }

  it("runs danser-cli with kiai's settings and the preset, and reports progress", async () => {
    const danserDir = path.join(dir, "danser");
    const renderer = danserRenderer({ dir: danserDir, paths: media, encoder: "libx264", xvfb: false, gl: "software", timeoutMs: 30_000, command: await fakeDanser("ok") });
    const progress: number[] = [];
    const video = await renderer.render({ replayFile: "/r.osr", outputName: "abc-1", preset: PRESET, onProgress: (p) => progress.push(p) }, new AbortController().signal);

    expect(video).toBe(path.join(media.videos, "abc-1.mp4"));
    expect(progress).toEqual([10, 60]);
    const args = (await fs.readFile(path.join(dir, "args"), "utf8")).trim().split("\n");
    expect(args.slice(0, 7)).toEqual(["-replay", "/r.osr", "-record", "-out", "abc-1", "-settings", "kiai"]);
    expect(JSON.parse(args[args.indexOf("-sPatch") + 1]!)).toEqual(PRESET.patch);
    expect(args).not.toContain("-skip");
    const settings = JSON.parse(await fs.readFile(path.join(danserDir, "settings", "kiai.json"), "utf8"));
    expect(settings).toMatchObject({ General: { OsuSongsDir: media.songs }, Recording: { Encoder: "libx264", OutputDir: media.videos } });
  });

  it("fails with danser's own words when no video comes out", async () => {
    const renderer = danserRenderer({ dir: path.join(dir, "danser"), paths: media, encoder: "libx264", xvfb: false, gl: "software", timeoutMs: 30_000, command: await fakeDanser("missing-map") });
    await expect(renderer.render({ replayFile: "/r.osr", outputName: "x", preset: PRESET, onProgress: () => {} }, new AbortController().signal)).rejects.toThrow(
      /couldn't find the beatmap[\s\S]*Beatmap not found/,
    );
  });

  it("draws through VirtualGL on the GPU, skips the intro, and says when GL is on the CPU", async () => {
    expect(danserCommand({ xvfb: true, gl: "gpu" }, "/opt/danser/danser-cli", ["-record"])).toEqual([
      "xvfb-run", "-a", "-s", "-screen 0 1920x1080x24", "vglrun", "-d", "egl", "/opt/danser/danser-cli", "-record",
    ]);
    expect(danserCommand({ xvfb: false, gl: "software" }, "danser-cli", ["-record"])).toEqual(["danser-cli", "-record"]);

    const logs: string[] = [];
    const options = { dir: path.join(dir, "danser"), paths: media, encoder: "libx264", xvfb: false, gl: "software", timeoutMs: 30_000, log: (m: string) => logs.push(m) } as const;
    const input = { replayFile: "/r.osr", outputName: "gl", preset: { ...PRESET, skipIntro: true }, onProgress: () => {} };
    await danserRenderer({ ...options, command: await fakeDanser("ok", "llvmpipe (LLVM 15.0.6, 256 bits)") }).render(input, new AbortController().signal);
    expect((await fs.readFile(path.join(dir, "args"), "utf8")).split("\n")).toContain("-skip");
    expect(logs).toEqual([expect.stringMatching(/^danser is drawing with llvmpipe \(LLVM 15\.0\.6, 256 bits\), on the CPU.*RENDER_GL=gpu/)]);

    logs.length = 0;
    await danserRenderer({ ...options, command: await fakeDanser("ok") }).render(input, new AbortController().signal);
    expect(logs).toEqual(["danser is drawing with NVIDIA GeForce GTX 1050 Ti/PCIe/SSE2"]);
  });
});

describe("HTTP", () => {
  let app: Hono;
  const request = (p: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "localhost:8080");
    return app.request(`${ORIGIN}${p}`, { ...init, headers });
  };
  const upload = (body: Buffer, token: string | null = TOKEN, query = "") =>
    request(`/api/replays${query}`, {
      method: "POST",
      body: new Uint8Array(body),
      headers: { "content-type": "application/octet-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  const makeApp = (uploadToken?: string) =>
    createApp({ sql: db.sql, osu, player, media, config: { RECENT_WINDOW_HOURS: 24, PRIVATE_HOSTS: [], ...(uploadToken ? { UPLOAD_TOKEN: uploadToken } : {}) } });

  beforeEach(() => {
    app = makeApp(TOKEN);
  });

  it("needs the upload token, and refuses uploads through a tunnel", async () => {
    app = makeApp();
    expect((await upload(buildOsr())).status).toBe(503);
    app = makeApp(TOKEN);
    expect((await upload(buildOsr(), null)).status).toBe(401);
    expect((await upload(buildOsr(), "wrong-token-wrong-token")).status).toBe(403);
    const tunnelled = await request("/api/replays", { method: "POST", body: new Uint8Array(buildOsr()), headers: { authorization: `Bearer ${TOKEN}`, "cf-ray": "1" } });
    expect(tunnelled.status).toBe(403);
  });

  it("accepts a replay, queues its render, and returns the same replay for the same file", async () => {
    const created = await upload(buildOsr({ beatmapMd5: MAP_MD5 }), TOKEN, "?devserver=gatari.pw");
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; created: boolean; devserver: string; render: { status: string } };
    expect(body).toMatchObject({ created: true, devserver: "gatari.pw", render: { status: "queued" } });

    const again = await upload(buildOsr({ beatmapMd5: MAP_MD5 }), TOKEN, "?devserver=gatari.pw");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: body.id, created: false });
    expect(await db.sql`select id from render_jobs`).toHaveLength(1);

    expect((await upload(Buffer.from("junk"))).status).toBe(400);
    expect(await (await request(`/api/replays/${body.id}`)).json()).toMatchObject({ id: body.id });
    expect((await request("/api/replays/nosuchone1")).status).toBe(404);
  });

  it("takes the .osz for a map no mirror has, and queues the waiting render again", async () => {
    const created = (await (await upload(buildOsr({ beatmapMd5: MAP_MD5 }))).json()) as { id: string };
    await runNextRender(renderDeps(fakeRenderer()));
    expect((await getReplay(db.sql, created.id))?.render?.status).toBe("needs_map");

    const put = (zip: Buffer) =>
      request(`/api/replays/${created.id}/beatmapset`, { method: "PUT", body: new Uint8Array(zip), headers: { authorization: `Bearer ${TOKEN}` } });
    const wrong = await put(buildZip({ "x.osu": osuText(1, 2) }));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: expect.stringContaining("doesn't contain the difficulty") });

    const ok = await put(setZip());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ difficulties: 2, requeued: 1, replay: { render: { status: "queued" } } });

    await runNextRender(renderDeps(fakeRenderer()));
    const replay = await getReplay(db.sql, created.id);
    expect(replay?.render?.status).toBe("success");
    expect(replay?.beatmap).toMatchObject({ title: `Song ${SET_ID}`, version: "Insane" });
  });

  it("serves the video with byte ranges and shows replay pages", async () => {
    knowMap();
    const { id } = (await (await upload(buildOsr({ beatmapMd5: MAP_MD5 }))).json()) as { id: string };
    expect((await request(`/replays/${id}/video`)).status).toBe(404);
    await runNextRender(renderDeps(fakeRenderer()));

    const whole = await request(`/replays/${id}/video`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect((await whole.arrayBuffer()).byteLength).toBe(2048);
    const part = await request(`/replays/${id}/video`, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 100-199/2048");
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    expect((await request(`/replays/${id}/video`, { headers: { range: "bytes=5000-" } })).status).toBe(416);

    const list = await (await request("/replays")).text();
    expect(list).toContain(`/replays/${id}`);
    expect(list).toContain("Rendered");
    const page = await (await request(`/replays/${id}`)).text();
    expect(page).toContain(`<video src="/replays/${id}/video"`);
  });

  it("re-renders on request from the page, but not from another site", async () => {
    const { id } = (await (await upload(buildOsr())).json()) as { id: string };
    await db.sql`update render_jobs set status = 'failed'`;
    const rerender = (origin: string) => request(`/replays/${id}/render`, { method: "POST", headers: { origin } });
    expect((await rerender("https://evil.example")).status).toBe(403);
    expect((await rerender(ORIGIN)).status).toBe(303);
    expect((await getReplay(db.sql, id))?.render?.status).toBe("queued");
  });

  it("manages replays from the panel, but not from another site", async () => {
    const first = await renderedReplay("first", 2);
    const second = await renderedReplay("second");
    const panel = await (await request("/replays")).text();
    expect(panel).toContain(`name="id" value="${first}"`);
    expect(panel).toContain("1 older videos");
    expect(await (await request("/replays?render=none")).text()).toContain("No replays match.");

    const manage = (fields: [string, string][], origin = ORIGIN) =>
      request("/replays/manage", { method: "POST", body: new URLSearchParams(fields), headers: { origin, "content-type": "application/x-www-form-urlencoded" } });
    expect((await manage([["action", "delete"], ["id", first]], "https://evil.example")).status).toBe(403);

    const rerendered = await manage([["action", "render"], ["preset", "default"], ["id", first], ["id", second], ["back", "?render=rendered&page=1"]]);
    expect(rerendered.status).toBe(303);
    const back = new URL(rerendered.headers.get("location")!, ORIGIN);
    expect(back.pathname).toBe("/replays");
    expect(Object.fromEntries(back.searchParams)).toEqual({ render: "rendered", page: "1", notice: "Queued 2 renders." });
    expect((await getReplay(db.sql, second))?.render).toMatchObject({ status: "queued", preset: "default" });

    const cleanup = await request("/replays/cleanup", { method: "POST", headers: { origin: ORIGIN } });
    expect(new URL(cleanup.headers.get("location")!, ORIGIN).searchParams.get("notice")).toContain("Deleted 1 older video");

    const deleted = await manage([["action", "delete"], ["id", first], ["id", second]]);
    expect(new URL(deleted.headers.get("location")!, ORIGIN).searchParams.get("notice")).toBe("Deleted 2 replays.");
    expect(await db.sql`select id from replays`).toHaveLength(0);
    expect(await videoFiles()).toEqual([]);
  });

  it("deletes a replay from its page and through the API", async () => {
    const one = await renderedReplay("one");
    const two = await renderedReplay("two");
    expect(await (await request(`/replays/${one}`)).text()).toContain(`action="/replays/${one}/delete"`);
    const fromPage = await request(`/replays/${one}/delete`, { method: "POST", headers: { origin: ORIGIN } });
    expect(fromPage.status).toBe(303);
    expect(await getReplay(db.sql, one)).toBeNull();

    expect((await request(`/api/replays/${two}`, { method: "DELETE" })).status).toBe(200);
    expect((await request(`/api/replays/${two}`, { method: "DELETE" })).status).toBe(404);
    expect(await videoFiles()).toEqual([]);
  });
});
