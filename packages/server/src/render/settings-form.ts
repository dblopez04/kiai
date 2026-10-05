// The danser settings the preset editor shows as checkboxes, menus and number fields. Each field
// is one key of danser 0.11's settings JSON with danser's own default, so a preset's patch keeps
// only what differs from danser. Keys the form doesn't cover stay editable as JSON.

import { UserError } from "../errors.ts";

export type Patch = Record<string, unknown>;

interface FieldBase {
  /** The dotted path in danser's settings, which is also the form field's name. */
  key: string;
  label: string;
  hint?: string;
}

export type SettingField =
  | (FieldBase & { kind: "check"; default: boolean })
  /** Stored 0..1, shown as 0..100 %. */
  | (FieldBase & { kind: "percent"; default: number })
  | (FieldBase & { kind: "number"; default: number; min: number; max: number; step: number })
  | (FieldBase & { kind: "select"; default: number; options: readonly (readonly [number, string])[]; min: number; max: number })
  /** Recording.FrameWidth × Recording.FrameHeight as one menu. */
  | (FieldBase & { kind: "resolution"; default: string; options: readonly (readonly [string, string])[] });

export interface SettingGroup {
  id: string;
  title: string;
  fields: readonly SettingField[];
}

const check = (key: string, label: string, def: boolean, hint?: string): SettingField => ({ kind: "check", key, label, default: def, ...(hint ? { hint } : {}) });
const percent = (key: string, label: string, def: number): SettingField => ({ kind: "percent", key, label, default: def });

export const RESOLUTION_KEY = "Recording.Resolution";

export const SETTING_GROUPS: readonly SettingGroup[] = [
  {
    id: "video",
    title: "Video",
    fields: [
      {
        kind: "resolution",
        key: RESOLUTION_KEY,
        label: "Resolution",
        default: "1920x1080",
        options: [["854x480", "480p"], ["1280x720", "720p"], ["1920x1080", "1080p"], ["2560x1440", "1440p (slower)"], ["3840x2160", "4K (much slower)"]],
      },
      { kind: "select", key: "Recording.FPS", label: "Frame rate", default: 60, options: [[30, "30 fps"], [60, "60 fps"], [120, "120 fps"], [240, "240 fps"]], min: 1, max: 1000 },
      check("Recording.MotionBlur.Enabled", "Motion blur", false, "Draws 16 frames for each one: many times slower."),
      check("Gameplay.ShowResultsScreen", "Results screen at the end", true),
      check("Playfield.Logo.Enabled", "danser logo in the intro", true, "Shown during the lead-in, even when skipping the intro."),
    ],
  },
  {
    id: "audio",
    title: "Audio",
    fields: [
      percent("Audio.GeneralVolume", "Master volume", 0.5),
      percent("Audio.MusicVolume", "Music volume", 0.5),
      percent("Audio.SampleVolume", "Hitsound volume", 0.5),
      check("Audio.IgnoreBeatmapSamples", "Skin hitsounds instead of the map's", false),
      check("Audio.PlayNightcoreSamples", "Nightcore beat", true),
    ],
  },
  {
    id: "skin",
    title: "Skin and cursor",
    fields: [
      check("Skin.Cursor.UseSkinCursor", "Skin's cursor", false),
      check("Skin.UseColorsFromSkin", "Skin's combo colours", false),
      check("Skin.UseBeatmapColors", "Beatmap's combo colours", false),
      { kind: "number", key: "Skin.Cursor.Scale", label: "Cursor size", default: 1, min: 0.1, max: 3, step: 0.05 },
      check("Cursor.ScaleToCS", "Scale cursor with circle size", false),
      check("Cursor.Colors.EnableRainbow", "Rainbow cursor", true),
      check("Cursor.EnableTrailGlow", "Cursor trail glow", true),
      check("Cursor.CursorRipples", "Cursor ripples", false),
    ],
  },
  {
    id: "hud",
    title: "HUD",
    fields: [
      check("Gameplay.Score.Show", "Score", true),
      check("Gameplay.HpBar.Show", "HP bar", true),
      check("Gameplay.ComboCounter.Show", "Combo", true),
      check("Gameplay.PPCounter.Show", "PP counter", true),
      check("Gameplay.HitCounter.Show", "Hit counts", true),
      check("Gameplay.KeyOverlay.Show", "Key overlay", true),
      check("Gameplay.HitErrorMeter.Show", "Hit error meter", true),
      check("Gameplay.HitErrorMeter.ShowUnstableRate", "Unstable rate", true),
      check("Gameplay.AimErrorMeter.Show", "Aim error meter", false),
      check("Gameplay.StrainGraph.Show", "Strain graph", true),
      check("Gameplay.ScoreBoard.Show", "Leaderboard", true),
      check("Gameplay.Mods.Show", "Mod icons", true),
      check("Gameplay.Boundaries.Enabled", "Playfield border", true),
    ],
  },
  {
    id: "objects",
    title: "Hit objects",
    fields: [
      check("Objects.DrawFollowPoints", "Follow points", true),
      check("Objects.DrawComboNumbers", "Combo numbers", true),
      check("Objects.ScaleToTheBeat", "Pulse to the beat", false),
      check("Objects.Sliders.SliderMerge", "Merge sliders", false),
      check("Objects.Sliders.Snaking.In", "Snaking sliders (in)", true),
      check("Objects.Sliders.Snaking.Out", "Snaking sliders (out)", true),
    ],
  },
  {
    id: "background",
    title: "Background",
    fields: [
      percent("Playfield.Background.Dim.Intro", "Dim in the intro", 0),
      percent("Playfield.Background.Dim.Normal", "Dim while playing", 0.95),
      percent("Playfield.Background.Dim.Breaks", "Dim in breaks", 0.5),
      check("Playfield.Background.Blur.Enabled", "Blur", false),
      check("Playfield.Background.Parallax.Enabled", "Parallax", true),
      check("Playfield.Background.LoadStoryboards", "Storyboards", true),
      check("Playfield.Background.LoadVideos", "Background videos", false),
      check("Playfield.SeizureWarning.Enabled", "Seizure warning", true),
    ],
  },
];

// Every other on/off setting danser 0.11 has that can change a replay video, with danser's
// default (from settings.NewConfigFile). Left out: General (kiai sets it), Graphics and Input
// (danser's own window and live play), CursorDance and Knockout (danser's other modes).
/** [group id, title, key prefix the labels leave out, [key, default][]]. */
const TOGGLES: readonly (readonly [string, string, string, readonly (readonly [string, boolean])[]])[] = [
  ["audio", "Audio", "Audio", [
    ["Audio.OnlineOffset", false], ["Audio.IgnoreBeatmapSampleVolume", false], ["Audio.BeatUseTimingPoints", false],
  ]],
  ["gameplay", "Gameplay and HUD", "Gameplay", [
    ["Gameplay.HitErrorMeter.ShowPositionalMisses", true], ["Gameplay.HitErrorMeter.StaticUnstableRate", false], ["Gameplay.HitErrorMeter.ScaleWithSpeed", false],
    ["Gameplay.AimErrorMeter.ShowUnstableRate", false], ["Gameplay.AimErrorMeter.StaticUnstableRate", false], ["Gameplay.AimErrorMeter.CapPositionalMisses", true],
    ["Gameplay.AimErrorMeter.AngleNormalized", false],
    ["Gameplay.Score.ShowGradeAlways", false], ["Gameplay.Score.StaticScore", false], ["Gameplay.Score.StaticAccuracy", false],
    ["Gameplay.ComboCounter.Static", false],
    ["Gameplay.PPCounter.ShowInResults", true], ["Gameplay.PPCounter.ShowPPComponents", false], ["Gameplay.PPCounter.Static", false],
    ["Gameplay.HitCounter.Vertical", false], ["Gameplay.HitCounter.Show300", false], ["Gameplay.HitCounter.ShowSliderBreaks", false],
    ["Gameplay.StrainGraph.Outline.Show", false],
    ["Gameplay.ScoreBoard.ModsOnly", false], ["Gameplay.ScoreBoard.AlignRight", false], ["Gameplay.ScoreBoard.HideOthers", false], ["Gameplay.ScoreBoard.ShowAvatars", false],
    ["Gameplay.Mods.HideInReplays", false], ["Gameplay.Mods.FoldInReplays", false], ["Gameplay.Mods.ShowLazerMod", true],
    ["Gameplay.Underlay.AboveHpBar", false],
    ["Gameplay.ResultsUseLocalTimeZone", false], ["Gameplay.ShowWarningArrows", true], ["Gameplay.ShowHitLighting", false],
    ["Gameplay.IgnoreFailsInReplays", false], ["Gameplay.LazerClassicScore", false],
  ]],
  ["skin", "Skin", "Skin", [
    ["Skin.Cursor.ForceLongTrail", false],
  ]],
  ["cursor", "Cursor", "Cursor", [
    ["Cursor.Colors.EnableCustomHueOffset", false], ["Cursor.Colors.FlashToTheBeat", false], ["Cursor.EnableCustomTagColorOffset", true],
    ["Cursor.EnableCustomTrailGlowOffset", true], ["Cursor.CursorExpand", false], ["Cursor.ScaleToTheBeat", false],
    ["Cursor.ShowCursorsOnBreaks", true], ["Cursor.BounceOnEdges", false], ["Cursor.AdditiveBlending", true], ["Cursor.SmokeEnabled", true],
  ]],
  ["objects", "Hit objects", "Objects", [
    ["Objects.DrawApproachCircles", true], ["Objects.LoadSpinners", true], ["Objects.StackEnabled", true],
    ["Objects.Sliders.ForceSliderBallTexture", true], ["Objects.Sliders.DrawEndCircles", true], ["Objects.Sliders.DrawSliderFollowCircle", true],
    ["Objects.Sliders.DrawScorePoints", true], ["Objects.Sliders.Distortions.Enabled", true], ["Objects.Sliders.Distortions.UseCustomResolution", false],
    ["Objects.Sliders.Snaking.OutFadeInstant", true],
  ]],
  ["object-colors", "Hit object colours", "Objects.Colors", [
    ["Objects.Colors.Color.EnableRainbow", true], ["Objects.Colors.Color.EnableCustomHueOffset", false], ["Objects.Colors.Color.FlashToTheBeat", false],
    ["Objects.Colors.UseComboColors", false], ["Objects.Colors.UseSkinComboColors", false], ["Objects.Colors.UseBeatmapComboColors", false],
    ["Objects.Colors.Sliders.WhiteScorePoints", true], ["Objects.Colors.Sliders.SliderBallTint", false],
    ["Objects.Colors.Sliders.Border.UseHitCircleColor", false], ["Objects.Colors.Sliders.Border.Color.EnableRainbow", false],
    ["Objects.Colors.Sliders.Border.Color.EnableCustomHueOffset", false], ["Objects.Colors.Sliders.Border.Color.FlashToTheBeat", false],
    ["Objects.Colors.Sliders.Border.EnableCustomGradientOffset", true],
    ["Objects.Colors.Sliders.Body.UseHitCircleColor", true], ["Objects.Colors.Sliders.Body.Color.EnableRainbow", false],
    ["Objects.Colors.Sliders.Body.Color.EnableCustomHueOffset", false], ["Objects.Colors.Sliders.Body.Color.FlashToTheBeat", true],
  ]],
  ["playfield", "Playfield", "Playfield", [
    ["Playfield.DrawObjects", true], ["Playfield.DrawCursors", true], ["Playfield.OsuShift", false],
    ["Playfield.ScaleStoryboardWithPlayfield", false], ["Playfield.MoveStoryboardWithPlayfield", false],
    ["Playfield.Background.FlashToTheBeat", false], ["Playfield.Background.Triangles.Enabled", false],
    ["Playfield.Background.Triangles.Shadowed", true], ["Playfield.Background.Triangles.DrawOverBlur", true],
    ["Playfield.Logo.DrawSpectrum", false], ["Playfield.Bloom.Enabled", false], ["Playfield.Bloom.BloomToTheBeat", true],
  ]],
];

const WORDS: Record<string, string> = { hp: "HP", osu: "osu!", lazer: "lazer", ur: "UR" };

/** ("Gameplay.HitErrorMeter.StaticUnstableRate", "Gameplay") → "Hit error meter › Static unstable rate". */
function toggleLabel(key: string, prefix: string): string {
  const parts = key.slice(prefix.length + 1).split(".");
  if (parts.length > 1 && (parts.at(-1) === "Show" || parts.at(-1) === "Enabled")) parts.pop();
  return parts
    .map((part) => {
      const words = part
        .replace(/([a-z])(\d)/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/([a-z\d])([A-Z])/g, "$1 $2")
        .split(" ")
        .map((word) => WORDS[word.toLowerCase()] ?? (/^[A-Z]{2,}$/.test(word) ? word : word.toLowerCase()));
      const text = words.join(" ");
      return text.startsWith("osu!") ? text : text[0]!.toUpperCase() + text.slice(1);
    })
    .join(" › ");
}

const CURATED = new Set(SETTING_GROUPS.flatMap((group) => group.fields.map((field) => field.key)));

/** The rest of danser's on/off settings, shown folded away under the curated groups. */
export const TOGGLE_GROUPS: readonly SettingGroup[] = TOGGLES.map(([id, title, prefix, toggles]) => ({
  id,
  title,
  fields: toggles.filter(([key]) => !CURATED.has(key)).map(([key, def]) => check(key, toggleLabel(key, prefix), def)),
}));

const FIELDS = [...SETTING_GROUPS, ...TOGGLE_GROUPS].flatMap((group) => group.fields);

// ---------- patch paths ----------

const isObject = (value: unknown): value is Patch => typeof value === "object" && value !== null && !Array.isArray(value);

function getPath(patch: Patch, key: string): unknown {
  let node: unknown = patch;
  for (const part of key.split(".")) {
    if (!isObject(node)) return undefined;
    node = node[part];
  }
  return node;
}

function setPath(patch: Patch, key: string, value: unknown): void {
  const parts = key.split(".");
  let node = patch;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(node[part])) node[part] = {};
    node = node[part] as Patch;
  }
  node[parts.at(-1)!] = value;
}

/** Remove a key, and any objects it leaves empty. */
function deletePath(patch: Patch, key: string): void {
  const parts = key.split(".");
  const trail: Patch[] = [patch];
  for (const part of parts.slice(0, -1)) {
    const next = trail.at(-1)![part];
    if (!isObject(next)) return;
    trail.push(next);
  }
  delete trail.at(-1)![parts.at(-1)!];
  for (let i = trail.length - 1; i > 0; i--) {
    if (Object.keys(trail[i]!).length > 0) break;
    delete trail[i - 1]![parts[i - 1]!];
  }
}

const FRAME_KEYS = ["Recording.FrameWidth", "Recording.FrameHeight"];
const danserKeys = (field: SettingField) => (field.kind === "resolution" ? FRAME_KEYS : [field.key]);

/** `over` merged into a copy of `base`; objects merge, anything else replaces. */
export function mergePatch(base: Patch, over: Patch): Patch {
  const merged: Patch = structuredClone(base);
  for (const [key, value] of Object.entries(over)) {
    merged[key] = isObject(value) && isObject(merged[key]) ? mergePatch(merged[key] as Patch, value) : structuredClone(value);
  }
  return merged;
}

/** The patch without the keys the form controls: what the "advanced" JSON box shows. */
export function withoutFormKeys(patch: Patch): Patch {
  const rest = structuredClone(patch);
  for (const field of FIELDS) for (const key of danserKeys(field)) deletePath(rest, key);
  return rest;
}

// ---------- reading and writing ----------

/** A field's value in a patch, or danser's default. Percent fields read as 0..100. */
export function fieldValue(field: SettingField, patch: Patch): boolean | number | string {
  switch (field.kind) {
    case "check": {
      const value = getPath(patch, field.key);
      return typeof value === "boolean" ? value : field.default;
    }
    case "percent": {
      const value = getPath(patch, field.key);
      return Math.round((typeof value === "number" ? value : field.default) * 100);
    }
    case "number":
    case "select": {
      const value = getPath(patch, field.key);
      return typeof value === "number" ? value : field.default;
    }
    case "resolution": {
      const width = getPath(patch, "Recording.FrameWidth");
      const height = getPath(patch, "Recording.FrameHeight");
      const [defaultWidth, defaultHeight] = field.default.split("x");
      return `${typeof width === "number" ? width : defaultWidth}x${typeof height === "number" ? height : defaultHeight}`;
    }
  }
}

function number(field: SettingField, raw: string | undefined, min: number, max: number): number {
  const value = Number((raw ?? "").trim());
  if (!raw?.trim() || !Number.isFinite(value)) throw new UserError(`${field.label} needs a number.`);
  if (value < min || value > max) throw new UserError(`${field.label} must be between ${min} and ${max}.`);
  return value;
}

/**
 * The patch the form describes, holding only values that differ from danser's defaults.
 * `get` reads a submitted field; an unchecked checkbox isn't submitted at all.
 */
export function settingsFromForm(get: (name: string) => string | undefined): Patch {
  const patch: Patch = {};
  for (const field of FIELDS) {
    const raw = get(field.key);
    switch (field.kind) {
      case "check": {
        const value = raw === "1";
        if (value !== field.default) setPath(patch, field.key, value);
        break;
      }
      case "percent": {
        const value = Math.round(number(field, raw, 0, 100)) / 100;
        if (value !== field.default) setPath(patch, field.key, value);
        break;
      }
      case "number": {
        const value = number(field, raw, field.min, field.max);
        if (value !== field.default) setPath(patch, field.key, value);
        break;
      }
      case "select": {
        const value = number(field, raw, field.min, field.max);
        if (!Number.isInteger(value)) throw new UserError(`${field.label} must be a whole number.`);
        if (value !== field.default) setPath(patch, field.key, value);
        break;
      }
      case "resolution": {
        const match = /^(\d{2,5})x(\d{2,5})$/.exec(raw ?? "");
        const [width, height] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
        if (width < 64 || height < 64 || width > 7680 || height > 4320) throw new UserError(`${field.label} must look like 1920x1080, up to 7680x4320.`);
        if (`${width}x${height}` !== field.default) {
          setPath(patch, "Recording.FrameWidth", width);
          setPath(patch, "Recording.FrameHeight", height);
        }
        break;
      }
    }
  }
  return patch;
}
