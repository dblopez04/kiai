# Architecture and roadmap

## Pieces

**Client** (`client/`, Go, standard library only): one static binary on the gaming PC,
later also a systemd user service.

- Presets and `.desktop` entries (done).
- `kiai render <file.osr>` (done): uploads a replay, waits for the render, and uploads the map
  from the local Songs folder when the server can't get it.
- Replay watcher (done): `kiai watch`, installed as a systemd user unit by `kiai watch install`.
  osu! stable writes exported replays (F2) to `<osu path>/Replays/`, and osu-winello records the
  osu! path in `~/.local/share/osuconfig/osupath`. lazer writes exports to
  `~/.local/share/osu/exports`. The watcher polls both every 3 s (a file is uploaded once its size
  holds still), uploads each new `.osr` with the token, tags it with the server from
  `session.json`, and follows the render, uploading the map when the server asks for it.

**Server** (`packages/server`): docker compose on the homelab.

| Service | Job | Status |
|---|---|---|
| `server` | Private score library UI + API on :8080, and the score sync worker (`serve` runs both; `web` / `worker` split them) | done |
| `postgres` | Scores, metadata and the job queues | done |
| `render` / `render-cpu` | danser + Xvfb (`render.Dockerfile`), compose profiles `nvidia` and `cpu`; runs `render-worker` | done |
| `public` | The public replay app (`http/public.ts`, `server public`): replay pages and videos only, on :8081 | done |
| `caddy` | Profile `tunnel`: proxies everything it gets to the public app (`deploy/Caddyfile`) | done |
| `cloudflared` | Profile `tunnel`: Cloudflare Tunnel with a single `TUNNEL_TOKEN`, hostname → `http://caddy:80` | done |

### Public vs private

Only replay viewing is public. The score library is for one player (`OSU_USER`) and has no
login, so it relies on never being reachable from outside:

- It listens on its own port, which compose publishes on 127.0.0.1 only. Caddy and cloudflared
  will only ever be pointed at the replay app's port.
- Every request passes through `http/private.ts`, which refuses:
  - a `Host` that isn't an IP, `localhost`, a single-label name, a private suffix (`.local`,
    `.lan`, `.home.arpa`, `.internal`, `.ts.net`) or listed in `PRIVATE_HOSTS`;
  - requests carrying Cloudflare/CDN headers;
  - writes whose `Origin` is another site or `null`.

  A misrouted tunnel fails closed, and DNS-rebinding and cross-site requests from your own
  browser are blocked.
- The replay app (`http/public.ts`) shares the database but never mounts the private routes (`http/app.ts`).
  It may reuse the filter module (`scores/query.ts`), but only for its own queries, which
  return rows that have a rendered replay.

## Score library

A rewrite of the score-browser proof of concept, with Postgres in place of Supabase. It
reads osu! with a client-credentials token, so there's no osu! sign-in. The player is
`OSU_USER`, looked up on osu! once and then found locally (`player.ts`).

| Module | |
|---|---|
| `db/migrations/*.sql` | Schema. `mod_acronyms` and `clock_rate` are generated columns, so mod and speed filters are indexed SQL |
| `osu/api.ts` | osu! API v2 client: shared 1.1 s rate limiter; retries on dropped connections, timeouts, 429 and 5xx |
| `scores/importer.ts` | Recent sync and history import (profile most-played list → per-map scores), checkpointed |
| `scores/refresh.ts` | Refresh all PP; zero-PP backfill |
| `scores/pp.ts` | Local PP with rosu-pp-js |
| `scores/query.ts` | **Filters shared by the UI, the API and CSV.** The replay gallery should use `parseScoreFilters` + `scoreConditions` so its search matches |
| `scores/csv.ts` | CSV rows and atomic snapshots |
| `sync/queue.ts` | `sync_runs` job queue: one active job per player, one running job overall, leases with heartbeats, the reset archive |
| `sync/runner.ts`, `sync/worker.ts` | Run jobs; queue scheduled recent syncs |
| `http/` | Hono app: server-rendered pages (`views.ts`), small progressive-enhancement script, JSON/CSV API, private-network guard (`private.ts`) |

Differences from the proof of concept:
- **Filtering:** best-per-map and exact-mod filters run in SQL (`distinct on`, array
  containment) instead of loading every match into memory.
- **Exports:** CSV is streamed through a cursor.
- **Access:** no osu! sign-in or sessions: one configured player, private network only.
- **Queue:** it's plain SQL in `sync_runs`, not pg-boss. The render queue should follow the
  same lease pattern, but allow as many concurrent jobs as there are GPUs.
- **Schema:** it still keys scores by `user_id`, so tracking more players later needs no
  migration.

## Render pipeline

Phase 3 implements steps 1, 2 and 5 (with one hard-coded preset), plus the score link. Modules:

| Module | |
|---|---|
| `replays/osr.ts` | .osr header parser: map MD5, player, hit counts, legacy mods (as lazer acronyms), date, online score id; stable's grade |
| `replays/store.ts` | Saving uploads (deduplicated by SHA-256, random 10-character ids), replay views, `linkReplays` |
| `render/maps.ts` | `beatmap_files` (every extracted .osu by MD5), safe .osz extraction (yauzl, no path escapes, size caps), mirror downloads, `ensureBeatmap` |
| `render/queue.ts` | `render_jobs`: one unfinished job per replay, `for update skip locked` claims so several slots can run, leases with heartbeats, 3 attempts |
| `render/danser.ts` | Runs `danser-cli` under `xvfb-run` in its own process group; progress from danser's log; timeout |
| `render/preset.ts` | The one preset (phase 5 replaces it with rules) |
| `render/worker.ts` | Claim → map → link → render → record; `needs_map` parks a job until its .osz is uploaded |
| `http/replays.ts` | Upload API (bearer `UPLOAD_TOKEN`), replay JSON, video with byte ranges, private replay pages |

What the code relies on from danser 0.11's source:
- Settings live next to the binary (`settings/<name>.json`), and danser rewrites the file on load.
  When the file is new, `-sPatch` is applied *after* the beatmap database is scanned. So the Songs
  folder must be in a real settings file (`kiai.json`, written before every run), not the patch.
- `-out <name>` writes `<Recording.OutputDir>/<name>.<Container>`, and `OutputDir` may be absolute.
- When it can't find the map it logs `Beatmap not found, closing...` and exits 0. Success
  therefore means "exit 0 and the video exists".
- The release bundles its own ffmpeg 7 (with NVENC) in `ffmpeg/`. Its rpath is broken, so the
  worker sets `LD_LIBRARY_PATH`.
- Under Xvfb, GL runs on Mesa (llvmpipe, on the CPU); only encoding uses the GPU. If rendering is
  too slow on the homelab, the next step is a headless Xorg with the NVIDIA driver instead of Xvfb.

1. Upload `.osr` → parse the header: beatmap MD5, mods, player, and score stats.
2. Find the map by MD5: osu! API v2 `beatmaps/lookup?checksum=` or a mirror, then download
   the `.osz`. If no mirror has it (unsubmitted or edited maps), the client uploads it.
3. Compute attributes with mods applied (rosu-pp-js): effective AR, OD, CS, star rating,
   and pp. For example, AR9 with DT is AR 10.33.
4. Choose a render preset: an ordered rule list where the first match wins. The editor
   gets a dry run that shows which rule a replay would hit.
   ```
   1. mods has HD and ar < 10.3 → "hd"
   2. ar >= 10.3                → "dt"
   3. default                   → "default"
   ```
5. Render: `danser-cli -replay <osr> -record -out <id> -settings <base> -skin <skin>
   -sPatch '<preset json>' -quickstart -noupdatecheck`. `-sPatch` patches the loaded
   settings for that one run, so a preset is a base settings file plus a JSON patch.
6. Notify. Discord DMs need a bot that shares a server with the user, since webhooks can't
   send DMs. The message is a rich embed (cover, mods, accuracy, pp, preset used) plus the
   replay page link, whose `og:video` tags make Discord play the video inline. A webhook to
   a private channel is the no-setup alternative.

## Deployment facts

- danser 0.11 ships Linux builds for x86_64 only and uses BASS, so the render host must
  be x86_64.
- danser opens a hidden GLFW window, so the worker needs Xvfb plus the GPU.
- The target host is x86_64 with an NVIDIA GTX 1050 Ti on Docker. That means
  nvidia-container-toolkit on the host and a compose profile for NVIDIA. Pascal NVENC
  handles H.264 and HEVC but not AV1, so presets default to `h264_nvenc`. Other GPUs get
  their own profiles (QSV, AMF, software x264).
- Only `/r/<id>` and the gallery are public through the tunnel. The upload API and the
  editor need a token and/or Cloudflare Access.
- Cloudflare's terms restrict serving large volumes of video through its proxy. A few
  personal replay links are low volume but in a gray area. The free plan also caps request
  bodies at 100 MB, so large `.osz` and skin uploads should go over the LAN or Tailscale.
- lazer replays that use lazer-only mods (rate adjust, difficulty adjust) may not render
  faithfully in danser, so stable is supported first.

## Roadmap

1. **Done:** repo scaffold, client presets and `.desktop` entries (ported to Go).
2. **Done:** private single-player score library (sync worker, search/filter, local PP, CSV,
   web UI, compose).
3. **Done:** render MVP: upload endpoint, map fetching, render container, one hard-coded
   preset; `kiai render <file.osr>` by hand. Each replay is linked to its `scores` row when
   osu! has the score, so the gallery can filter replays with `scores/query.ts`.
4. **Done:** replay watcher (systemd user unit), Discord notification (bot DM or webhook),
   the public replay app on its own port, Caddy and cloudflared. Replays also get their
   mod-adjusted attributes (`replays/attributes.ts`, rosu-pp), step 3 of the pipeline.
5. Render presets and rules, skin uploads, editor UI.
6. Gallery with the score library's filters.
7. Later: the skillset checker, once it settles in its own repo.
