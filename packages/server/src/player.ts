// The one player whose scores this server keeps: `OSU_USER` from the environment.

import type { Sql } from "./db/index.ts";
import { UserError } from "./errors.ts";
import type { OsuClient } from "./osu/api.ts";
import type { ApiUser } from "./osu/types.ts";

export interface Player {
  id: number;
  username: string;
  avatar_url: string | null;
  country_code: string | null;
  pp: number | null;
  global_rank: number | null;
  play_count: number | null;
  play_time: number | null;
}

const COLUMNS = "id, username, avatar_url, country_code, pp, global_rank, play_count, play_time";

export async function saveProfile(sql: Sql, user: ApiUser): Promise<Player> {
  const stats = user.statistics ?? {};
  const [row] = await sql<Player[]>`
    insert into osu_users (id, username, avatar_url, country_code, pp, global_rank, play_count, play_time)
    values (${user.id}, ${user.username}, ${user.avatar_url ?? null}, ${user.country_code ?? null},
            ${stats.pp ?? null}, ${stats.global_rank ?? null}, ${stats.play_count ?? null}, ${stats.play_time ?? null})
    on conflict (id) do update set
      username = excluded.username, avatar_url = excluded.avatar_url, country_code = excluded.country_code,
      pp = excluded.pp, global_rank = excluded.global_rank, play_count = excluded.play_count,
      play_time = excluded.play_time, updated_at = now()
    returning ${sql.unsafe(COLUMNS)}`;
  await savePastNames(sql, user);
  return row!;
}

/** Keep a user's earlier names (the current one is recorded by a trigger on osu_users). */
export async function savePastNames(sql: Sql, user: Pick<ApiUser, "id" | "previous_usernames">): Promise<void> {
  const names = [...new Set(user.previous_usernames ?? [])].filter(Boolean);
  if (names.length === 0) return;
  await sql`
    insert into osu_user_names (user_id, username)
    select ${user.id}, name from unnest(${names}::text[]) as name
    on conflict (user_id, username) do nothing`;
}

/**
 * Resolve `OSU_USER` (username or id) to the player's row, fetching the profile from osu! the
 * first time. Later starts find the row locally, so the web UI works without osu! credentials.
 */
export async function resolvePlayer(sql: Sql, osu: OsuClient | null, osuUser: string): Promise<Player> {
  const input = osuUser.trim();
  const byId = /^\d+$/.test(input);
  const [known] = byId
    ? await sql<Player[]>`select ${sql.unsafe(COLUMNS)} from osu_users where id = ${Number(input)}`
    : await sql<Player[]>`select ${sql.unsafe(COLUMNS)} from osu_users where lower(username) = lower(${input})`;
  if (known) return known;

  if (!osu) {
    throw new UserError(`Player "${input}" isn't in the database yet. Set OSU_CLIENT_ID and OSU_CLIENT_SECRET so it can be looked up on osu!.`);
  }
  const user = await osu.getUser(byId ? Number(input) : input);
  if (!user) throw new UserError(`osu! has no user "${input}". Check OSU_USER in .env.`);
  return saveProfile(sql, user);
}
