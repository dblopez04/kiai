// Render presets. A preset is a skin plus a JSON patch over the base danser settings, applied
// for one run with `-sPatch`. Phase 3 has a single hard-coded preset; rules that pick one per
// replay (mods, AR, server) come in phase 5.

export interface RenderPreset {
  name: string;
  /** A folder in <DATA_DIR>/skins, or "default" for danser's built-in skin. */
  skin: string;
  /** Merged over the base settings; keys as in danser 0.11's settings/default.json. */
  patch: Record<string, unknown>;
}

export const DEFAULT_PRESET: RenderPreset = {
  name: "default",
  skin: "default",
  patch: {
    Recording: { FrameWidth: 1920, FrameHeight: 1080, FPS: 60 },
  },
};

export function presetByName(name: string): RenderPreset | null {
  return name === DEFAULT_PRESET.name ? DEFAULT_PRESET : null;
}
