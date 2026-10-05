-- The public replay page's colours, from the map's background and combo colours. The render
-- worker works them out with the attributes; replays without them get a colour from their map's hash.
alter table replays add column palette jsonb;
