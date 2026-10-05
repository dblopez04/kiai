// A replay page's colours, taken from its map: the most present vivid hue in the background
// image, else the most saturated combo colour, else a hue hashed from the map. Every colour is
// derived from that one hue, with text and links darkened until they read on the page.

import { execFile } from "node:child_process";
import path from "node:path";

export interface MapPalette {
  /** Where the hue came from. */
  source: "background" | "combo" | "hash";
  paper: string;
  ink: string;
  muted: string;
  rule: string;
  accent: string;
  visited: string;
}

type Rgb = [number, number, number];
type Hsl = [h: number, s: number, l: number];

/** Shrinks an image to a few pixels of RGB. Null when it can't be read. */
export type ImageDecoder = (file: string) => Promise<Uint8Array | null>;

/** The background image and combo colours a .osu file names. */
export function mapColours(osu: string): { background: string | null; combo: Rgb[] } {
  let section = "";
  let background: string | null = null;
  const combo: Rgb[] = [];
  for (const raw of osu.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      section = line;
      if (section === "[HitObjects]") break;
      continue;
    }
    if (section === "[Events]" && background === null) {
      // `0,0,"bg.jpg",0,0`: the background event. Videos and storyboard sprites start otherwise.
      const m = /^0\s*,\s*[-\d.]+\s*,\s*"?([^",]+?)"?\s*(?:,|$)/.exec(line);
      if (m) background = m[1]!;
    }
    if (section === "[Colours]") {
      const m = /^Combo\d+\s*:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(line);
      if (m) combo.push([Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.min(255, v)) as Rgb);
    }
  }
  return { background, combo };
}

function rgbToHsl([r, g, b]: Rgb): Hsl {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]: Hsl): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * 255);
  return [f(0), f(8), f(4)];
}

const hex = (rgb: Rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Darken until it reads on `bg` at WCAG AA. */
function readable([h, s, l]: Hsl, bg: Rgb): Rgb {
  while (l > 0 && contrast(hslToRgb([h, s, l]), bg) < 4.5) l = Math.max(0, l - 0.02);
  return hslToRgb([h, s, l]);
}

/**
 * The hue that covers the most of the image, weighted by how colourful each pixel is, so grey,
 * black and white count for nothing. Null when the image is (nearly) colourless.
 */
export function dominantHue(pixels: Uint8Array): { hue: number; saturation: number } | null {
  const buckets = Array.from({ length: 24 }, () => ({ weight: 0, x: 0, y: 0, saturation: 0 }));
  let total = 0;
  const count = Math.floor(pixels.length / 3);
  for (let i = 0; i < count; i++) {
    const [h, s, l] = rgbToHsl([pixels[i * 3]!, pixels[i * 3 + 1]!, pixels[i * 3 + 2]!]);
    const weight = s * (1 - Math.abs(2 * l - 1));
    total += weight;
    const bucket = buckets[Math.floor(h / 15) % 24]!;
    bucket.weight += weight;
    bucket.x += Math.cos((h * Math.PI) / 180) * weight;
    bucket.y += Math.sin((h * Math.PI) / 180) * weight;
    bucket.saturation += s * weight;
  }
  if (count === 0 || total / count < 0.04) return null;
  // Each bucket with its neighbours, so a hue split across two buckets still wins.
  let best = { weight: 0, x: 0, y: 0, saturation: 0 };
  for (let i = 0; i < 24; i++) {
    const group = [buckets[(i + 23) % 24]!, buckets[i]!, buckets[(i + 1) % 24]!];
    const sum = group.reduce((a, b) => ({ weight: a.weight + b.weight, x: a.x + b.x, y: a.y + b.y, saturation: a.saturation + b.saturation }));
    if (sum.weight > best.weight) best = sum;
  }
  return { hue: ((Math.atan2(best.y, best.x) * 180) / Math.PI + 360) % 360, saturation: best.saturation / best.weight };
}

function hashHue(seed: string): number {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** Background pixels when there are any, else the combo colours, else `seed`. */
export function mapPalette(input: { pixels?: Uint8Array | null; combo?: readonly Rgb[]; seed: string }): MapPalette {
  const combo = input.combo ?? [];
  let source: MapPalette["source"] = "hash";
  let hue = hashHue(input.seed);
  let saturation = 0.5;
  const fromImage = input.pixels ? dominantHue(input.pixels) : null;
  const vivid = combo.map(rgbToHsl).sort((a, b) => b[1] - a[1])[0];
  if (fromImage) {
    ({ hue, saturation } = fromImage);
    source = "background";
  } else if (vivid && vivid[1] > 0.2) {
    [hue, saturation] = vivid;
    source = "combo";
  }
  const s = Math.min(Math.max(saturation, 0.45), 0.85);
  const paper = hslToRgb([hue, Math.min(s, 0.5), 0.94]);
  return {
    source,
    paper: hex(paper),
    ink: hex(hslToRgb([hue, 0.35, 0.12])),
    muted: hex(readable([hue, 0.15, 0.4], paper)),
    rule: hex(hslToRgb([hue, Math.min(s, 0.35), 0.62])),
    accent: hex(readable([hue, s, 0.45], paper)),
    visited: hex(readable([(hue + 40) % 360, s * 0.7, 0.4], paper)),
  };
}

/** The palette for a map folder's .osu, reading its background with `decode` when there is one. */
export async function paletteForMap(osu: string, folder: string, seed: string, decode?: ImageDecoder | null): Promise<MapPalette> {
  const { background, combo } = mapColours(osu);
  let pixels: Uint8Array | null = null;
  const file = background ? path.join(folder, background) : null;
  // The name comes from the map: keep it inside the map's folder.
  if (decode && file && path.resolve(file).startsWith(path.resolve(folder) + path.sep)) pixels = await decode(file).catch(() => null);
  return mapPalette({ pixels, combo, seed });
}

/** Decodes with ffmpeg, scaled to 48x27. `env` carries danser's LD_LIBRARY_PATH for its bundled ffmpeg. */
export function ffmpegDecoder(ffmpeg: string, env: NodeJS.ProcessEnv = process.env): ImageDecoder {
  const args = (file: string) => ["-nostdin", "-v", "error", "-i", file, "-vf", "scale=48:27", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"];
  return (file) =>
    new Promise((resolve) => {
      execFile(ffmpeg, args(file), { env, encoding: "buffer", timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        resolve(error || stdout.length === 0 ? null : new Uint8Array(stdout));
      });
    });
}
