-- The map with the replay's mods applied (stars, AR/OD/CS/HP, BPM, length, pp), computed with
-- rosu-pp once the map is on disk. Render rules match on it; pages and notifications show it.
alter table replays add column attributes jsonb;

-- When the Discord notification for a finished render went out, so it's sent once.
alter table render_jobs add column notified_at timestamptz;
