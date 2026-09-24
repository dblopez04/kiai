-- Each game's result, saved by `recomputeMatch` so the match stats page can count maps won, mod
-- pool records and comebacks without re-analyzing every match. `migrate` then recomputes the
-- matches already saved.
alter table match_games
  add column counted boolean not null default false,
  add column winner text check (winner in ('red', 'blue')),
  add column red_score bigint,
  add column blue_score bigint;
