# kiai

Tools for osu! players on Linux who run a homelab.

| Feature | Status |
|---|---|
| osu-winello presets with app-launcher shortcuts | **done** (client) |
| Private score library: auto-synced scores, search/filter, local PP, CSV exports | **done** (server) |
| Match database: tournament mp links and lazer ranked play, Bathbot match costs, tournament score search | **done** (server) |
| One-click replay rendering with danser, Discord DM with the link | planned: phases 3–4 |
| Render presets chosen by rules on the replay (mods, AR, server, ...) | planned: phase 5 |
| Public replay pages and gallery (Caddy + Cloudflare Tunnel) | planned: phases 4 and 6; the gallery reuses the score library's filters |
| Map skillset checker | later, once it settles in its own repo |

See [docs/architecture.md](docs/architecture.md) for the full design and roadmap.

## Client

The client runs on the PC you play on. It's a single static Go binary (~3 MB) with no
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
- **Discovery:** osu! has no "matches this player played" endpoint. Instead, kiai walks osu!'s
  list of every public stable lobby (`GET /matches`), staying two hours behind the newest one.
  It fetches the lobbies with tournament-style names (`ACR: (A) vs (B)`, qualifier lobbies) or
  your name, and keeps those you played in. Ended ranked play rooms list their players, so
  yours are queued directly. Stable gets three crawl turns out of four. The stable crawl starts
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

### Commands

```sh
docker compose exec server node packages/server/src/main.ts help   # or `npm run server -- help` outside Docker
server sync --mode history         # queue a job (recent, history, refresh; reset needs --confirm RESET)
server export --out scores.csv
server worker --once               # process one queued job and exit
server matches import history.txt  # Elitebotix /osu-history export, or any text with mp links ("-" = stdin)
server matches add https://osu.ppy.sh/mp/119283746
server matches scan-from 118000000 # stable discovery scans forward from this match id
```

### HTTP API

Same privacy rules as the pages: private hostnames only, no authentication.

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
| `GET /api/matches?…filters` | Paged matches. Filters: `q`, `sort` (`date`, `match_cost`, `maps`, `avg_score`, `accuracy`, `name`), `order`, `page`, `page_size`, `source` (`stable`, `lazer`), `with`, `vs` (comma-separated names or ids), `result` (`won`, `lost`), `played`, `tournament`, `min_cost`/`max_cost`, `min_maps`/`max_maps`, `date_from`/`date_to` |
| `GET /api/matches/:id` | One match: players with match costs, every map and score |
| `GET /api/matches/scores?…filters` | Tournament scores: the `/api/scores` filters plus `player` (`me`, `all`, a name or id), `match` and `source` |
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
