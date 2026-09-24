# Architecture and roadmap

## Pieces

**Client** (`client/`, Go, standard library only): one static binary on the gaming PC,
later also a systemd user service.

- Presets and `.desktop` entries (done).
- Replay watcher (phase 3). osu! stable writes exported replays (F2) to `<osu path>/Replays/`,
  and osu-winello records the osu! path in `~/.local/share/osuconfig/osupath`. lazer
  writes exports to its `exports/` folder. The watcher uploads each new `.osr` with a
  token and tags it with the server from `session.json`.

**Server** (`packages/server`): docker compose on the homelab.

| Service | Job | Status |
|---|---|---|
| `server` | Private score library UI + API on :8080, and the score sync worker (`serve` runs both; `web` / `worker` split them) | done |
| `postgres` | Scores, metadata and the job queues | done |
| `render` | danser + ffmpeg + Xvfb with the GPU passed through; takes render jobs | phase 3 |
| public replay app | Replay pages and gallery only, on its own port (separate Hono app) | phase 4 |
| `caddy` | Routes the public hostname to the replay app only; serves mp4s with range requests | phase 4 |
| `cloudflared` | Tunnel, configured with a single `TUNNEL_TOKEN` | phase 4 |

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
- The replay app will share the database but never mount the private routes (`http/app.ts`).
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

## Match database

Tournament matches (stable mp lobbies) and lazer ranked play rooms, for the same one player. It
is private like the score library.

| Module | |
|---|---|
| `db/migrations/003_matches.sql` | `matches`, `match_games`, `match_scores` (same columns as `scores`, NoFail left out of `mod_acronyms`), `match_players` (match costs), view `match_score_rows`, `match_queue`, `match_discovery` |
| `matches/normalize.ts` | Stable `GET /matches/{id}` pages and lazer `GET /rooms/{id}/events` pages → one shape; tournament name parsing |
| `matches/cost.ts` | Bathbot's match cost (`process_match`), per-game winners, sides and score line. Pure |
| `matches/store.ts` | Fetch every event page (101 per request), save, local PP (rosu-pp, without NF), recompute match costs |
| `matches/queue.ts` | Fetch queue: requested (0) → refreshing in-progress matches (1) → discovery probes (2); backoff, permanent failures for private/missing matches |
| `matches/discovery.ts` | Stable crawler over `GET /matches?sort=id_asc` (cursor = base64url JSON `{"match_id"}`), two hours behind, probing tournament-style names; lazer crawler over ended ranked play rooms with a watermark |
| `matches/worker.ts` | Queue first, then crawl (stable 3 turns in 4). Runs next to the sync worker with the same rate limiter |
| `matches/query.ts` | Match filters relative to the player (with/against/result/match cost), match detail, tournament score search on `match_score_rows` through `scoreConditions` |
| `http/match-routes.ts`, `http/match-views.ts` | Pages and API |

Things that are not verified against live osu! yet (the tests use fakes): the ranked play room
listing's cursor (`{"ends_at", "id"}` for `sort=ended`), whether `recent_participants` always
includes both ranked play players, and ranked play's `details.teams` shape. Ranked play is
decided by more than map wins, so its score line only counts maps won.

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
   web UI, compose). Match database: Elitebotix import, discovery, Bathbot match costs,
   tournament score search.
3. Render MVP: upload endpoint, map fetching, render container, one hard-coded preset;
   `kiai render <file.osr>` by hand. Link each replay to its `scores` row when osu!
   has the score, so the gallery can filter replays with `scores/query.ts`.
4. Replay watcher (systemd user unit), Discord notification, the public replay app on its
   own port, Caddy and cloudflared.
5. Render presets and rules, skin uploads, editor UI.
6. Gallery with the score library's filters.
7. Later: the skillset checker, once it settles in its own repo.
