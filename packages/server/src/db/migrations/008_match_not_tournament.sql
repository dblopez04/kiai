-- Casual lobbies with tournament-style names ("ACR: (me) vs (friend)") can be marked as not tournaments.
-- Fetching a match again leaves this alone.
alter table matches add column not_tournament boolean not null default false;
