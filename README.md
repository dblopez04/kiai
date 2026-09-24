# kiai

Tools for osu! players on Linux who run a homelab.

| Feature | Status |
|---|---|
| osu-winello presets with app-launcher shortcuts | **done** (client) |
| Private score library: auto-synced scores, search/filter, local PP, CSV exports | **done** (server) |
| Replay rendering with danser on the homelab GPU: `kiai render <file.osr>` | **done** (client + server) |
| Automatic uploads from the replay watcher, Discord DM with the link | planned: phase 4 |
| Render presets chosen by rules on the replay (mods, AR, server, ...) | planned: phase 5 |
| Public replay pages and gallery (Caddy + Cloudflare Tunnel) | planned: phases 4 and 6; the gallery reuses the score library's filters |
| Map skillset checker | later, once it settles in its own repo |

See [docs/architecture.md](docs/architecture.md) for the full design and roadmap.

## Client

The client runs on the PC you play on. It's a single static Go binary (~7 MB) with no
runtime to install. It needs [osu-winello](https://github.com/NelloKudo/osu-winello).

### Install

```sh
cd client && make build        # needs Go 1.27+ (sudo dnf install golang)
install -m755 dist/kiai-linux-x64 ~/.local/bin/kiai
```

### Presets

A preset starts osu! stable through osu-winello, optionally on a private server
(`osu-wine --devserver <host>`), and gets its own app-launcher entry.

```sh
kiai preset add gatari --devserver gatari.pw
# -> "osu! (gatari.pw)" appears in your app launcher; searching "gatari" finds it

kiai preset add akatsuki --devserver akatsuki.gg --label "osu! (akatsuki relax)" --keyword relax
kiai preset add bancho                  # official servers
kiai preset list
kiai preset remove akatsuki
kiai preset sync                        # rewrite entries, e.g. after moving the binary
kiai launch gatari                      # what the launcher entries run
```

Files:

| Path | What |
|---|---|
| `~/.config/kiai/config.json` | Presets. Safe to hand-edit; run `preset sync` afterwards. `"osuWinePath"` overrides where `osu-wine` is found. |
| `~/.local/share/applications/kiai-<name>.desktop` | Launcher entries. kiai only touches files it created (they carry `X-Kiai-Preset`). |
| `~/.local/state/kiai/session.json` | The preset that last launched osu!. The replay watcher will use it to tag exports with a server, since `.osr` files don't record one. |

The entries run `kiai launch <name>` rather than `osu-wine` directly so the session
can be recorded first.

**Official-server presets** run plain `osu-wine`. In that case osu-winello applies
`POST_LAUNCH_ARGS` from its own config, so if you put a `-devserver` there, "bancho" will
actually connect to that server. Use presets for server selection instead.

### Rendering replays

`kiai render` uploads a replay to your kiai server, which renders it with danser, and waits for
the video. Point the client at the server once, with the server's `UPLOAD_TOKEN`:

```sh
kiai server set http://homelab:8080 --token <UPLOAD_TOKEN>
kiai render ~/.local/share/osu-wine/osu!/Replays/some-replay.osr
# Uploaded replay k3v9x2mq7a: Artist - Song [Insane], S by you
# Rendering... 40%
# Rendered: http://homelab:8080/replays/k3v9x2mq7a
```

- A .osr doesn't record which server the play was set on. kiai assumes the server of the preset
  you launched last. Override it with `--devserver <host>` or `--official`.
- The server downloads the map from a mirror. For maps no mirror has (unsubmitted, edited, or
  updated since you played), it asks for the map, and kiai uploads it from your osu! Songs folder,
  found through osu-winello, without video backgrounds. Pass `--songs <dir>` or `--osz <file>` to
  choose it yourself.
- `--no-wait` returns straight after the upload. Uploading the same file again returns the
  existing replay.
- `KIAI_SERVER_URL` and `KIAI_UPLOAD_TOKEN` override the saved server for one run.

## Server

The server runs on the homelab: PostgreSQL plus one container with the score library's web
UI and its sync worker.

**The score library is private.** It keeps one player's scores (yours) and has no login, so
it must only be reachable from your own machine or network. Compose publishes it on
`127.0.0.1:8080`. Replay pages will be the only public part, served on a separate port. As a
backstop, the score library refuses any request addressed to a public hostname or carrying
tunnel/CDN headers (for example from cloudflared). A proxy pointed at the wrong port then
fails closed. This also blocks DNS-rebinding attacks and writes from other websites.

### Install

1. Create an osu! OAuth application at <https://osu.ppy.sh/home/account/edit#oauth>. Any name
   and callback URL work: the server only reads public data with the app's own token, so
   nobody signs in with osu!.
2. `cp .env.example .env` and fill in `OSU_USER`, `OSU_CLIENT_ID`, `OSU_CLIENT_SECRET` and
   `POSTGRES_PASSWORD`.
3. `docker compose up -d`, open <http://localhost:8080>, and click **Import history**.

To use it from other devices, publish the port on your LAN IP instead of 127.0.0.1, or reach
it over Tailscale or an SSH tunnel. If you use a hostname other than an IP, a single-label
name, or a `.local`/`.lan`/`.home.arpa`/`.internal`/`.ts.net` name, add it to `PRIVATE_HOSTS`.

### Score library

It keeps every successful osu!standard play (stable and lazer), and survives osu! forgetting
them. Overwritten and deleted scores stay in the library.

- **Sync recent** imports the last `RECENT_WINDOW_HOURS` of plays. The worker also queues this
  automatically every `SYNC_INTERVAL_HOURS`.
- **Import history** walks your profile's "most played" list, fetches full details for each
  osu!standard map, then checks your scores on every one of those maps. It saves progress
  after each page and each map, so a failed or interrupted import resumes where it stopped.
  It re-fetches recent plays every 15 minutes while it runs. It can take hours, and it can't
  recover plays osu! no longer has.
- **Refresh all PP** re-reads every saved score from osu!: it takes current official PP,
  checks whether the score's link still works, and calculates PP locally for scores that are
  gone. Nothing is deleted.
- **Reset and reimport** (type `RESET` to confirm) writes a CSV backup, archives every row
  into `score_archives`, clears the library in the same transaction, then runs a history
  import. Maps found in earlier imports are remembered, so they're still checked.
- **Local PP**: rosu-pp (`rosu-pp-js@4.0.1`) with the full mod settings, stable/lazer
  scoring and lazer tick statistics, for plays osu! gives no PP (loved, unranked, deleted).
  It's an estimate and is marked with `*`. Plays with Wind Up/Wind Down/Adaptive Speed get
  none.
- **Search and filters**: title/artist/difficulty words, rank, map status, PP, stars and
  speed ranges, and best score per map. Each mod cycles through required, optional and
  excluded. Without **Exact mods**, DT also matches NC, HT matches DC and SD matches PF;
  with it, only the required and optional mods may appear. **NM only** means no mods or
  Classic alone.
- **CSV**: after every successful job the worker writes
  `data/exports/osu-scores-<user>-run-<run>.csv` (owner-readable only). The dashboard can
  also export everything, or just the current filter. Cells that look like spreadsheet
  formulas are neutralized.

Jobs run one at a time, since they share osu!'s rate limit (one request per 1.1 s). Each job
holds a lease it renews every 15 s. If a worker dies, its job is taken over after five
minutes.

### Rendering

The render worker runs danser 0.11 in its own x86_64 container (`render.Dockerfile`), sharing the
database and the `data` volume with the server. Uploads arrive on the private port, so the gaming
PC must be able to reach it: publish 8080 on your LAN IP or use Tailscale (see Install above).

1. Set `UPLOAD_TOKEN` in `.env` (`openssl rand -hex 24`).
2. Start a worker with the profile for your hardware:
   - NVIDIA: `docker compose --profile nvidia up -d`. This needs the NVIDIA driver and
     [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
     on the host. It encodes with NVENC (`h264_nvenc`; Pascal cards like the GTX 1050 Ti have no AV1).
   - No GPU: `docker compose --profile cpu up -d` encodes with x264 on the CPU.
3. On the gaming PC: `kiai server set http://<homelab>:8080 --token <UPLOAD_TOKEN>`, then
   `kiai render <file.osr>`.

How a render goes:

- **Map:** the replay names its map by the .osu file's MD5. The worker asks osu! which set that
  is, then downloads the `.osz` from the first of `MAP_MIRRORS` that has it. If the mirror's copy
  is outdated, it uses the current `.osu` from osu!. If osu! doesn't know the MD5, the render waits
  in *needs the beatmap* until the client uploads the set, which re-queues it. Maps are kept in
  `data/songs` and reused.
- **Render:** `danser-cli` under `xvfb-run`, with base settings in `<danser>/settings/kiai.json`
  (Songs, Skins and output folders, encoder) and the preset as a `-sPatch`. There is one preset
  for now: 1080p60 with danser's default skin. Videos land in `data/videos`.
- **Score library:** each replay from the official servers is linked to its play in the library,
  by stable's online score id, or by map, player name, combo, hit counts and score. Replays uploaded
  before their play is synced get linked after the next sync.
- **Queue:** renders run one at a time per worker (`RENDER_CONCURRENCY`). Workers lease jobs like
  sync jobs do. A render whose worker dies goes back to the queue, and fails after three such tries.
  A render still running after `RENDER_TIMEOUT_MINUTES` is stopped.

Rendered replays are listed at <http://localhost:8080/replays> (private, like the score library),
where you can watch or download them and render again. Public replay pages come in phase 4.

### Commands

```sh
docker compose exec server node packages/server/src/main.ts help   # or `npm run server -- help` outside Docker
server sync --mode history         # queue a job (recent, history, refresh; reset needs --confirm RESET)
server export --out scores.csv
server worker --once               # process one queued job and exit
server render-worker [--once]      # the render worker (what the render containers run)
```

### HTTP API

Same privacy rules as the pages: private hostnames only. Uploads also need `UPLOAD_TOKEN`.

| Endpoint | |
|---|---|
| `GET /api/scores?…filters` | Paged scores. Filters: `q`, `sort` (`ended_at`, `pp`, `accuracy`, `total_score`, `max_combo`), `order`, `page`, `page_size`, `rank`, `mods`, `mods_optional`, `mods_excluded`, `mods_exact`, `nomod`, `best_only`, `status`, `mode_int`, `beatmap_id`, `min_pp`/`max_pp`, `min_stars`/`max_stars`, `min_rate`/`max_rate`, `perfect`, `date_from`/`date_to` |
| `GET /api/scores/export?…filters` | The same filters as CSV |
| `GET /api/scores/stats` | Whole-library totals and rank distribution |
| `GET /api/scores/:id` | One score |
| `POST /api/scores/:id/link` | Check the score still exists on osu! (cached for an hour) |
| `GET /api/sync` | Recent jobs and their progress |
| `POST /api/sync` | `{"mode": "recent" \| "history" \| "refresh"}` queues a job |
| `GET /api/player` | The player's profile |
| `POST /api/replays?devserver=<host>` | Upload a .osr (raw body, `Authorization: Bearer <UPLOAD_TOKEN>`). Queues a render; returns the replay. `devserver` is omitted for the official servers |
| `GET /api/replays`, `GET /api/replays/:id` | Replays with their latest render: `queued`, `running` (with `progress`), `needs_map`, `success` (with `video_url`) or `failed` (with `error`) |
| `PUT /api/replays/:id/beatmapset` | Upload the .osz a replay was played on (raw body, bearer token). Refused if it lacks that exact difficulty |
| `POST /api/replays/:id/render` | Render again |
| `GET /replays/:id/video` | The rendered mp4, with byte ranges |

## Development

- **Server:** Node 22.18+ (TypeScript runs directly via Node's type stripping, so there's no
  build step), plus docker or podman for the test database.
- **Client:** Go 1.27+. It has no dependencies outside the standard library.

```sh
npm install
npm run db:up            # PostgreSQL on localhost:55432 (dev db "kiai", tests use "kiai_test")
npm test                 # server tests (vitest); each file gets its own schema
npm run typecheck        # tsc (TypeScript 7)
npm run server -- serve  # run the server from source, reading .env

cd client
make test                # go test ./...
make build               # dist/kiai-linux-{x64,arm64}, static
```

Without a local Go toolchain, the client can be built and tested in a container:
`podman run --rm -v "$PWD/client:/src:Z" -w /src docker.io/library/golang:1.27 make test build`.

Server code is limited to TypeScript syntax Node can strip (`erasableSyntaxOnly`): no enums,
namespaces or parameter properties. Relative imports use the `.ts` extension.
