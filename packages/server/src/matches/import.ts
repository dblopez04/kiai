// Reading match links out of pasted text: Elitebotix's `/osu-history onlymatchhistory` file, a
// list of mp links, or anything else with osu! match or room URLs in it.

import type { MatchSource } from "./normalize.ts";

export interface MatchRef {
  source: MatchSource;
  externalId: number;
  /** From an Elitebotix line, shown until the match is fetched. */
  name?: string;
}

export interface ParsedRefs {
  refs: MatchRef[];
  /** Elitebotix hides recent qualifier links ("XXXXXXXXX (hidden for 14 days)"). */
  hidden: number;
}

// "09-2026 - OWC 2026: (Japan) vs (Germany) ----- https://osu.ppy.sh/community/matches/119283746"
const ELITEBOTIX_LINE = /^\s*\d{2}-\d{4}\s+-\s+(.+?)\s+-{3,}\s+(\S+)\s*$/;
const STABLE_LINK = /osu\.ppy\.sh\/(?:community\/matches|mp)\/(\d+)/g;
const LAZER_LINK = /osu\.ppy\.sh\/multiplayer\/rooms\/(\d+)/g;
const BARE_ID = /^\s*(\d{4,12})\s*$/;

const id = (value: string) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export function parseMatchRefs(text: string): ParsedRefs {
  const refs = new Map<string, MatchRef>();
  let hidden = 0;
  const add = (source: MatchSource, value: string, name?: string) => {
    const externalId = id(value);
    if (externalId === null) return;
    const key = `${source}:${externalId}`;
    const existing = refs.get(key);
    if (!existing) refs.set(key, { source, externalId, ...(name ? { name } : {}) });
    else if (name && !existing.name) existing.name = name;
  };

  for (const line of text.split(/\r?\n/)) {
    if (/X{6,}/.test(line)) {
      hidden++;
      continue;
    }
    const elitebotix = ELITEBOTIX_LINE.exec(line);
    const name = elitebotix ? elitebotix[1] : undefined;
    for (const match of line.matchAll(STABLE_LINK)) add("stable", match[1]!, name);
    for (const match of line.matchAll(LAZER_LINK)) add("lazer", match[1]!, name);
    const bare = BARE_ID.exec(line);
    if (bare) add("stable", bare[1]!);
  }
  return { refs: [...refs.values()], hidden };
}
