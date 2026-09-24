-- Every username seen for each player, so searches by an old name still find them after a
-- name change. osu_users keeps only the latest name; this keeps the rest.
create table osu_user_names (
  user_id bigint not null references osu_users (id) on delete cascade,
  username text not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (user_id, username)
);
create index osu_user_names_lower on osu_user_names (lower(username));

insert into osu_user_names (user_id, username, first_seen, last_seen)
select id, username, added_at, updated_at from osu_users;

-- Every write to osu_users (profiles, match players) records the name it saw.
create function record_osu_user_name() returns trigger language plpgsql as $$
begin
  insert into osu_user_names (user_id, username) values (new.id, new.username)
  on conflict (user_id, username) do update set last_seen = now();
  return new;
end
$$;

create trigger osu_users_record_name
after insert or update of username on osu_users
for each row execute function record_osu_user_name();
