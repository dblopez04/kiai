-- Clips: a stretch of a replay's rendered video, cut by the render worker. Made with the Discord
-- bot's /clip command.

create table clip_jobs (
  -- Random and unguessable, like replay ids: it becomes the public /c/<id>/video.mp4 link.
  id text primary key check (id ~ '^[a-z0-9]{10}$'),
  replay_id text not null references replays (id) on delete cascade,
  -- Times in the rendered video (not the song), as the viewer sees them.
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null check (end_ms > start_ms),
  -- queued: waits for the replay's latest render to succeed, then the worker cuts it.
  status text not null default 'queued' check (status in ('queued', 'running', 'success', 'failed')),
  error_text text,
  -- Relative to <DATA_DIR>.
  video_path text,
  video_bytes bigint,
  -- Where to answer: the slash command's application id, interaction token and user.
  discord jsonb,
  lease_token uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index clip_jobs_status on clip_jobs (status, created_at);
create index clip_jobs_replay_id on clip_jobs (replay_id);
