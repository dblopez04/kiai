-- The player's tournament ratings from o!TR and Skill Issue, cached so the matches page doesn't
-- wait on either site. `data` is null when the site has no rating for the player.
create table external_ratings (
  provider text not null check (provider in ('otr', 'skillissue')),
  user_id bigint not null references osu_users (id) on delete cascade,
  data jsonb,
  -- Last successful fetch; null until one succeeds.
  fetched_at timestamptz,
  attempted_at timestamptz not null default now(),
  -- Why the last attempt failed. Earlier data is kept.
  error text,
  primary key (provider, user_id)
);
