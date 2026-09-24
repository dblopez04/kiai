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
import { getReplay, saveReplay } from "../src/replays/store.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { fakeOsu, osuFile, trackUser, USER_ID } from "./helpers/fake-osu.ts";
import { buildOsr, buildZip, md5Of } from "./helpers/replay-files.ts";

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

// A real, calculable map (40 circles at 120 BPM, AR9) with its metadata.
const MAP = osuFile().replace("[Difficulty]", "[Metadata]\nTitle:Public Song\nArtist:kiai\nCreator:mapper\nVersion:Hard\nBeatmapID:0\nBeatmapSetID:-1\n\n[Difficulty]");
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
    sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (url.endsWith("/users/@me/channels")) return Response.json({ id: "555" });
    return Response.json({ id: "1" });
  }) as typeof fetch;
}

/** Upload a replay of MAP (DT, 38/2/0/0), install the map, and render it. */
async function renderedReplay(notifier: ReturnType<typeof discordNotifier> = null): Promise<string> {
  await installOsz(db.sql, media, await writeZip(), "upload-test", "upload");
  const { id } = await saveReplay(db.sql, media, buildOsr({ beatmapMd5: MAP_MD5, modBits: 64, counts: [38, 2, 0, 0, 0, 0], maxCombo: 40 }), null);
  await enqueueRender(db.sql, id, "default");
  await runNextRender({ sql: db.sql, osu: fakeOsu(), paths: media, renderer: fakeRenderer, mirrors: [], playerId: USER_ID, notifier, log: () => {} });
  return id;
}

async function writeZip(): Promise<string> {
  const file = path.join(dir, "set.osz");
  await fs.writeFile(file, buildZip({ "map.osu": MAP, "audio.mp3": "x" }));
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

describe("Discord", () => {
  it("DMs through a bot, once per render, with the public link for Discord to unfurl", async () => {
    const sent: Sent[] = [];
    const notifier = discordNotifier({ botToken: "bot", userId: "123456789012345678", publicUrl: "https://replays.example.com", fetch: discordFetch(sent) });
    const id = await renderedReplay(notifier);
    expect(sent.map((s) => s.url)).toEqual(["https://discord.com/api/v10/users/@me/channels", "https://discord.com/api/v10/channels/555/messages"]);
    expect(sent[0]!.body).toEqual({ recipient_id: "123456789012345678" });
    const message = sent[1]!.body as { content: string; embeds: { title: string; url: string; description: string }[] };
    expect(message.content).toBe(`https://replays.example.com/r/${id}`);
    expect(message.embeds[0]).toMatchObject({ title: "kiai - Public Song [Hard]", url: `https://replays.example.com/r/${id}` });
    expect(message.embeds[0]!.description).toMatch(/^S · 96\.67% · 40x · \d+pp\* · DT 1\.5×$/);

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
    expect(sent[0]!.url).toBe("https://discord.com/api/webhooks/1/abc?wait=true");
    expect(sent[0]!.body.content).toContain("Render failed: **kiai - Public Song [Hard]**");
    expect(discordNotifier({})).toBeNull();
    // Without PUBLIC_URL there's nothing to link.
    expect(renderedMessage((await getReplay(db.sql, id))!, undefined).content).toContain("Set PUBLIC_URL");
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
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await (await app().request("/")).text()).toContain(`/r/${id}`);

    const video = await app().request(`/r/${id}/video.mp4?v=1`, { headers: { range: "bytes=0-99" } });
    expect(video.status).toBe(206);
    expect(video.headers.get("content-range")).toBe("bytes 0-99/4096");
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
