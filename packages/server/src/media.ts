// Files under DATA_DIR: uploaded replays, rendered videos, and the beatmaps and skins danser reads.
// The web server and the render worker share this directory (the `data` volume in compose).

import fs from "node:fs/promises";
import path from "node:path";

export interface MediaPaths {
  root: string;
  /** `<id>.osr`, as uploaded. */
  replays: string;
  /** Finished renders. */
  videos: string;
  /** Extracted beatmap sets, one folder each: danser's Songs directory. */
  songs: string;
  /** danser's Skins directory. */
  skins: string;
  /** Downloads and extractions in progress. On the same filesystem, so finished work is renamed into place. */
  tmp: string;
}

export function mediaPaths(dataDir: string): MediaPaths {
  const root = path.resolve(dataDir);
  return {
    root,
    replays: path.join(root, "replays"),
    videos: path.join(root, "videos"),
    songs: path.join(root, "songs"),
    skins: path.join(root, "skins"),
    tmp: path.join(root, "tmp"),
  };
}

export async function ensureMediaDirs(paths: MediaPaths): Promise<void> {
  for (const dir of [paths.replays, paths.videos, paths.songs, paths.skins, paths.tmp]) await fs.mkdir(dir, { recursive: true });
}
