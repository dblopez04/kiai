-- Match database: stable multiplayer lobbies (tournament mp links) and lazer ranked play rooms,
-- every game in them and every player's score, plus the import queue and discovery crawlers.
-- (Numbered 003 so it sorts after the replay tables planned as 002.)

create table matches (
  id bigserial primary key,
  -- `stable`: https://osu.ppy.sh/community/matches/<external_id>
  -- `lazer`:  https://osu.ppy.sh/multiplayer/rooms/<external_id> (ranked play)
  source text not null check (source in ('stable', 'lazer')),
  external_id bigint not null,
  name text not null default '',
  -- Parsed from tournament names like "OWC 2025: (United States) vs (Japan)". The first team is red.
  acronym text,
  red_name text,
  blue_name text,
  room_type text,
  start_time timestamptz,
  end_time timestamptz,
  -- How the match cost is worked out, like Bathbot's options. Changing them recomputes the match.
  warmups integer not null default 0 check (warmups >= 0),
  skip_last integer not null default 0 check (skip_last >= 0),
  ez_multiplier double precision not null default 1 check (ez_multiplier > 0 and ez_multiplier <= 10),
  -- Derived by `recomputeMatch`.
  format text check (format in ('team', '1v1', 'ffa')),
  games_count integer not null default 0,
  red_wins integer,
  blue_wins integer,
  added_via text not null check (added_via in ('import', 'manual', 'discovery')),
  fetched_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source, external_id)
);

create index matches_name_trgm on matches using gin (name gin_trgm_ops);
create index matches_start_time on matches (start_time desc);

create table match_games (
  id bigserial primary key,
  match_id bigint not null references matches (id) on delete cascade,
  -- Stable game id, or lazer playlist item id.
  external_id bigint not null,
  position integer not null,
  -- No foreign key: deleted and unsubmitted tournament maps have no `beatmaps` row.
  beatmap_id bigint,
  ruleset_id integer not null default 0,
  scoring_type text,
  team_type text,
  -- Mods set for the whole lobby (freemod picks are on each score).
  mods text[] not null default '{}',
  start_time timestamptz,
  end_time timestamptz,
  unique (match_id, external_id)
);

create index match_games_beatmap on match_games (beatmap_id);

create table match_scores (
  id bigserial primary key,
  game_id bigint not null references match_games (id) on delete cascade,
  match_id bigint not null references matches (id) on delete cascade,
  user_id bigint not null,
  slot integer,
  team text not null default 'none' check (team in ('none', 'red', 'blue')),
  -- The lazer score id, for ranked play.
  score_id bigint,
  total_score bigint not null,
  accuracy double precision not null,
  max_combo integer not null default 0,
  perfect boolean not null default false,
  passed boolean not null default true,
  rank text not null,
  count300 integer not null default 0,
  count100 integer not null default 0,
  count50 integer not null default 0,
  countmiss integer not null default 0,
  mods jsonb not null default '[]',
  -- NoFail is left out: nearly every tournament score has it, so "NM" means no other mods.
  mod_acronyms text[] generated always as (array_remove(score_mod_acronyms(mods), 'NF')) stored,
  clock_rate double precision generated always as (score_clock_rate(mods)) stored,
  statistics jsonb not null default '{}',
  pp double precision,
  pp_source text not null default 'unknown' check (pp_source in ('osu', 'local', 'unavailable', 'unknown')),
  pp_calculator text,
  unique (game_id, user_id)
);

create index match_scores_user on match_scores (user_id, match_id);
create index match_scores_match on match_scores (match_id);
create index match_scores_pp on match_scores (pp desc);
create index match_scores_mod_acronyms on match_scores using gin (mod_acronyms);

-- One row per player per match: Bathbot's match cost and the player's side.
create table match_players (
  match_id bigint not null references matches (id) on delete cascade,
  user_id bigint not null,
  team text not null default 'none',
  -- red/blue for team matches and 1v1s (the players' sides), null for free-for-alls and qualifiers.
  side text check (side in ('red', 'blue')),
  games_played integer not null,
  avg_score double precision not null,
  avg_accuracy double precision not null,
  performance_cost double precision not null,
  participation_bonus double precision not null,
  mods_bonus double precision not null,
  tiebreaker_bonus double precision not null,
  match_cost double precision not null,
  primary key (match_id, user_id)
);

create index match_players_user on match_players (user_id, match_id);

-- The same columns as `scores`, so the score library's filters (`scores/query.ts`) work on them.
create view match_score_rows as
select
  ms.id, ms.user_id, g.beatmap_id, g.ruleset_id,
  coalesce(g.end_time, g.start_time, m.start_time, m.created_at) as ended_at,
  ms.rank, ms.accuracy, ms.total_score, ms.max_combo, ms.perfect, ms.passed,
  ms.count300, ms.count100, ms.count50, ms.countmiss, ms.mods, ms.mod_acronyms, ms.clock_rate, ms.statistics,
  ms.pp, ms.pp_source, ms.pp_calculator, ms.team, ms.slot, ms.score_id,
  ms.match_id, ms.game_id, g.position as game_position, g.mods as game_mods,
  m.name as match_name, m.source as match_source, m.external_id as match_external_id
from match_scores ms
join match_games g on g.id = ms.game_id
join matches m on m.id = ms.match_id;

-- Matches waiting to be fetched. `probe` rows come from discovery: they're kept only if the
-- player took part. Rows are deleted once handled; `failed` ones stay for a retry.
create table match_queue (
  source text not null check (source in ('stable', 'lazer')),
  external_id bigint not null,
  kind text not null check (kind in ('fetch', 'probe')),
  -- Lower runs first: 0 requested by you, 1 refreshing a match in progress, 2 discovery.
  priority integer not null default 0,
  added_via text not null check (added_via in ('import', 'manual', 'discovery')),
  -- The name from an Elitebotix list, shown until the match is fetched.
  name text,
  not_before timestamptz not null default now(),
  attempts integer not null default 0,
  failed boolean not null default false,
  last_error text,
  created_at timestamptz not null default now(),
  primary key (source, external_id)
);

create index match_queue_due on match_queue (priority, not_before) where not failed;

-- Discovery crawlers: `stable` walks osu!'s public list of mp lobbies in id order; `lazer` walks
-- ended ranked play rooms. The cursor is each crawler's saved position.
create table match_discovery (
  source text primary key check (source in ('stable', 'lazer')),
  enabled boolean not null default true,
  cursor jsonb not null default '{}',
  scanned bigint not null default 0,
  probed bigint not null default 0,
  found bigint not null default 0,
  locked_until timestamptz,
  last_run_at timestamptz,
  last_error text
);

insert into match_discovery (source) values ('stable'), ('lazer');
