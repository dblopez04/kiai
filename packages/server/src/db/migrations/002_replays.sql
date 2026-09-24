-- Replays uploaded for rendering, the beatmap files they need, and the render job queue.

-- Every .osu file extracted under <DATA_DIR>/songs, by MD5: the key a replay uses to name its map.
create table beatmap_files (
  md5 text primary key check (md5 ~ '^[0-9a-f]{32}$'),
  -- Relative to <DATA_DIR>/songs.
  folder text not null,
  file text not null,
  -- From the .osu file itself; zero or missing for unsubmitted maps.
  beatmap_id bigint,
  beatmapset_id bigint,
  artist text,
  title text,
  version text,
  creator text,
  source text not null check (source in ('mirror', 'osu', 'upload')),
  added_at timestamptz not null default now()
);

create index beatmap_files_folder on beatmap_files (folder);

create table replays (
  -- Random and unguessable: it becomes the public /r/<id> link.
  id text primary key check (id ~ '^[a-z0-9]{10}$'),
  -- Uploading the same file again returns the existing replay.
  file_sha256 text not null unique,
  -- The osu! server the play was set on, from the uploading client's preset. Null: official servers.
  devserver text,
  ruleset_id integer not null,
  game_version integer not null,
  beatmap_md5 text not null check (beatmap_md5 ~ '^[0-9a-f]{32}$'),
  -- Set once osu! knows the map; unsubmitted and edited maps stay null.
  beatmap_id bigint references beatmaps (id),
  player_name text not null,
  count300 integer not null,
  count100 integer not null,
  count50 integer not null,
  count_geki integer not null,
  count_katu integer not null,
  countmiss integer not null,
  total_score bigint not null,
  max_combo integer not null,
  perfect boolean not null,
  mods jsonb not null default '[]',
  mod_acronyms text[] generated always as (score_mod_acronyms(mods)) stored,
  accuracy double precision not null,
  rank text not null,
  played_at timestamptz not null,
  -- osu! stable's online score id; 0 when the play wasn't submitted.
  online_score_id bigint not null default 0,
  -- The matching play in the score library, so the gallery can filter replays with its filters.
  score_id bigint references scores (id) on delete set null,
  uploaded_at timestamptz not null default now()
);

create index replays_uploaded_at on replays (uploaded_at desc);
create index replays_beatmap_md5 on replays (beatmap_md5);
create index replays_score_id on replays (score_id);
create index replays_unlinked on replays (id) where score_id is null and devserver is null;

create table render_jobs (
  id bigserial primary key,
  replay_id text not null references replays (id) on delete cascade,
  preset text not null,
  -- needs_map: no mirror had the beatmap; uploading its .osz queues the job again.
  status text not null check (status in ('queued', 'running', 'needs_map', 'success', 'failed')),
  progress integer not null default 0 check (progress between 0 and 100),
  -- Claims so far; a job whose worker keeps dying is failed rather than retried forever.
  attempts integer not null default 0,
  error_text text,
  -- Relative to <DATA_DIR>.
  video_path text,
  video_bytes bigint,
  lease_token uuid,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- One unfinished render per replay: queuing again returns the existing job.
create unique index render_jobs_one_active_per_replay on render_jobs (replay_id) where status in ('queued', 'running', 'needs_map');
create index render_jobs_replay_id on render_jobs (replay_id, id desc);
create index render_jobs_status on render_jobs (status, id);
