// The render editor on the private app: presets, the rules that pick them, skins, and a dry run
// that shows which rule a replay would hit. Forms post back and redirect with a notice; the
// private guard (same-origin writes, private network) protects them like the rest of the app.
// Skin uploads from the client go through PUT /api/skins/:name with the upload token.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import type { Sql } from "../db/index.ts";
import { UserError } from "../errors.ts";
import type { MediaPaths } from "../media.ts";
import type { Player } from "../player.ts";
import { writeStreamLimited } from "../render/maps.ts";
import { replayTitle } from "../render/notify.ts";
import {
  addRule, BUILTIN_SKIN, choosePreset, DEFAULT_PRESET_NAME, deletePreset, deleteRule, deleteSkin, getPreset, installSkin,
  listPresets, listRules, listSkins, moveRule, savePreset, skinNameFrom, updateRule, type PresetChoice, type RenderPreset, type RenderRule,
} from "../render/presets.ts";
import { ruleFacts, type RuleFacts } from "../render/rules.ts";
import { updateReplayAttributes } from "../render/worker.ts";
import { getReplay, listReplays, type ReplayView } from "../replays/store.ts";
import { layout } from "./views.ts";

type Html = ReturnType<typeof html>;

const MAX_OSK_BYTES = 256 * 1024 * 1024;
const PRIVATE = { "Cache-Control": "private, no-store" };

export interface RenderSettingsDeps {
  sql: Sql;
  player: Player;
  media: MediaPaths;
  /** Checks the bearer token for machine uploads; throws an HTTP error response otherwise. */
  requireUploadToken: (c: Context) => Response | null;
}

export interface DryRun {
  replay: ReplayView;
  facts: RuleFacts;
  choice: PresetChoice;
  /** False when the map isn't on disk yet, so map-based conditions can't match. */
  hasAttributes: boolean;
}

/** Which preset a replay would get, working out its attributes first if the map is on disk. */
export async function dryRun(sql: Sql, media: MediaPaths, replayId: string): Promise<DryRun | null> {
  let replay = await getReplay(sql, replayId);
  if (!replay) return null;
  if (!replay.attributes && (await updateReplayAttributes(sql, media, replayId))) replay = (await getReplay(sql, replayId))!;
  const facts = ruleFacts(replay);
  return { replay, facts, choice: await choosePreset(sql, facts), hasAttributes: replay.attributes !== null };
}

// ---------- views ----------

const EXAMPLES = [
  ["HD and ar < 10.3", "Hidden on lower AR"],
  ["ar >= 10.3", "high AR (DT, HR+DT, ...)"],
  ["mods lacks HD and stars > 7", "hard maps without HD"],
  ["server = gatari.pw", "plays from a private server"],
  ["pp >= 400", "your best plays"],
];

function notices(c: Context): Html {
  const notice = c.req.query("notice");
  const error = c.req.query("error");
  return html`${notice ? html`<p class="notice" role="status">${notice}</p>` : ""}${error ? html`<p class="notice alert" role="alert">${error}</p>` : ""}`;
}

const presetOptions = (presets: readonly RenderPreset[], selected: string) =>
  presets.map((p) => html`<option value="${p.name}" ${p.name === selected ? html`selected` : ""}>${p.name}</option>`);

function rulesSection(rules: readonly RenderRule[], presets: readonly RenderPreset[]): Html {
  return html`<section class="card" aria-label="Rules">
    <h2>Rules</h2>
    <p class="muted small">Checked top to bottom; the first enabled rule that matches picks the preset. Conditions are joined with <code>and</code>:
      a mod (<code>HD</code>), <code>mods has DT</code> / <code>mods lacks HD</code>, numbers
      <code>ar od cs hp stars bpm length pp accuracy combo misses rate</code> with <code>&lt; &lt;= &gt; &gt;= = !=</code>
      (map values are after mods), and <code>server</code> (<code>official</code> for osu!'s), <code>player</code>, <code>rank</code> with <code>=</code> / <code>!=</code>.
      DT also matches NC.</p>
    ${rules.length === 0 ? html`<p class="muted">No rules yet: every replay uses the default preset.</p>` : ""}
    <ol class="rules">
      ${rules.map(
        (rule, i) => html`<li>
          <form method="post" action="/render/rules/${rule.id}" class="row wrap">
            <input name="expression" value="${rule.expression}" aria-label="Condition" class="grow" required>
            <span>→</span>
            <select name="preset" aria-label="Preset">${presetOptions(presets, rule.preset)}</select>
            <label class="check"><input type="checkbox" name="enabled" value="1" ${rule.enabled ? html`checked` : ""}> on</label>
            <button>Save</button>
            <button formaction="/render/rules/${rule.id}/move?direction=up" ${i === 0 ? html`disabled` : ""} title="Check earlier">↑</button>
            <button formaction="/render/rules/${rule.id}/move?direction=down" ${i === rules.length - 1 ? html`disabled` : ""} title="Check later">↓</button>
            <button formaction="/render/rules/${rule.id}/delete" class="dangerous">Delete</button>
          </form>
        </li>`,
      )}
    </ol>
    <p class="muted">Otherwise → <strong>${DEFAULT_PRESET_NAME}</strong></p>
    <form method="post" action="/render/rules" class="row wrap">
      <input name="expression" placeholder="HD and ar < 10.3" aria-label="New rule condition" class="grow" required list="rule-examples">
      <datalist id="rule-examples">${EXAMPLES.map(([example, label]) => html`<option value="${example}">${label}</option>`)}</datalist>
      <span>→</span>
      <select name="preset" aria-label="Preset">${presetOptions(presets, DEFAULT_PRESET_NAME)}</select>
      <button class="primary">Add rule</button>
    </form>
  </section>`;
}

function presetsSection(presets: readonly RenderPreset[], rules: readonly RenderRule[], skins: readonly string[]): Html {
  return html`<section class="card" aria-label="Presets">
    <h2>Presets</h2>
    <div class="tablewrap"><table class="scores">
      <thead><tr><th>Name</th><th>Skin</th><th>Description</th><th class="r">Rules</th></tr></thead>
      <tbody>${presets.map(
        (p) => html`<tr>
          <td><a href="/render/presets/${p.name}">${p.name}</a></td>
          <td>${p.skin}</td>
          <td class="muted">${p.description}</td>
          <td class="r">${rules.filter((r) => r.preset === p.name).length}</td>
        </tr>`,
      )}</tbody>
    </table></div>
    <details>
      <summary>New preset</summary>
      ${presetForm({ name: "", description: "", skin: BUILTIN_SKIN, patch: { Recording: { FrameWidth: 1920, FrameHeight: 1080, FPS: 60 } } }, skins, true)}
    </details>
  </section>`;
}

function presetForm(p: RenderPreset, skins: readonly string[], create: boolean): Html {
  return html`<form method="post" action="${create ? "/render/presets" : `/render/presets/${p.name}`}" class="stack">
    ${create ? html`<label>Name <input name="name" required pattern="[a-z0-9][a-z0-9_\\-]{0,31}" placeholder="hd"></label>` : ""}
    <label>Description <input name="description" value="${p.description}"></label>
    <label>Skin <select name="skin">
      <option value="${BUILTIN_SKIN}">danser's default</option>
      ${skins.map((skin) => html`<option value="${skin}" ${skin === p.skin ? html`selected` : ""}>${skin}</option>`)}
    </select></label>
    <label>danser settings patch (JSON; keys as in danser's <code>settings/default.json</code>)
      <textarea name="patch" rows="12" spellcheck="false">${JSON.stringify(p.patch, null, 2)}</textarea></label>
    <p class="muted small">Examples: <code>{"Recording": {"FrameWidth": 1280, "FrameHeight": 720}}</code>,
      <code>{"Recording": {"MotionBlur": {"Enabled": true}}}</code>. <code>General</code>, <code>Recording.OutputDir</code> and
      <code>Recording.Container</code> are set by kiai.</p>
    <button class="primary">${create ? "Create preset" : "Save"}</button>
  </form>`;
}

function skinsSection(skins: readonly string[], presets: readonly RenderPreset[]): Html {
  return html`<section class="card" aria-label="Skins">
    <h2>Skins</h2>
    ${skins.length === 0 ? html`<p class="muted">No skins uploaded; presets use danser's default skin.</p>` : ""}
    <ul class="plain">${skins.map((skin) => {
      const users = presets.filter((p) => p.skin === skin).map((p) => p.name);
      return html`<li class="row wrap"><span class="grow">${skin} ${users.length ? html`<span class="muted small">used by ${users.join(", ")}</span>` : ""}</span>
        <form method="post" action="/render/skins/${encodeURIComponent(skin)}/delete"><button class="dangerous" ${users.length ? html`disabled` : ""}>Delete</button></form></li>`;
    })}</ul>
    <form method="post" action="/render/skins" enctype="multipart/form-data" class="row wrap">
      <input type="file" name="file" accept=".osk,.zip" required aria-label="Skin file (.osk)">
      <input name="name" placeholder="Name (default: the file name)" aria-label="Skin name">
      <button>Upload skin</button>
    </form>
    <p class="muted small">Uploading a skin with an existing name replaces it. Large skins upload fastest over your LAN; <code>kiai skin upload &lt;file.osk&gt;</code> works too.</p>
  </section>`;
}

function dryRunSection(replays: readonly ReplayView[], result: DryRun | null, selected: string | undefined): Html {
  const facts = result?.facts;
  const shown = (value: unknown) => (value === null || value === undefined ? "—" : String(value));
  return html`<section class="card" aria-label="Dry run">
    <h2>Dry run</h2>
    <form method="get" action="/render" class="row wrap">
      <select name="replay" aria-label="Replay" class="grow">
        ${replays.map((r) => html`<option value="${r.id}" ${r.id === selected ? html`selected` : ""}>${replayTitle(r)} · ${r.player_name} · ${r.id}</option>`)}
      </select>
      <button>Which preset?</button>
    </form>
    ${result && facts
      ? html`<p><strong>${result.choice.preset.name}</strong> <span class="muted">(${result.choice.reason})</span></p>
        ${!result.hasAttributes ? html`<p class="alert small">The map isn't on the server yet, so map conditions (ar, stars, ...) don't match. It's fetched when the replay renders.</p>` : ""}
        <table class="kv"><tr><th>Mods</th><td>${facts.mods.join(" ") || "NM"}</td></tr>
          <tr><th>AR / OD / CS / HP</th><td>${shown(facts.ar)} / ${shown(facts.od)} / ${shown(facts.cs)} / ${shown(facts.hp)}</td></tr>
          <tr><th>Stars / BPM / length</th><td>${shown(facts.stars)} / ${shown(facts.bpm)} / ${shown(facts.length)}s</td></tr>
          <tr><th>pp / accuracy / combo / misses</th><td>${shown(facts.pp)} / ${facts.accuracy} / ${facts.combo} / ${facts.misses}</td></tr>
          <tr><th>Server / player / rank</th><td>${facts.server} / ${facts.player} / ${facts.rank}</td></tr></table>
        <ol class="small">${result.choice.checks.map(
          (check) => html`<li>${check.matched ? "✓" : "✗"} <code>${check.rule.expression || "always"}</code> → ${check.rule.preset}${check.error ? html` <span class="alert">${check.error}</span>` : ""}</li>`,
        )}</ol>`
      : replays.length === 0
        ? html`<p class="muted">Upload a replay to try the rules on it.</p>`
        : ""}
  </section>`;
}

// ---------- routes ----------

export function registerRenderSettingsRoutes(app: Hono, deps: RenderSettingsDeps): void {
  const { sql, media, player } = deps;

  /** Run a form action, then go back with a notice, or with the error if it was the user's. */
  const form = (back: (c: Context) => string, action: (c: Context) => Promise<string>) => async (c: Context) => {
    const target = back(c);
    let key = "notice";
    let message: string;
    try {
      message = await action(c);
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      key = "error";
      message = error.message;
    }
    if (key === "notice" && message.startsWith("/")) return c.redirect(message, 303);
    return c.redirect(`${target}${target.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(message)}`, 303);
  };
  const field = async (c: Context) => {
    const body = await c.req.parseBody();
    return (name: string) => (typeof body[name] === "string" ? (body[name] as string) : "");
  };
  const ruleId = (c: Context) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) throw new UserError("Unknown rule.");
    return id;
  };

  app.get("/render", async (c) => {
    const [presets, rules, skins, replays] = await Promise.all([listPresets(sql), listRules(sql), listSkins(media), listReplays(sql, 30)]);
    const selected = c.req.query("replay") ?? replays[0]?.id;
    const result = c.req.query("replay") && selected ? await dryRun(sql, media, selected) : null;
    return c.html(
      layout(
        "Render settings",
        html`${notices(c)}${rulesSection(rules, presets)}${dryRunSection(replays, result, selected)}${presetsSection(presets, rules, skins)}${skinsSection(skins, presets)}`,
        player,
      ),
      200,
      PRIVATE,
    );
  });

  app.get("/render/presets/:name", async (c) => {
    const preset = await getPreset(sql, c.req.param("name"));
    if (!preset) return c.html(layout("Not found", html`<section class="card narrow"><p>No such preset. <a href="/render">Back</a></p></section>`, player), 404);
    const skins = await listSkins(media);
    return c.html(
      layout(
        `Preset ${preset.name}`,
        html`<p><a href="/render">← Render settings</a></p>${notices(c)}
        <section class="card"><h1>Preset ${preset.name}</h1>${presetForm(preset, skins, false)}</section>
        ${preset.name !== DEFAULT_PRESET_NAME
          ? html`<section class="card"><form method="post" action="/render/presets/${preset.name}/delete"><button class="dangerous">Delete preset</button></form></section>`
          : html`<p class="muted small">The default preset is used when no rule matches, so it can't be deleted.</p>`}`,
        player,
      ),
      200,
      PRIVATE,
    );
  });

  app.post("/render/presets", form(() => "/render", async (c) => {
    const get = await field(c);
    await savePreset(sql, media, { name: get("name"), description: get("description"), skin: get("skin"), patch: get("patch") }, { create: true });
    return `/render/presets/${get("name").trim().toLowerCase()}?notice=${encodeURIComponent("Preset created.")}`;
  }));

  app.post("/render/presets/:name", form((c) => `/render/presets/${c.req.param("name")}`, async (c) => {
    const get = await field(c);
    await savePreset(sql, media, { name: c.req.param("name") ?? "", description: get("description"), skin: get("skin"), patch: get("patch") }, { create: false });
    return "Saved. New renders use it.";
  }));

  app.post("/render/presets/:name/delete", form((c) => `/render/presets/${c.req.param("name")}`, async (c) => {
    await deletePreset(sql, c.req.param("name") ?? "");
    return `/render?notice=${encodeURIComponent("Preset deleted.")}`;
  }));

  app.post("/render/rules", form(() => "/render", async (c) => {
    const get = await field(c);
    await addRule(sql, { expression: get("expression"), preset: get("preset") });
    return "Rule added at the bottom.";
  }));

  app.post("/render/rules/:id", form(() => "/render", async (c) => {
    const get = await field(c);
    await updateRule(sql, ruleId(c), { expression: get("expression"), preset: get("preset"), enabled: get("enabled") === "1" });
    return "Rule saved.";
  }));

  app.post("/render/rules/:id/move", form(() => "/render", async (c) => {
    await moveRule(sql, ruleId(c), c.req.query("direction") === "up" ? -1 : 1);
    return "Rule moved.";
  }));

  app.post("/render/rules/:id/delete", form(() => "/render", async (c) => {
    await deleteRule(sql, ruleId(c));
    return "Rule deleted.";
  }));

  app.post("/render/skins", form(() => "/render", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File) || file.size === 0) throw new UserError("Choose an .osk file to upload.");
    if (file.size > MAX_OSK_BYTES) throw new UserError("That skin is larger than 256 MB.");
    const name = (typeof body.name === "string" && body.name.trim()) || skinNameFrom(file.name);
    const upload = path.join(media.tmp, `skin-upload-${randomUUID()}.osk`);
    try {
      await writeStreamLimited(file.stream(), upload, MAX_OSK_BYTES, "The skin");
      return `Skin "${await installSkin(sql, media, upload, name)}" uploaded.`;
    } finally {
      await fs.rm(upload, { force: true });
    }
  }));

  app.post("/render/skins/:name/delete", form(() => "/render", async (c) => {
    const name = c.req.param("name") ?? "";
    await deleteSkin(sql, media, name);
    return `Skin "${name}" deleted.`;
  }));

  // ---------- JSON ----------

  app.get("/api/render/presets", async (c) => c.json({ presets: await listPresets(sql), skins: await listSkins(media) }, 200, PRIVATE));
  app.get("/api/render/rules", async (c) => c.json({ rules: await listRules(sql), fallback: DEFAULT_PRESET_NAME }, 200, PRIVATE));

  app.get("/api/render/dry-run", async (c) => {
    const result = await dryRun(sql, media, c.req.query("replay") ?? "");
    if (!result) return c.json({ error: "No such replay." }, 404);
    return c.json({ preset: result.choice.preset.name, reason: result.choice.reason, facts: result.facts, checks: result.choice.checks, map_known: result.hasAttributes }, 200, PRIVATE);
  });

  /** Upload a skin as the raw body (.osk), with the upload token. Replaces a skin of the same name. */
  app.put("/api/skins/:name", async (c) => {
    const denied = deps.requireUploadToken(c);
    if (denied) return denied;
    if (!c.req.raw.body) return c.json({ error: "Send the .osk as the request body." }, 400);
    if (Number(c.req.header("content-length")) > MAX_OSK_BYTES) return c.json({ error: "That skin is larger than 256 MB." }, 413);
    const upload = path.join(media.tmp, `skin-upload-${randomUUID()}.osk`);
    try {
      await writeStreamLimited(c.req.raw.body, upload, MAX_OSK_BYTES, "The skin");
      const name = await installSkin(sql, media, upload, decodeURIComponent(c.req.param("name") ?? ""));
      return c.json({ skin: name, skins: await listSkins(media) }, 200, PRIVATE);
    } finally {
      await fs.rm(upload, { force: true });
    }
  });
}
