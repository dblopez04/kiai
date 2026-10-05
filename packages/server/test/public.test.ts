import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPublicApp } from "../src/http/public.ts";
import { ensureMediaDirs, mediaPaths, type MediaPaths } from "../src/media.ts";
import type { Renderer } from "../src/render/danser.ts";
import { installOsz } from "../src/render/maps.ts";
import { discordNotifier, renderedMessage } from "../src/render/notify.ts";
import { enqueueRender } from "../src/render/queue.ts";
import { runNextRender } from "../src/render/worker.ts";
import { replayAttributes } from "../src/replays/attributes.ts";
import { contrast, mapColours, mapPalette, type ImageDecoder } from "../src/replays/palette.ts";
import { listGallery } from "../src/replays/gallery.ts";
import { getReplay, saveReplay } from "../src/replays/store.ts";
import { parseScoreFilters } from "../src/scores/query.ts";
import { beatmapRow } from "../src/scores/rows.ts";
import { upsertBeatmaps } from "../src/scores/store.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { beatmap, fakeOsu, osuFile, trackUser, USER_ID } from "./helpers/fake-osu.ts";
import { buildOsr, buildZip, md5Of, type OsrOptions } from "./helpers/replay-files.ts";

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
  await db.sql`truncate osu_users, beatmaps, scores, replays, render_jobs, beatmap_files cascade`;
  await trackUser(db.sql);
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kiai-public-"));
  media = mediaPaths(dir);
  await ensureMediaDirs(media);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// A real, calculable map (40 circles at 120 BPM, AR9) with its metadata, background and combo colours.
const MAP = osuFile()
  .replace("[Difficulty]", "[Metadata]\nTitle:Public Song\nArtist:kiai\nCreator:mapper\nVersion:Hard\nBeatmapID:0\nBeatmapSetID:-1\n\n[Difficulty]")
  .replace("[TimingPoints]", '[Events]\n//Background and Video events\n0,0,"bg.jpg",0,0\n\n[Colours]\nCombo1 : 200,200,200\nCombo2 : 40,90,230\n\n[TimingPoints]');
const MAP_MD5 = md5Of(MAP);

const fakeRenderer: Renderer = {
  async render(input) {
    const out = path.join(media.videos, `${input.outputName}.mp4`);
    await fs.writeFile(out, Buffer.alloc(4096, 1));
    return out;
  },
};

type Sent = { url: string; body: Record<string, unknown> };
function discordFetch(sent: Sent[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    // Videos are never uploaded to Discord: every request is a JSON message.
    if (typeof init?.body !== "string") throw new Error("Expected a JSON body, not an upload.");
    sent.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    if (url.endsWith("/users/@me/channels")) return Response.json({ id: "555" });
    return Response.json({ id: "1" });
  }) as typeof fetch;
}

/** A rendered message's text and video, checking it's one Components V2 container without content or embeds. */
function renderedComponents(body: object): { text: string; video: string | undefined } {
  const message = body as { flags: number; content?: unknown; embeds?: unknown; components: { type: number; components: { type: number; content?: string; items?: { media: { url: string } }[] }[] }[] };
  expect(message.flags & (1 << 15)).toBeTruthy();
  expect(message.content).toBeUndefined();
  expect(message.embeds).toBeUndefined();
  expect(message.components.map((c) => c.type)).toEqual([17]);
  const parts = message.components[0]!.components;
  return { text: parts.find((c) => c.type === 10)!.content!, video: parts.find((c) => c.type === 12)?.items?.[0]?.media.url };
}

/** Upload a replay of MAP (DT, 38/2/0/0), install the map, and render it. */
async function renderedReplay(notifier: ReturnType<typeof discordNotifier> = null, decodeImage: ImageDecoder | null = null): Promise<string> {
  await installOsz(db.sql, media, await writeZip(), "upload-test", "upload");
  const { id } = await saveReplay(db.sql, media, buildOsr({ beatmapMd5: MAP_MD5, modBits: 64, counts: [38, 2, 0, 0, 0, 0], maxCombo: 40 }), null);
  await enqueueRender(db.sql, id, "default");
  await runNextRender({ sql: db.sql, osu: fakeOsu(), paths: media, renderer: fakeRenderer, mirrors: [], playerId: USER_ID, notifier, decodeImage, log: () => {} });
  return id;
}

async function writeZip(): Promise<string> {
  const file = path.join(dir, "set.osz");
  await fs.writeFile(file, buildZip({ "map.osu": MAP, "audio.mp3": "x", "bg.jpg": "not really a jpeg" }));
  return file;
}

describe("replay attributes", () => {
  it("applies the replay's mods to the map", () => {
    const nomod = replayAttributes(MAP, { mods: [], count300: 40, count100: 0, count50: 0, countmiss: 0, max_combo: 40 });
    const dt = replayAttributes(MAP, { mods: [{ acronym: "DT" }], count300: 40, count100: 0, count50: 0, countmiss: 0, max_combo: 40 });
    expect(nomod).toMatchObject({ ar: 9, od: 8, cs: 4, bpm: 120, clock_rate: 1, max_combo: 40 });
    expect(dt).toMatchObject({ ar: 10.33, bpm: 180, clock_rate: 1.5 });
    expect(dt!.stars).toBeGreaterThan(nomod!.stars);
    expect(dt!.length).toBe(Math.round(nomod!.length / 1.5));
    expect(nomod!.pp).toBeGreaterThan(0);
    expect(replayAttributes(MAP, { mods: [{ acronym: "WU" }], count300: 1, count100: 0, count50: 0, countmiss: 0, max_combo: 1 })).toBeNull();
    expect(replayAttributes("not a map", { mods: [], count300: 1, count100: 0, count50: 0, countmiss: 0, max_combo: 1 })).toBeNull();
  });

  it("are stored when the replay renders", async () => {
    const id = await renderedReplay();
    expect((await getReplay(db.sql, id))?.attributes).toMatchObject({ ar: 10.33, bpm: 180 });
  });
});

/** `n` pixels of one colour, as an image decoder hands them over. */
const solid = (rgb: [number, number, number], n = 48 * 27) => new Uint8Array(Array.from({ length: n }, () => rgb).flat());
const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

describe("map palette", () => {
  it("reads the background and combo colours from the .osu", () => {
    expect(mapColours(MAP)).toEqual({ background: "bg.jpg", combo: [[200, 200, 200], [40, 90, 230]] });
    expect(mapColours('[Events]\n0,0,bg with spaces.png,0,0\n1,0,"video.mp4"')).toEqual({ background: "bg with spaces.png", combo: [] });
    expect(mapColours(osuFile())).toEqual({ background: null, combo: [] });
  });

  it("takes the background's hue, then the most vivid combo colour, then a hash", () => {
    // Mostly grey with a patch of green: the green wins, the grey counts for nothing.
    const pixels = new Uint8Array([...solid([128, 128, 128], 900), ...solid([30, 200, 60], 300)]);
    const fromImage = mapPalette({ pixels, combo: [[40, 90, 230]], seed: "x" });
    expect(fromImage.source).toBe("background");
    const [r, g, b] = rgbOf(fromImage.accent);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);

    // A black-and-white background falls through to the combo colours: the blue one.
    const fromCombo = mapPalette({ pixels: solid([250, 250, 250]), combo: [[200, 200, 200], [40, 90, 230]], seed: "x" });
    expect(fromCombo.source).toBe("combo");
    expect(rgbOf(fromCombo.accent)[2]).toBeGreaterThan(rgbOf(fromCombo.accent)[0]);

    const hashed = mapPalette({ seed: "abc" });
    expect(hashed).toEqual(mapPalette({ seed: "abc" }));
    expect(hashed.source).toBe("hash");

    // Text and links always read on the page, whatever the hue.
    for (const p of [fromImage, fromCombo, hashed, mapPalette({ pixels: solid([255, 255, 0]), seed: "y" })]) {
      for (const c of [p.ink, p.muted, p.accent, p.visited]) expect(contrast(rgbOf(c), rgbOf(p.paper))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("is stored when the replay renders, from the background when it can be read", async () => {
    const decoded: string[] = [];
    const id = await renderedReplay(null, async (file) => {
      decoded.push(path.basename(file));
      return solid([220, 40, 40]);
    });
    expect(decoded).toEqual(["bg.jpg"]);
    expect((await getReplay(db.sql, id))?.palette).toMatchObject({ source: "background" });
    expect(rgbOf((await getReplay(db.sql, id))!.palette!.accent)[0]).toBeGreaterThan(100); // red, from the "image"
  });

  it("falls back to the combo colours without a decoder", async () => {
    const id = await renderedReplay();
    expect((await getReplay(db.sql, id))?.palette?.source).toBe("combo");
  });
});

describe("Discord", () => {
  it("DMs through a bot, once per render, with compact text over the video", async () => {
    const sent: Sent[] = [];
    const notifier = discordNotifier({ botToken: "bot", userId: "123456789012345678", publicUrl: "https://replays.example.com", fetch: discordFetch(sent) });
    const id = await renderedReplay(notifier);
    expect(sent.map((s) => s.url)).toEqual(["https://discord.com/api/v10/users/@me/channels", "https://discord.com/api/v10/channels/555/messages"]);
    expect(sent[0]!.body).toEqual({ recipient_id: "123456789012345678" });
    const message = renderedComponents(sent[1]!.body);
    const lines = message.text.split("\n");
    expect(lines[0]).toBe(`**[kiai - Public Song \\[Hard\\]](https://replays.example.com/r/${id})**`);
    expect(lines[1]).toMatch(/^S · 96\.67% · 40x · \d+pp\\\* · DT 1\.5× · tester$/);
    expect(lines[2]).toMatch(/^-# \d+\.\d\d★ · AR 10\.33 · OD [\d.]+ · CS 4 · 180 BPM$/);
    expect(message.video).toMatch(new RegExp(`^https://replays\\.example\\.com/r/${id}/video\\.mp4\\?v=\\d+$`));

    // Running the notification step again for the same job sends nothing.
    await db.sql`update render_jobs set status = 'queued'`;
    await runNextRender({ sql: db.sql, osu: fakeOsu(), paths: media, renderer: fakeRenderer, mirrors: [], playerId: USER_ID, notifier, log: () => {} });
    expect(sent).toHaveLength(2);
  });

  it("posts to a webhook, and reports failures", async () => {
    const sent: Sent[] = [];
    const notifier = discordNotifier({ webhookUrl: "https://discord.com/api/webhooks/1/abc", fetch: discordFetch(sent) })!;
    const id = await renderedReplay();
    await notifier.failed((await getReplay(db.sql, id))!, "danser exited with code 2.");
    expect(sent[0]!.url).toBe("https://discord.com/api/webhooks/1/abc?wait=true&with_components=true");
    expect(sent[0]!.body.content).toContain("Render failed: **kiai - Public Song [Hard]**");
    expect(discordNotifier({})).toBeNull();
    // Without PUBLIC_URL there's nothing to link or play.
    const unlinked = renderedComponents(renderedMessage((await getReplay(db.sql, id))!, undefined));
    expect(unlinked.text).toContain("Set PUBLIC_URL");
    expect(unlinked.text.split("\n")[0]).toBe("**kiai - Public Song [Hard]**");
    expect(unlinked.video).toBeUndefined();
  });

  it("points the video at the public URL through a webhook too, without uploading it", async () => {
    const sent: Sent[] = [];
    const notifier = discordNotifier({ webhookUrl: "https://discord.com/api/webhooks/1/abc", publicUrl: "https://replays.example.com", fetch: discordFetch(sent) });
    const id = await renderedReplay(notifier);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).not.toHaveProperty("attachments");
    expect(renderedComponents(sent[0]!.body).video).toContain(`https://replays.example.com/r/${id}/video.mp4?v=`);
  });
});

describe("public replay app", () => {
  const app = () => createPublicApp({ sql: db.sql, media, publicUrl: "https://replays.example.com" });

  it("shows rendered replays with video embeds for Discord", async () => {
    const id = await renderedReplay();
    const page = await app().request(`/r/${id}`);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain(`<meta property="og:video" content="https://replays.example.com/r/${id}/video.mp4?v=`);
    expect(body).toContain('<meta property="og:title" content="kiai - Public Song [Hard]">');
    // "player", not "summary_large_image", or Discord shows a picture instead of the video.
    expect(body).toContain('<meta name="twitter:card" content="player">');
    expect(body).toContain(`<meta name="twitter:player:stream" content="https://replays.example.com/r/${id}/video.mp4?v=`);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await (await app().request("/")).text()).toContain(`/r/${id}`);

    // A plain page: no scripts, its colours in one style block that the CSP allows by hash.
    expect(body).not.toContain("<script");
    const style = /<style>([\s\S]*?)<\/style>/.exec(body)![1]!;
    const hash = createHash("sha256").update(style).digest("base64");
    expect(page.headers.get("content-security-policy")).toContain(`style-src 'self' 'sha256-${hash}'`);
    const palette = (await getReplay(db.sql, id))!.palette!;
    expect(style).toContain(`--accent:${palette.accent}`);
    expect(body).toContain(`<meta name="theme-color" content="${palette.accent}">`);
    expect(body).toContain("kiai - Public Song <span>[Hard]</span>");
    expect(body).toMatch(/<dt>mods<\/dt><dd>DT[^<]*<\/dd>/);
    expect(body).toContain("<dt>pp</dt>");
    expect(body).toContain("hosted with hate and malice from Dallas, Texas");

    const video = await app().request(`/r/${id}/video.mp4?v=1`, { headers: { range: "bytes=0-99" } });
    expect(video.status).toBe(206);
    expect(video.headers.get("content-range")).toBe("bytes 0-99/4096");
  });

  it("makes up colours for replays rendered before palettes, and ignores bad ones", async () => {
    const id = await renderedReplay();
    await db.sql`update replays set palette = null where id = ${id}`;
    const plain = await (await app().request(`/r/${id}`)).text();
    expect(plain).toContain(`--accent:${mapPalette({ seed: MAP_MD5 }).accent}`);
    await db.sql`update replays set palette = ${db.sql.json({ ...mapPalette({ seed: "x" }), accent: "red;}body{display:none" })} where id = ${id}`;
    const tampered = await (await app().request(`/r/${id}`)).text();
    expect(tampered).not.toContain("display:none");
    expect(tampered).toContain(`--accent:${mapPalette({ seed: MAP_MD5 }).accent}`);
  });

  it("knows nothing about unrendered replays or anything private", async () => {
    const { id } = await saveReplay(db.sql, media, buildOsr({ beatmapMd5: MAP_MD5 }), null);
    await enqueueRender(db.sql, id, "default");
    expect((await app().request(`/r/${id}`)).status).toBe(404);
    expect((await app().request(`/r/${id}/video.mp4`)).status).toBe(404);
    for (const privatePath of ["/api/scores", "/replays", `/replays/${id}`, "/api/replays", "/scores/1", "/sync"]) {
      expect((await app().request(privatePath)).status, privatePath).toBe(404);
    }
    expect((await app().request("/api/replays", { method: "POST" })).status).toBe(405);
  });
});

describe("replay gallery", () => {
  const ids: Record<string, string> = {};
  const keyOf = (id: string) => Object.entries(ids).find(([, value]) => value === id)?.[0] ?? id;
  const find = async (query: string) => (await listGallery(db.sql, parseScoreFilters(new URLSearchParams(query)))).replays.map((r) => keyOf(r.id));
  const findSorted = async (query: string) => (await find(query)).sort();

  let nextScoreId = 7_000_000_000;
  /** A replay with a finished render, optionally on a known map and linked to a library play with this pp. */
  async function seed(key: string, osr: OsrOptions, link: { beatmapId?: number; scorePp?: number } = {}) {
    const { id } = await saveReplay(db.sql, media, buildOsr({ beatmapMd5: md5Of(key), ...osr }), null);
    await db.sql`insert into render_jobs (replay_id, preset, status, video_path) values (${id}, 'default', 'success', ${`videos/${id}.mp4`})`;
    if (link.beatmapId) await db.sql`update replays set beatmap_id = ${link.beatmapId} where id = ${id}`;
    if (link.scorePp !== undefined) {
      const scoreId = nextScoreId++;
      await db.sql`insert into scores (id, user_id, beatmap_id, ended_at, rank, accuracy, total_score, max_combo, pp)
        values (${scoreId}, ${USER_ID}, ${link.beatmapId!}, now(), 'S', 1, 1, 1, ${link.scorePp})`;
      await db.sql`update replays set score_id = ${scoreId} where id = ${id}`;
    }
    ids[key] = id;
  }

  beforeEach(async () => {
    await upsertBeatmaps(db.sql, [beatmapRow(beatmap(1))!, beatmapRow(beatmap(2, { status: "loved", difficulty_rating: 7 }))!]);
    // Rendered through the pipeline: DT on a map osu! doesn't know, pp estimated by rosu-pp.
    ids.dt = await renderedReplay();
    await db.sql`update replays set played_at = '2026-09-01T00:00:00Z' where id = ${ids.dt}`;
    await seed("hdhr", { modBits: 8 | 16, counts: [500, 0, 0, 0, 0, 0], playedAt: new Date("2026-09-05T00:00:00Z") }, { beatmapId: 1, scorePp: 300 });
    await seed("nm", { counts: [90, 10, 0, 0, 0, 0], playedAt: new Date("2026-09-04T00:00:00Z") }, { beatmapId: 1, scorePp: 200 });
    await seed("nc", { modBits: 64 | 512, playedAt: new Date("2026-09-03T00:00:00Z") }, { beatmapId: 2 });
    await seed("friend", { playerName: "friend", playedAt: new Date("2026-09-02T00:00:00Z") }, { beatmapId: 1 });

    // Never shown: not rendered yet, or being rendered again.
    const queued = await saveReplay(db.sql, media, buildOsr({ beatmapMd5: md5Of("queued") }), null);
    await enqueueRender(db.sql, queued.id, "default");
    await seed("rerendering", {});
    await enqueueRender(db.sql, ids.rerendering!, "default");
  });

  it("lists rendered replays from every player, newest play first", async () => {
    expect(await find("")).toEqual(["hdhr", "nm", "nc", "friend", "dt"]);
    expect(await find("order=asc")).toEqual(["dt", "friend", "nc", "nm", "hdhr"]);
    expect((await find("sort=pp"))[0]).toBe("hdhr");
  });

  it("filters with the score library's filters", async () => {
    expect(await findSorted("q=public song")).toEqual(["dt"]); // title from the .osu file
    expect(await findSorted("q=title 1")).toEqual(["friend", "hdhr", "nm"]);
    expect(await findSorted("mods=DT")).toEqual(["dt", "nc"]); // DT also matches NC
    expect(await findSorted("mods=DT&mods_exact=true")).toEqual(["dt"]);
    expect(await findSorted("mods_excluded=HR")).toEqual(["dt", "friend", "nc", "nm"]);
    expect(await findSorted("nomod=true")).toEqual(["friend", "nm"]);
    expect(await findSorted("rank=SS")).toEqual(["hdhr"]); // XH
    expect(await findSorted("rank=A")).toEqual(["nm"]);
    expect(await findSorted("min_pp=250")).toEqual(["hdhr"]);
    expect(await findSorted("min_pp=1")).toEqual(["dt", "hdhr", "nm"]); // osu!'s pp, else the estimate
    expect(await findSorted("min_stars=6")).toEqual(["nc"]); // unknown maps have no stars
    expect(await findSorted("status=loved")).toEqual(["nc"]);
    expect(await findSorted("min_rate=1.5")).toEqual(["dt", "nc"]);
    expect(await findSorted("beatmap_id=1")).toEqual(["friend", "hdhr", "nm"]);
    expect(await findSorted("date_from=2026-09-03T12:00:00Z")).toEqual(["hdhr", "nm"]);
  });

  it("keeps the best replay per map, and pages", async () => {
    const best = await listGallery(db.sql, parseScoreFilters(new URLSearchParams("best_only=true&sort=pp")));
    expect(best.replays.map((r) => keyOf(r.id))).toEqual(["hdhr", "dt", "nc"]);
    expect(best.pagination.total_count).toBe(3);

    const page2 = await listGallery(db.sql, parseScoreFilters(new URLSearchParams("page_size=2&page=2")));
    expect(page2.replays.map((r) => keyOf(r.id))).toEqual(["nc", "friend"]);
    expect(page2.pagination).toEqual({ page: 2, page_size: 2, total_count: 5, total_pages: 3 });
  });

  it("is the public home page", async () => {
    const app = createPublicApp({ sql: db.sql, media });
    const page = await app.request("/?mods=DT&page_size=1&sort=pp");
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('<input type="hidden" name="mods" value="DT">');
    expect(body).toContain(`/r/${ids.dt}`); // the estimate beats nc's missing pp
    expect(body).not.toContain(`/r/${ids.nc}`); // page 2
    expect(body).not.toContain(`/r/${ids.hdhr}`);
    expect(body).toContain('href="/?sort=pp&amp;page=2&amp;page_size=1&amp;mods=DT"');
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(await (await app.request("/?q=nothing-like-this")).text()).toContain("No replays match these filters.");
    expect((await app.request("/assets/app.js")).headers.get("content-type")).toContain("javascript");
  });
});
