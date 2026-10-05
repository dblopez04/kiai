-- A smaller copy of a render too big for Discord to play, made by the render worker. Discord cards
-- and link previews point at it (/r/<id>/embed.mp4); without one they get the full video.
alter table render_jobs add column embed_path text;
alter table render_jobs add column embed_bytes bigint;
