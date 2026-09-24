-- Which games were left out as warmups (by count or from the host), saved with the other game
-- results so the match list can show and filter on them. A hook fills it for saved matches.
alter table match_games add column warmup boolean not null default false;

-- Ranked play rooms used to be fetched from an API route that turns away kiai's token, so they
-- failed as private. They're fetched from the room page's route now: try them again.
update match_queue set failed = false, attempts = 0, last_error = null, not_before = now()
where source = 'lazer' and failed;
