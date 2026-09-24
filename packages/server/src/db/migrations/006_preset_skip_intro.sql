-- Start the video at the first hit object (danser's -skip), as o!rdr does. It saves the render
-- time the lead-in would take, so it's on for existing presets too.
alter table render_presets add column skip_intro boolean not null default true;
