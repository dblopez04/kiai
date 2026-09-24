import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/http/app.ts";
import { ensureMediaDirs, mediaPaths, type MediaPaths } from "../src/media.ts";
import { resolvePlayer } from "../src/player.ts";
import type { RenderInput, Renderer } from "../src/render/danser.ts";
import { installOsz } from "../src/render/maps.ts";
import {
  addRule, choosePreset, deletePreset, deleteSkin, getPreset, installSkin, listRules, listSkins, moveRule, parsePatch, savePreset, updateRule,
} from "../src/render/presets.ts";
import { fieldValue, mergePatch, SETTING_GROUPS, settingsFromForm, withoutFormKeys } from "../src/render/settings-form.ts";
import { enqueueRender } from "../src/render/queue.ts";
import { matchesRule, parseRule, ruleFacts, type RuleFacts } from "../src/render/rules.ts";
import { runNextRender } from "../src/render/worker.ts";
import { getReplay, saveReplay } from "../src/replays/store.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { fakeOsu, osuFile, USER_ID } from "./helpers/fake-osu.ts";
import { buildOsr, buildZip, md5Of } from "./helpers/replay-files.ts";

const TOKEN = "test-upload-token-0123456789";
const ORIGIN = "http://localhost:8080";

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
  await db.sql`truncate osu_users, beatmaps, scores, replays, render_jobs, beatmap_files, render_rules cascade`;
  await db.sql`delete from render_presets where name <> 'default'`;
  await db.sql`update render_presets set skin = 'default', skip_intro = true,
    patch = '{"Recording": {"FrameWidth": 1920, "FrameHeight": 1080, "FPS": 60}}' where name = 'default'`;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kiai-presets-"));
  media = mediaPaths(dir);
  await ensureMediaDirs(media);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const MAP = osuFile().replace("[Difficulty]", "[Metadata]\nTitle:Rule Song\nArtist:kiai\nCreator:mapper\nVersion:Hard\n\n[Difficulty]");
const MAP_MD5 = md5Of(MAP);

function facts(overrides: Partial<RuleFacts> = {}): RuleFacts {
  return {
    mods: [], ar: 9, od: 8, cs: 4, hp: 5, stars: 5, bpm: 180, length: 90, pp: 250, accuracy: 98.5, combo: 500, misses: 0, rate: 1,
    server: "official", player: "tester", rank: "S", ...overrides,
  };
}

async function writeFile(name: string, content: Buffer | string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
}

const skinZip = (nested = false) => {
  const prefix = nested ? "My Skin/" : "";
  return buildZip({ [`${prefix}skin.ini`]: "[General]\nName: My Skin\n", [`${prefix}cursor.png`]: "png" });
};

describe("rule expressions", () => {
  it("parse the documented forms", () => {
    expect(parseRule("HD and ar < 10.3")).toEqual([
      { kind: "mod", acronym: "HD", has: true },
      { kind: "number", field: "ar", op: "<", value: 10.3 },
    ]);
    expect(parseRule("mods lacks HD and stars>=7")).toEqual([
      { kind: "mod", acronym: "HD", has: false },
      { kind: "number", field: "stars", op: ">=", value: 7 },
    ]);
    expect(parseRule("server = Gatari.pw and AR != 9")).toEqual([
      { kind: "text", field: "server", op: "=", value: "gatari.pw" },
      { kind: "number", field: "ar", op: "!=", value: 9 },
    ]);
    expect(parseRule("always")).toEqual([]);
    expect(parseRule("  ")).toEqual([]);
  });

  it("explain what's wrong", () => {
    expect(() => parseRule("hd and ar < 10")).toThrow(/Unknown condition "hd"/);
    expect(() => parseRule("ar < fast")).toThrow(/needs a number/);
    expect(() => parseRule("ar 10")).toThrow(/needs a comparison/);
    expect(() => parseRule("HD or DT")).toThrow(/Expected "and" before "or"/);
    expect(() => parseRule("HD and")).toThrow(/ends with "and"/);
    expect(() => parseRule("server < x")).toThrow(/compared with = or !=/);
    expect(() => parseRule("mods has")).toThrow(/mods has HD/);
  });

  it("match like the score filters do", () => {
    const match = (expression: string, f: Partial<RuleFacts>) => matchesRule(parseRule(expression), facts(f));
    expect(match("DT", { mods: ["NC", "HD"] })).toBe(true);
    expect(match("mods lacks DT", { mods: ["NC"] })).toBe(false);
    expect(match("HD and ar < 10.3", { mods: ["HD"], ar: 10.33 })).toBe(false);
    expect(match("HD and ar < 10.3", { mods: ["HD"], ar: 9.5 })).toBe(true);
    expect(match("ar >= 10.3", { ar: null })).toBe(false);
    expect(match("server = official", {})).toBe(true);
    expect(match("server != official", { server: "gatari.pw" })).toBe(true);
    expect(match("rank = ss and misses = 0", { rank: "SS" })).toBe(true);
    expect(match("always", {})).toBe(true);
  });

  it("see a replay's facts as the game shows them", () => {
    const f = ruleFacts({
      mods: [{ acronym: "hd" }], accuracy: 0.98765, max_combo: 321, countmiss: 2, devserver: null, player_name: "tester", rank: "XH",
      attributes: { stars: 6, ar: 10, od: 9, cs: 4, hp: 5, bpm: 200, length: 100, clock_rate: 1, max_combo: 400, pp: 300 }, score_pp: 310,
    });
    expect(f).toMatchObject({ mods: ["HD"], accuracy: 98.77, rank: "SS", server: "official", pp: 310, ar: 10 });
  });
});

describe("presets and rules", () => {
  it("pick the first matching enabled rule, else the default", async () => {
    await savePreset(db.sql, media, { name: "hd", description: "", skin: "default", patch: "{}" }, { create: true });
    await savePreset(db.sql, media, { name: "fast", description: "", skin: "default", patch: '{"Recording": {"FPS": 120}}' }, { create: true });
    const hd = await addRule(db.sql, { expression: "HD and ar < 10.3", preset: "hd" });
    await addRule(db.sql, { expression: "ar >= 10.3", preset: "fast" });

    expect(await choosePreset(db.sql, facts({ mods: ["HD"], ar: 9 }))).toMatchObject({ preset: { name: "hd" }, reason: "rule 1: HD and ar < 10.3" });
    expect(await choosePreset(db.sql, facts({ mods: ["HD"], ar: 10.33 }))).toMatchObject({ preset: { name: "fast", patch: { Recording: { FPS: 120 } } }, reason: "rule 2: ar >= 10.3" });
    expect(await choosePreset(db.sql, facts({ ar: 9 }))).toMatchObject({ preset: { name: "default" }, reason: "no rule matched" });

    await updateRule(db.sql, hd, { expression: "HD and ar < 10.3", preset: "hd", enabled: false });
    expect((await choosePreset(db.sql, facts({ mods: ["HD"], ar: 9 }))).preset.name).toBe("default");

    await moveRule(db.sql, hd, 1);
    expect((await listRules(db.sql)).map((r) => r.expression)).toEqual(["ar >= 10.3", "HD and ar < 10.3"]);
    await expect(addRule(db.sql, { expression: "HD or DT", preset: "hd" })).rejects.toThrow(/Expected "and"/);
    await expect(addRule(db.sql, { expression: "HD", preset: "nope" })).rejects.toThrow(/no preset named "nope"/);
  });

  it("validate presets and protect what's in use", async () => {
    expect(() => parsePatch("{nope")).toThrow(/isn't valid JSON/);
    expect(() => parsePatch("[1]")).toThrow(/must be a JSON object/);
    expect(() => parsePatch('{"General": {"OsuSongsDir": "/"}}')).toThrow(/can't change General/);
    expect(() => parsePatch('{"Recording": {"OutputDir": "/tmp"}}')).toThrow(/OutputDir/);
    const save = (name: string, skin = "default") => savePreset(db.sql, media, { name, description: "", skin, patch: "{}" }, { create: true });
    await expect(save("Bad Name")).rejects.toThrow(/lowercase letters/);
    await expect(save("hd", "Missing Skin")).rejects.toThrow(/no skin named "Missing Skin"/);
    await save("hd");
    await expect(save("hd")).rejects.toThrow(/already exists/);
    await addRule(db.sql, { expression: "HD", preset: "hd" });
    await expect(deletePreset(db.sql, "hd")).rejects.toThrow(/used by 1 rule/);
    await expect(deletePreset(db.sql, "default")).rejects.toThrow(/can't be deleted/);
  });
});

/** What a browser submits for the settings form showing `patch`: unchecked boxes are left out. */
function formOf(patch: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const field of SETTING_GROUPS.flatMap((group) => group.fields)) {
    const value = fieldValue(field, patch);
    if (value === true) fields[field.key] = "1";
    else if (value !== false) fields[field.key] = String(value);
  }
  return fields;
}

describe("settings form", () => {
  it("keeps only what differs from danser's defaults, and reads back what a patch sets", () => {
    const read = (fields: Record<string, string>) => settingsFromForm((name) => fields[name]);
    expect(read(formOf({}))).toEqual({});
    const patch = {
      Recording: { FrameWidth: 1280, FrameHeight: 720, FPS: 30, MotionBlur: { Enabled: true } },
      Audio: { MusicVolume: 0.3 },
      Gameplay: { ScoreBoard: { Show: false } },
      Skin: { Cursor: { Scale: 0.75 } },
    };
    expect(read(formOf(patch))).toEqual(patch);
    // A value the menus don't list (set in JSON) survives a save.
    expect(read(formOf({ Recording: { FPS: 75, FrameWidth: 1000, FrameHeight: 1000 } }))).toEqual({ Recording: { FPS: 75, FrameWidth: 1000, FrameHeight: 1000 } });
    // danser's defaults drop out: the seeded default preset's 1080p60 is danser's own.
    expect(read(formOf({ Recording: { FrameWidth: 1920, FrameHeight: 1080, FPS: 60 } }))).toEqual({});

    expect(() => read({ ...formOf({}), "Audio.MusicVolume": "loud" })).toThrow(/Music volume needs a number/);
    expect(() => read({ ...formOf({}), "Audio.MusicVolume": "150" })).toThrow(/between 0 and 100/);
    expect(() => read({ ...formOf({}), "Recording.Resolution": "huge" })).toThrow(/look like 1920x1080/);
  });

  it("leaves the keys it doesn't cover to the JSON box", () => {
    const patch = { Recording: { FPS: 120, h264_nvenc: { CQ: 26 } }, Gameplay: { Score: { Show: false } }, Cursor: { TrailStyle: 3 } };
    expect(withoutFormKeys(patch)).toEqual({ Recording: { h264_nvenc: { CQ: 26 } }, Cursor: { TrailStyle: 3 } });
    expect(mergePatch({ Recording: { FPS: 60, FrameWidth: 1280 } }, { Recording: { FPS: 120 } })).toEqual({ Recording: { FPS: 120, FrameWidth: 1280 } });
  });
});

describe("skins", () => {
  it("unpack .osk files, flattening a wrapping folder", async () => {
    expect(await installSkin(db.sql, media, await writeFile("a.osk", skinZip(true)), "My Skin")).toBe("My Skin");
    expect((await fs.readdir(path.join(media.skins, "My Skin"))).sort()).toEqual(["cursor.png", "skin.ini"]);
    await installSkin(db.sql, media, await writeFile("b.osk", skinZip()), "Other");
    expect(await listSkins(media)).toEqual(["My Skin", "Other"]);
    await expect(installSkin(db.sql, media, await writeFile("c.osk", buildZip({ "readme.txt": "x" })), "Nothing")).rejects.toThrow(/no skin files/);
    await expect(installSkin(db.sql, media, await writeFile("d.osk", skinZip()), "../escape")).rejects.toThrow(/can't be a skin name/);
    await expect(installSkin(db.sql, media, await writeFile("e.osk", skinZip()), "default")).rejects.toThrow(/can't be a skin name/);

    await savePreset(db.sql, media, { name: "skinned", description: "", skin: "My Skin", patch: "{}" }, { create: true });
    await expect(deleteSkin(db.sql, media, "My Skin")).rejects.toThrow(/used by preset\(s\) skinned/);
    await deleteSkin(db.sql, media, "Other");
    expect(await listSkins(media)).toEqual(["My Skin"]);
  });
});

/** Records the preset each render got. */
function recordingRenderer(): Renderer & { inputs: RenderInput[] } {
  const inputs: RenderInput[] = [];
  return {
    inputs,
    async render(input) {
      inputs.push(input);
      const out = path.join(media.videos, `${input.outputName}.mp4`);
      await fs.writeFile(out, "video");
      return out;
    },
  };
}

async function replayOfMap(modBits: number, data: string): Promise<string> {
  await installOsz(db.sql, media, await writeFile("set.osz", buildZip({ "map.osu": MAP, "audio.mp3": "x" })), "upload-rules", "upload");
  const { id } = await saveReplay(db.sql, media, buildOsr({ beatmapMd5: MAP_MD5, modBits, counts: [40, 0, 0, 0, 0, 0], maxCombo: 40, data: Buffer.from(data) }), null);
  return id;
}

const run = (renderer: Renderer) =>
  runNextRender({ sql: db.sql, osu: fakeOsu(), paths: media, renderer, mirrors: [], playerId: USER_ID, log: () => {} });

describe("rendering with presets", () => {
  it("uses the preset the rules pick once the map's attributes are known", async () => {
    await installSkin(db.sql, media, await writeFile("s.osk", skinZip()), "Fast Skin");
    await savePreset(db.sql, media, { name: "fast", description: "", skin: "Fast Skin", patch: '{"Recording": {"FrameWidth": 1280, "FrameHeight": 720}}' }, { create: true });
    await addRule(db.sql, { expression: "DT and ar >= 10", preset: "fast" });

    const dt = await replayOfMap(64, "dt");
    const nomod = await replayOfMap(0, "nm");
    await enqueueRender(db.sql, dt, null);
    await enqueueRender(db.sql, nomod, null);
    const renderer = recordingRenderer();
    await run(renderer);
    await run(renderer);

    expect(renderer.inputs.map((i) => [i.preset.name, i.preset.skin])).toEqual([["fast", "Fast Skin"], ["default", "default"]]);
    expect((await getReplay(db.sql, dt))?.render).toMatchObject({ preset: "fast", preset_reason: "rule 1: DT and ar >= 10", video_width: 1280, video_height: 720 });
    expect((await getReplay(db.sql, nomod))?.render).toMatchObject({ preset: "default", preset_reason: "no rule matched", video_width: 1920 });
  });

  it("keeps a preset chosen by hand, and fails clearly when its skin is gone", async () => {
    await installSkin(db.sql, media, await writeFile("s.osk", skinZip()), "Gone Soon");
    await savePreset(db.sql, media, { name: "manual", description: "", skin: "Gone Soon", patch: "{}" }, { create: true });
    const id = await replayOfMap(0, "manual");
    await enqueueRender(db.sql, id, "manual");
    await run(recordingRenderer());
    expect((await getReplay(db.sql, id))?.render).toMatchObject({ preset: "manual", preset_reason: "chosen by hand", status: "success" });

    await fs.rm(path.join(media.skins, "Gone Soon"), { recursive: true });
    await enqueueRender(db.sql, id, "manual");
    await run(recordingRenderer());
    expect((await getReplay(db.sql, id))?.render).toMatchObject({ status: "failed", error: expect.stringContaining('skin "Gone Soon", which isn\'t uploaded') });
  });
});

describe("render editor", () => {
  let app: Hono;
  const request = (p: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "localhost:8080");
    if (init.method && init.method !== "GET") headers.set("origin", headers.get("origin") ?? ORIGIN);
    return app.request(`${ORIGIN}${p}`, { ...init, headers });
  };
  const post = (p: string, fields: Record<string, string>, origin = ORIGIN) =>
    request(p, { method: "POST", body: new URLSearchParams(fields), headers: { origin, "content-type": "application/x-www-form-urlencoded" } });
  const location = (response: Response) => decodeURIComponent(response.headers.get("location") ?? "");

  beforeEach(async () => {
    const player = await resolvePlayer(db.sql, fakeOsu(), "tester");
    app = createApp({ sql: db.sql, osu: null, player, media, config: { RECENT_WINDOW_HOURS: 24, PRIVATE_HOSTS: [], UPLOAD_TOKEN: TOKEN } });
  });

  it("edits rules and presets through forms, with errors shown on the page", async () => {
    const created = await post("/render/presets", { name: "hd", description: "Hidden", skin: "default", patch: '{"Recording": {"FPS": 60}}' });
    expect(created.status).toBe(303);
    expect(location(created)).toBe("/render/presets/hd?notice=Preset created.");
    expect(await (await request("/render/presets/hd")).text()).toContain("Hidden");

    expect(location(await post("/render/rules", { expression: "HD and ar < 10.3", preset: "hd" }))).toContain("notice=Rule added");
    expect(location(await post("/render/rules", { expression: "HD or DT", preset: "hd" }))).toContain('error=Expected "and" before "or"');
    expect(location(await post("/render/presets/hd", { description: "x", skin: "default", patch: "{oops" }))).toMatch(/^\/render\/presets\/hd\?error=.*isn't valid JSON/);
    expect((await post("/render/rules", { expression: "HD", preset: "hd" }, "https://evil.example")).status).toBe(403);

    const page = await (await request("/render?error=Nope")).text();
    expect(page).toContain('value="HD and ar &lt; 10.3"');
    expect(page).toContain("Nope");
    const [rule] = await listRules(db.sql);
    expect(location(await post(`/render/rules/${rule!.id}/delete`, {}))).toContain("Rule deleted");
    expect(await listRules(db.sql)).toEqual([]);
  });

  it("starts new presets from the default preset's settings", async () => {
    await savePreset(db.sql, media, { name: "default", description: "", skin: "default", patch: '{"Gameplay": {"ScoreBoard": {"Show": false}}, "Cursor": {"TrailStyle": 3}}', skipIntro: false }, { create: false });
    const page = await (await request("/render/presets/new")).text();
    expect(page).toMatch(/name="Gameplay\.ScoreBoard\.Show" value="1"\s*>/);
    expect(page).toMatch(/name="Gameplay\.Score\.Show" value="1"\s*checked>/);
    expect(page).toMatch(/name="skip_intro" value="1"\s*>/);
    expect(page).toContain("&quot;TrailStyle&quot;: 3");

    // Submitted with one change: the inherited leaderboard stays off, and the PP counter is unticked.
    const fields = formOf({ Gameplay: { ScoreBoard: { Show: false }, PPCounter: { Show: false } } });
    const created = await post("/render/presets?from=default", { form: "settings", name: "clean", description: "", skin: "default", advanced: '{"Cursor": {"TrailStyle": 3}}', ...fields });
    expect(location(created)).toBe("/render/presets/clean?notice=Preset created.");
    expect(await getPreset(db.sql, "clean")).toMatchObject({
      skipIntro: false,
      patch: { Gameplay: { ScoreBoard: { Show: false }, PPCounter: { Show: false } }, Cursor: { TrailStyle: 3 } },
    });
    // The Copy link starts from another preset.
    expect(await (await request("/render/presets/new?from=clean")).text()).toMatch(/name="Gameplay\.PPCounter\.Show" value="1"\s*>/);

    // A bare JSON patch goes over the default preset too.
    await post("/render/presets", { name: "json", description: "", skin: "", patch: '{"Recording": {"FPS": 120}}' });
    expect(await getPreset(db.sql, "json")).toMatchObject({ skipIntro: false, patch: { Gameplay: { ScoreBoard: { Show: false } }, Recording: { FPS: 120 } } });

    // Errors go back to the new-preset page.
    expect(location(await post("/render/presets?from=clean", { form: "settings", name: "new", skin: "default", ...fields }))).toMatch(/^\/render\/presets\/new\?from=clean&error="new" can't be a preset name/);
    expect(location(await post("/render/presets/clean", { form: "settings", skin: "default", ...fields, "Audio.MusicVolume": "x" }))).toContain("error=Music volume needs a number");
  });

  it("uploads skins from the page and from the client", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(skinZip())], "Cool Skin.osk"));
    const uploaded = await request("/render/skins", { method: "POST", body: form });
    expect(location(uploaded)).toContain('Skin "Cool Skin" uploaded.');

    const put = (token: string | null) =>
      request("/api/skins/Client%20Skin", { method: "PUT", body: new Uint8Array(skinZip(true)), headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await put(null)).status).toBe(401);
    const ok = await put(TOKEN);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ skin: "Client Skin", skins: ["Client Skin", "Cool Skin"] });
  });

  it("dry-runs the rules on a replay", async () => {
    await savePreset(db.sql, media, { name: "fast", description: "", skin: "default", patch: "{}" }, { create: true });
    await addRule(db.sql, { expression: "DT and ar >= 10", preset: "fast" });
    const id = await replayOfMap(64, "dry");
    const page = await (await request(`/render?replay=${id}`)).text();
    expect(page).toContain("<strong>fast</strong>");
    expect(page).toContain("rule 1: DT and ar &gt;= 10");
    const json = await (await request(`/api/render/dry-run?replay=${id}`)).json();
    expect(json).toMatchObject({ preset: "fast", map_known: true, facts: { ar: 10.33, mods: ["DT"] } });
    expect((await request("/api/render/dry-run?replay=nosuchone1")).status).toBe(404);
  });

  it("re-renders a replay with a chosen preset", async () => {
    await savePreset(db.sql, media, { name: "hd", description: "", skin: "default", patch: "{}" }, { create: true });
    const id = await replayOfMap(0, "again");
    expect(await (await request(`/replays/${id}`)).text()).toContain('<option value="hd">Preset: hd</option>');
    expect((await post(`/replays/${id}/render`, { preset: "hd" })).status).toBe(303);
    expect((await getReplay(db.sql, id))?.render).toMatchObject({ preset: "hd", preset_reason: "chosen by hand", status: "queued" });
    expect(await (await request(`/replays/${id}`)).text()).toContain("chosen by hand");
    expect((await post(`/replays/${id}/render`, { preset: "nope" })).status).toBe(400);
  });
});
