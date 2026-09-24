-- Maps the player left out of a match by hand (a tiebreaker played for fun after the match was
-- decided, say), on top of the warmups and maps skipped at the end. Fetching the match again
-- leaves this alone.
alter table match_games add column excluded boolean not null default false;
