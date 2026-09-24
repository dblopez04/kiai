-- Score library: tracked osu! users, beatmap metadata, successful plays, and the sync job queue.

create extension if not exists pg_trgm;

create table osu_users (
  id bigint primary key,
  username text not null,
  avatar_url text,
  country_code text,
  pp double precision,
  global_rank bigint,
  play_count bigint,
  play_time bigint,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table beatmaps (
  id bigint primary key,
  beatmapset_id bigint not null,
  user_id bigint,
  artist text,
  title text,
  version text,
  creator text,
  difficulty_rating double precision,
  bpm double precision,
  mode_int integer,
  status text,
  total_length integer,
  hit_length integer,
  count_circles integer,
  count_sliders integer,
  count_spinners integer,
  max_combo integer,
  ar double precision,
  od double precision,
  cs double precision,
  drain double precision,
  last_updated timestamptz
);

create index beatmaps_title_trgm on beatmaps using gin (title gin_trgm_ops);
create index beatmaps_artist_trgm on beatmaps using gin (artist gin_trgm_ops);
create index beatmaps_version_trgm on beatmaps using gin (version gin_trgm_ops);
create index beatmaps_difficulty on beatmaps (difficulty_rating);
create index beatmaps_status on beatmaps (status);

-- Mods are stored as the API returns them: [{"acronym": "DT", "settings": {"speed_change": 1.2}}, ...].
-- Older payloads use bare strings ("HD"), so both shapes are accepted.
create function score_mod_acronyms(mods jsonb) returns text[]
language sql immutable as $$
  select coalesce(array_agg(distinct upper(case when jsonb_typeof(m) = 'string' then m #>> '{}' else m ->> 'acronym' end)), '{}')
  from jsonb_array_elements(case when jsonb_typeof(mods) = 'array' then mods else '[]'::jsonb end) m
$$;

-- Constant playback rate: DT/NC default 1.5, HT/DC default 0.75, custom speed_change honoured.
-- Variable-rate mods (Wind Up, Wind Down, Adaptive Speed) have no single rate: null.
create function score_clock_rate(mods jsonb) returns double precision
language plpgsql immutable as $$
declare
  m jsonb;
  acronym text;
  rate double precision;
begin
  if score_mod_acronyms(mods) && array['WU', 'WD', 'AS'] then return null; end if;
  for m in select * from jsonb_array_elements(case when jsonb_typeof(mods) = 'array' then mods else '[]'::jsonb end) loop
    acronym := upper(case when jsonb_typeof(m) = 'string' then m #>> '{}' else m ->> 'acronym' end);
    if acronym in ('DT', 'NC', 'HT', 'DC') then
      if jsonb_typeof(m -> 'settings' -> 'speed_change') = 'number' then
        rate := (m -> 'settings' ->> 'speed_change')::double precision;
        if rate > 0 and rate <= 100 then return rate; end if;
      end if;
      return case when acronym in ('DT', 'NC') then 1.5 else 0.75 end;
    end if;
  end loop;
  return 1;
end
$$;

-- Only successful plays are stored.
create table scores (
  id bigint primary key,
  user_id bigint not null references osu_users (id) on delete cascade,
  beatmap_id bigint not null references beatmaps (id),
  ruleset_id integer not null default 0,
  ended_at timestamptz not null,
  rank text not null check (rank <> 'F'),
  accuracy double precision not null,
  total_score bigint not null,
  legacy_total_score bigint,
  max_combo integer not null,
  perfect boolean not null default false,
  count300 integer not null default 0,
  count100 integer not null default 0,
  count50 integer not null default 0,
  countmiss integer not null default 0,
  mods jsonb not null default '[]',
  mod_acronyms text[] generated always as (score_mod_acronyms(mods)) stored,
  clock_rate double precision generated always as (score_clock_rate(mods)) stored,
  statistics jsonb not null default '{}',
  maximum_statistics jsonb,
  -- Official PP wins; `local` is a rosu-pp estimate; `unavailable` means neither could be had.
  pp double precision,
  pp_source text not null default 'unknown' check (pp_source in ('osu', 'local', 'unavailable', 'unknown')),
  pp_calculator text,
  pp_updated_at timestamptz,
  replay_available boolean not null default false,
  build_id bigint,
  legacy_score_id bigint,
  is_lazer boolean,
  preserve boolean,
  -- Whether https://osu.ppy.sh/scores/<id> still resolves; overwritten plays disappear from osu!.
  score_link_status text not null default 'unknown' check (score_link_status in ('available', 'unavailable', 'unknown')),
  score_link_checked_at timestamptz,
  created_at timestamptz not null default now()
);

create index scores_user_ended_at on scores (user_id, ended_at desc);
create index scores_user_beatmap on scores (user_id, beatmap_id);
create index scores_user_pp on scores (user_id, pp desc);
create index scores_user_accuracy on scores (user_id, accuracy desc);
create index scores_user_total_score on scores (user_id, total_score desc);
create index scores_user_rank on scores (user_id, rank);
create index scores_user_rate on scores (user_id, clock_rate);
create index scores_mod_acronyms on scores using gin (mod_acronyms);

-- Standard maps each user is known to have played. Kept across library resets, so a rebuilt
-- library still checks maps that have dropped out of the profile's most-played list.
create table user_played_maps (
  user_id bigint not null references osu_users (id) on delete cascade,
  beatmap_id bigint not null references beatmaps (id),
  primary key (user_id, beatmap_id)
);

create table sync_runs (
  id bigserial primary key,
  user_id bigint not null references osu_users (id) on delete cascade,
  mode text not null check (mode in ('recent', 'history', 'refresh', 'reset')),
  trigger text not null check (trigger in ('manual', 'schedule', 'api')),
  status text not null check (status in ('queued', 'running', 'success', 'failed')),
  checkpoint jsonb not null default '{}',
  recent_window_hours integer not null,
  scores_added integer not null default 0,
  scores_skipped integer not null default 0,
  beatmaps_upserted integer not null default 0,
  error_text text,
  csv_path text,
  lease_token uuid,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- One queued or running job per user: queuing again is a no-op, not a duplicate.
create unique index sync_runs_one_active_per_user on sync_runs (user_id) where status in ('queued', 'running');
create index sync_runs_user_id on sync_runs (user_id, id desc);

-- Full rows of every score cleared by a library reset, written in the same transaction as the delete.
create table score_archives (
  id bigserial primary key,
  user_id bigint not null references osu_users (id) on delete cascade,
  run_id bigint not null unique references sync_runs (id),
  scores jsonb not null,
  created_at timestamptz not null default now()
);
