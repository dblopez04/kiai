# kiai

Tools for osu! players on Linux who run a homelab.

| Feature | Status |
|---|---|
| Private score library: auto-synced scores, search/filter, local PP, CSV exports | **done** (server) |
| Match database: tournament mp links and lazer ranked play, Bathbot match costs, tournament score search | **done** (server) |
| Replay rendering with danser on the homelab GPU: `kiai render <file.osr>` | **done** (client + server) |
| Replay watcher (systemd user service), Discord DM or webhook with the link | **done** (client + server) |
| Render presets chosen by rules on the replay (mods, AR, server, ...), skin uploads, editor | **done** (server + client) |
| Public replay pages with inline Discord video (Caddy + Cloudflare Tunnel) | **done** (server) |
| Public gallery with the score library's filters | planned: phase 6 |
| Map skillset checker | later, once it settles in its own repo |

See [docs/architecture.md](docs/architecture.md) for the full design and roadmap.

## Client

The client runs on the PC you play on. It's a single static Go binary (~7 MB) with no
runtime to install. It watches for replays you export and sends them to your kiai server to be
rendered.

### Install

```sh
cd client && make build        # needs Go 1.27+ (sudo dnf install golang)
install -m755 dist/kiai-linux-x64 ~/.local/bin/kiai
kiai server set http://homelab:8080 --token <UPLOAD_TOKEN>   # the server's UPLOAD_TOKEN
```

### Replay watcher

The watcher uploads every replay you export to your kiai server, which renders it with danser:

```sh
kiai watch install     # a systemd user service that starts at login
journalctl --user -u kiai-watch -f
kiai watch uninstall
```

- It watches osu! stable's `Replays` folder (where F2 exports go) and lazer's
  `~/.local/share/osu/exports`. It finds osu! stable through the path
  [osu-winello](https://github.com/NelloKudo/osu-winello) records. Set `"watchDirs"` in
  `config.json` to watch other folders.
- A replay is uploaded once osu! has finished writing it. A .osr doesn't record which server
  the play was set on, so uploads are tagged with `"devserver"` from `config.json`, or as
  official-server plays if it's unset.
- The watcher then follows the render, uploads the map from your Songs folder if the server
  needs it, and logs the link. With Discord set up on the server, you also get a DM.
- Replays already there when the watcher first starts are skipped. `kiai watch --backlog` (run by
  hand) uploads them too.

### Rendering by hand

`kiai render` does the same for one replay and waits for the video:

```sh
kiai render ~/.local/share/osu-wine/osu!/Replays/some-replay.osr
# Uploaded replay k3v9x2mq7a: Artist - Song [Insane], S by you
# Rendering... 40%
# Rendered: http://homelab:8080/replays/k3v9x2mq7a
```

- `--devserver <host>` or `--official` overrides the configured server for this replay.
- The server downloads the map from a mirror. For maps no mirror has (unsubmitted, edited, or
  updated since you played), it asks for the map, and kiai uploads it from your osu! Songs folder
  without video backgrounds. Pass `--songs <dir>` or `--osz <file>` to choose it yourself.
- `--no-wait` returns straight after the upload. Uploading the same file again returns the
  existing replay.
- `KIAI_SERVER_URL` and `KIAI_UPLOAD_TOKEN` override the saved server for one run.
- `kiai skin upload <file.osk>` adds a skin for render presets.

### Files

| Path | What |
|---|---|
| `~/.config/kiai/config.json` | The server and upload token (`kiai server set`). Safe to hand-edit: `"devserver"` (e.g. `"gatari.pw"`) is the osu! server you play on, `"watchDirs"` and `"songsDir"` override where replays and maps are found. |
| `~/.local/state/kiai/watch.json` | Replays the watcher has already uploaded, and renders it's following. |
| `~/.config/systemd/user/kiai-watch.service` | The watcher service, written by `kiai watch install`. |

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

### Match database

**Matches** keeps your tournament matches (stable mp links) and lazer ranked play rooms. Each
match has every map played and every player's score.

- **Getting your history:** in Discord, run Elitebotix's `/osu-history` with
  `onlymatchhistory: True`. Paste the text file it sends into **Import**, or upload it (or run
  `server matches import history.txt`). Any text with mp links or
  `osu.ppy.sh/multiplayer/rooms/<id>` links works too, and so does **Add** with a single link or
  id. Elitebotix hides recent qualifier links; kiai counts and skips them.
- **Discovery:** osu! has no "matches this player played" endpoint for stable. Instead, kiai
  walks osu!'s list of every public stable lobby (`GET /matches`), staying two hours behind the
  newest one. It fetches the lobbies with tournament-style names (`ACR: (A) vs (B)`, qualifier
  lobbies) or your name, and keeps those you played in. Ranked play rooms come from your
  profile's ranked play history (`osu.ppy.sh/users/<id>/ranked-play`), so all of them are queued
  directly. Stable gets three crawl turns out of four. The stable crawl starts
  at the newest lobby; **Scan from match id** (or `server matches scan-from <id>`) backfills from
  an older match, for example to catch qualifiers Elitebotix hid. Pause either crawler on the
  page, or set `MATCH_DISCOVERY=false`.
- **Match costs** use [Bathbot's formula](https://github.com/MaxOhn/Bathbot), so they match its
  `<matchcosts`. Each map's score is divided by that map's average and the results are
  averaged, plus 0.5. That is multiplied by up to 1.5 for playing every map and by 1.02 for each
  mod combination beyond two (NoFail doesn't count). A tiebreaker adds up to 0.5. Zero scores
  are left out. Each match page can set warmups, maps to skip at the end, and an EZ multiplier;
  changing them recalculates the match.
- **Searching matches:** by name, teammates (**With**: players on your side), opponents
  (**Against**), result, source, match cost, maps played and date. Sort by date, match cost,
  maps, average score, accuracy or name. In a 1v1 the other player is your opponent. In a
  qualifier or free-for-all lobby, everyone else counts as an opponent.
- **Tournament scores** searches every score in saved matches with the score library's filters
  (mods, PP, stars, speed, rank, best per map...), plus player (you, anyone, or `all`), match
  name and source. NoFail is ignored in mod filters, since tournaments force it, so NM means
  no other mods. osu! gives stable multiplayer scores no PP, so it's calculated locally with
  rosu-pp, without NoFail (marked `*`). Ranked play scores keep osu!'s PP when osu! has it.
- Matches still in progress are fetched again every 10 minutes for up to a day. Private or
  missing matches are listed as failed, with **Retry** and **Forget** buttons.

The match worker runs next to the sync worker in `serve` and `worker`, sharing the rate limit.
A long history import slows it down but doesn't stop it.

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
  (Songs, Skins and output folders, encoder) and the preset as a `-sPatch`. The preset is picked by
  your rules (see below) once the map's attributes are known. Videos land in `data/videos`.
- **Score library:** each replay from the official servers is linked to its play in the library,
  by stable's online score id, or by map, player name, combo, hit counts and score. Replays uploaded
  before their play is synced get linked after the next sync.
- **Queue:** renders run one at a time per worker (`RENDER_CONCURRENCY`). Workers lease jobs like
  sync jobs do. A render whose worker dies goes back to the queue, and fails after three such tries.
  A render still running after `RENDER_TIMEOUT_MINUTES` is stopped.

Rendered replays are listed at <http://localhost:8080/replays> (private, like the score library),
where you can watch or download them and render again, with the rules or a preset you pick.

### Presets, rules and skins

<http://localhost:8080/render> (private) edits how replays are rendered:

- **Presets** are a skin plus a JSON patch over danser's settings (keys as in danser's
  `settings/default.json`), e.g. `{"Recording": {"FrameWidth": 1280, "FrameHeight": 720}}`. The
  `default` preset (1080p60, danser's own skin) can't be deleted. kiai keeps `General`,
  `Recording.OutputDir` and `Recording.Container` to itself.
- **Rules** are checked top to bottom; the first enabled one that matches picks the preset, and
  `default` is used when none does. A rule is conditions joined by `and`:

  ```
  HD and ar < 10.3           → hd       (mods: a bare acronym, or mods has DT / mods lacks HD)
  ar >= 10.3                 → fast     (ar od cs hp stars bpm length pp accuracy combo misses rate)
  server = gatari.pw         → gatari   (server: `official` for osu!'s own; also player, rank)
  ```

  Map values are after mods (AR 9 with DT is 10.33, via rosu-pp), and DT also matches NC, as in the
  score filters. For "or", add another rule.
- **Dry run** shows which rule a replay would hit, with the values the rules saw.
- **Skins**: upload an `.osk` on the page, or from the gaming PC with
  `kiai skin upload "<file>.osk" [--name <name>]`. Archives that wrap everything in one folder are
  flattened. Uploading a skin with an existing name replaces it.

### Public replay pages and Discord

Replay pages are the only public part. They're a separate app (`server public`, the `public`
service) on its own port, 8081, with no route into the score library. It shows only replays
that have a finished render: `/r/<id>` (video, map, mods, accuracy, pp), `/r/<id>/video.mp4` (with
byte ranges), and a list of recent renders at `/`. The pages carry `og:video` tags, so a link
posted in Discord plays inline.

To put it online through Cloudflare Tunnel:

1. In Cloudflare Zero Trust, create a tunnel and give it a public hostname (e.g.
   `replays.example.com`) whose service is `http://caddy:80`.
2. In `.env`, set `TUNNEL_TOKEN` and `PUBLIC_URL=https://replays.example.com`.
3. `docker compose --profile tunnel up -d`. cloudflared forwards to Caddy (`deploy/Caddyfile`), and
   Caddy proxies to the public app only.

Cloudflare's terms restrict serving lots of video through its proxy. A few personal replay links
are low volume, but it's a gray area.

Notifications: when a render finishes or fails, the render worker posts to Discord. Configure one
of these in `.env`:
- **DM:** `DISCORD_BOT_TOKEN` and `DISCORD_USER_ID`. Create a bot in the Discord developer portal and
  add it to any server you're in; bots can only DM people they share a server with.
- **Webhook:** `DISCORD_WEBHOOK_URL`, for a channel (e.g. a private one on your own server).

The message is the public link (which Discord turns into a playable video) plus an embed with the
map, grade, accuracy, combo, pp and mods. pp is osu!'s when the play is in the score library,
otherwise rosu-pp's estimate (marked `*`).

### Commands

```sh
docker compose exec server node packages/server/src/main.ts help   # or `npm run server -- help` outside Docker
server sync --mode history         # queue a job (recent, history, refresh; reset needs --confirm RESET)
server export --out scores.csv
server worker --once               # process one queued job and exit
server render-worker [--once]      # the render worker (what the render containers run)
server public                      # the public replay pages on PUBLIC_PORT
server matches import history.txt  # Elitebotix /osu-history export, or any text with mp links ("-" = stdin)
server matches add https://osu.ppy.sh/mp/119283746
server matches scan-from 118000000 # stable discovery scans forward from this match id
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
| `POST /api/replays/:id/render` | Render again: `{"preset": "hd"}`, or no body to let the rules pick |
| `GET /api/render/presets`, `GET /api/render/rules` | Presets (and skins), and rules in order |
| `GET /api/render/dry-run?replay=<id>` | Which preset the rules pick for a replay, and why |
| `PUT /api/skins/:name` | Upload an .osk (raw body, bearer token); replaces a skin of that name |
| `GET /replays/:id/video` | The rendered mp4, with byte ranges |
| `GET /api/matches?…filters` | Paged matches. Filters: `q`, `sort` (`date`, `match_cost`, `maps`, `avg_score`, `accuracy`, `name`), `order`, `page`, `page_size`, `hide` (match types to leave out: `tournament`, `romai`, `etx`, `omm` for the ROMAI, ETX and o!mm matchmaking bots, `ranked` for ranked play; comma-separated), `with`, `vs` (comma-separated names or ids), `result` (`won`, `lost`), `played`, `min_cost`/`max_cost`, `min_maps`/`max_maps`, `date_from`/`date_to` |
| `GET /api/matches/:id` | One match: players with match costs, every map and score |
| `GET /api/matches/scores?…filters` | Tournament scores: the `/api/scores` filters plus `player` (`me`, `all`, a name or id), `match` and `hide` |
| `GET /api/matches/stats` | Record, match costs and tournament count |
| `GET /api/matches/queue` | Fetch queue and discovery progress |
| `POST /api/matches/import` | `{"text": "..."}` queues every match link in the text |

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
