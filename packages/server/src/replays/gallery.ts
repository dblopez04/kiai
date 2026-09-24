// The public replay gallery: rendered replays searched with the score library's filters. Each
// replay is exposed under the columns `scoreConditions` reads (`s` for the play, `b` for its map),
// so every filter means the same thing here as in the score library.

import type { Sql } from "../db/index.ts";
import { scoreConditions, scoreOrder, type ScoreFilters, type ScorePage } from "../scores/query.ts";
import { listReplaysByIds, type ReplayView } from "./store.ts";

/**
 * Replays whose latest render succeeded, the ones `/r/<id>` shows, as score-library rows:
 * - `ended_at` is when the play was set;
 * - `pp` is osu!'s when the play is linked to the score library, else rosu-pp's estimate, as the
 *   replay page shows it;
 * - `b.difficulty_rating` and `b.status` are osu!'s (without mods, like the library's), so maps osu!
 *   doesn't know never match a star or status filter. Titles fall back to the .osu file;
 * - `map_key` groups "best per map": the beatmap id, or the MD5 for maps osu! doesn't know.
 */
const FROM = `
  from (
    select r.id, r.beatmap_id, coalesce(r.beatmap_id::text, r.beatmap_md5) as map_key, r.ruleset_id,
      r.played_at as ended_at, r.rank, r.accuracy, r.total_score, r.max_combo, r.perfect, r.mod_acronyms,
      score_clock_rate(r.mods) as clock_rate,
      coalesce(sc.pp, (r.attributes ->> 'pp')::double precision) as pp,
      bm.status as map_status, bm.difficulty_rating as map_stars,
      coalesce(bm.title, f.title) as map_title, coalesce(bm.artist, f.artist) as map_artist,
      coalesce(bm.version, f.version) as map_version
    from replays r
    join lateral (select status from render_jobs where replay_id = r.id order by id desc limit 1) j on j.status = 'success'
    left join scores sc on sc.id = r.score_id
    left join beatmaps bm on bm.id = r.beatmap_id
    left join beatmap_files f on f.md5 = r.beatmap_md5
  ) s
  cross join lateral (
    select s.map_status as status, s.map_stars as difficulty_rating, s.map_title as title, s.map_artist as artist, s.map_version as version
  ) b`;

export interface GalleryPage {
  replays: ReplayView[];
  pagination: ScorePage["pagination"];
}

/** One page of rendered replays matching the score library's filters, from every player. */
export async function listGallery(sql: Sql, f: ScoreFilters): Promise<GalleryPage> {
  const where = scoreConditions(sql, null, f);
  const offset = (f.page - 1) * f.pageSize;
  const [rows, [count]] = f.bestOnly
    ? await Promise.all([
        sql<{ id: string }[]>`select t.id from (
            select distinct on (s.map_key) s.* ${sql.unsafe(FROM)} where ${where}
            order by s.map_key, s.pp desc nulls last, s.id desc
          ) t order by ${scoreOrder(sql, "t", f)} limit ${f.pageSize} offset ${offset}`,
        sql<{ total: number }[]>`select count(distinct s.map_key)::int as total ${sql.unsafe(FROM)} where ${where}`,
      ])
    : await Promise.all([
        sql<{ id: string }[]>`select s.id ${sql.unsafe(FROM)} where ${where}
          order by ${scoreOrder(sql, "s", f)} limit ${f.pageSize} offset ${offset}`,
        sql<{ total: number }[]>`select count(*)::int as total ${sql.unsafe(FROM)} where ${where}`,
      ]);
  const total = count?.total ?? 0;
  return {
    replays: await listReplaysByIds(sql, rows.map((row) => row.id)),
    pagination: { page: f.page, page_size: f.pageSize, total_count: total, total_pages: Math.ceil(total / f.pageSize) },
  };
}
