-- Render presets and the rules that pick one per replay.

-- A preset is a skin plus a JSON patch over danser's settings, applied with -sPatch.
create table render_presets (
  name text primary key check (name ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  description text not null default '',
  -- A folder in <DATA_DIR>/skins, or "default" for danser's built-in skin.
  skin text not null default 'default',
  patch jsonb not null default '{}' check (jsonb_typeof(patch) = 'object'),
  updated_at timestamptz not null default now()
);

insert into render_presets (name, description, skin, patch) values
  ('default', 'danser''s default skin at 1080p60. Used when no rule matches.', 'default',
   '{"Recording": {"FrameWidth": 1920, "FrameHeight": 1080, "FPS": 60}}');

-- Checked in position order; the first enabled rule whose expression matches picks the preset.
create table render_rules (
  id bigserial primary key,
  position integer not null,
  -- e.g. "HD and ar < 10.3"; see render/rules.ts.
  expression text not null,
  preset text not null references render_presets (name) on update cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create index render_rules_position on render_rules (position, id);

-- Null: pick the preset with the rules when the job runs (the map's attributes are known then).
alter table render_jobs alter column preset drop not null;
-- Why this preset: "rule 2: ar >= 10.3", "no rule matched", or "chosen by hand".
alter table render_jobs add column preset_reason text;
-- From the preset, for the public page's video tags.
alter table render_jobs add column video_width integer;
alter table render_jobs add column video_height integer;
