-- Warmups found from the lobby host. Refs hand the host to a team captain to pick a warmup and
-- take it back for the mappool, so a tournament map played while a player held the host is a
-- warmup (two at most). `host_id` is that player, saved from the match's events.
alter table match_games add column host_id bigint;

-- A null warmup count means "find them from the host"; a number still skips that many maps from
-- the start. Matches left at the old default of 0 switch to finding them.
alter table matches alter column warmups drop not null, alter column warmups set default null;
update matches set warmups = null where warmups = 0;

-- Saved matches have no host yet: fetch the stable tournament ones again, alongside discovery.
-- (The name check leaves out matchmaking bot lobbies, like `matchmakingPattern`.)
insert into match_queue (source, external_id, kind, priority, added_via)
select 'stable', external_id, 'fetch', 2, 'manual' from matches
where source = 'stable' and acronym is not null and not not_tournament
  and name !~* '^\s*(romai|etx|o!mm)(?![a-z0-9_])'
on conflict (source, external_id) do nothing;
