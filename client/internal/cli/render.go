package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dblopez04/kiai/client/internal/config"
	"github.com/dblopez04/kiai/client/internal/fsutil"
	"github.com/dblopez04/kiai/client/internal/kiaiapi"
	"github.com/dblopez04/kiai/client/internal/launch"
	"github.com/dblopez04/kiai/client/internal/paths"
	"github.com/dblopez04/kiai/client/internal/songs"
)

const pollInterval = 2 * time.Second

// serverSettings is the kiai server to talk to: config.json, overridden by $KIAI_SERVER_URL and
// $KIAI_UPLOAD_TOKEN.
func serverSettings(cfg config.Config, io IO) (config.Server, error) {
	server := config.Server{}
	if cfg.Server != nil {
		server = *cfg.Server
	}
	if v := io.Getenv("KIAI_SERVER_URL"); v != "" {
		server.URL = v
	}
	if v := io.Getenv("KIAI_UPLOAD_TOKEN"); v != "" {
		server.Token = v
	}
	if server.URL == "" {
		return server, fmt.Errorf("No kiai server configured. Run: kiai server set http://<homelab>:8080 --token <UPLOAD_TOKEN>")
	}
	if err := config.ValidateServerURL(server.URL); err != nil {
		return server, fmt.Errorf("Server address %q: %v", server.URL, err)
	}
	return server, nil
}

func serverCommand(args []string, io IO) error {
	p := paths.Resolve(io.Getenv)
	sub := ""
	if len(args) > 0 {
		sub, args = args[0], args[1:]
	}
	switch sub {
	case "set":
		a, err := parseArgs(args, map[string]flagKind{"token": stringFlag})
		if err != nil {
			return err
		}
		raw, err := a.onePositional("kiai server set <url> [--token <UPLOAD_TOKEN>]")
		if err != nil {
			return err
		}
		address := strings.TrimRight(strings.TrimSpace(raw), "/")
		if err := config.ValidateServerURL(address); err != nil {
			return err
		}
		cfg, err := config.Load(p.ConfigFile)
		if err != nil {
			return err
		}
		server := config.Server{URL: address}
		if cfg.Server != nil {
			server.Token = cfg.Server.Token
		}
		if token, ok := a.strings["token"]; ok {
			server.Token = strings.TrimSpace(token)
		}
		cfg.Server = &server
		if err := config.Save(p.ConfigFile, cfg); err != nil {
			return err
		}
		fmt.Fprintf(io.Out, "Server set to %s", server.URL)
		if server.Token == "" {
			fmt.Fprint(io.Out, " (no upload token yet: add one with --token)")
		}
		fmt.Fprintln(io.Out)
		return nil

	case "show", "":
		if err := (parsedArgs{positionals: args}).noPositionals("kiai server show"); err != nil {
			return err
		}
		cfg, err := config.Load(p.ConfigFile)
		if err != nil {
			return err
		}
		server, err := serverSettings(cfg, io)
		if err != nil {
			return err
		}
		token := "not set"
		if server.Token != "" {
			token = "set"
		}
		fmt.Fprintf(io.Out, "%s (upload token %s)\n", server.URL, token)
		return nil

	default:
		return fmt.Errorf(`Usage: kiai server <set|show>. Run "kiai help" for details.`)
	}
}

// songsDir is where osu! keeps beatmaps: config's songsDir, or <osu! path>/Songs as osu-winello
// recorded it.
func songsDir(cfg config.Config, p paths.Paths) (string, error) {
	if cfg.SongsDir != "" {
		return cfg.SongsDir, nil
	}
	data, ok, err := fsutil.ReadFileIfExists(p.WinelloOsuPathFile)
	if err != nil {
		return "", err
	}
	if !ok || strings.TrimSpace(string(data)) == "" {
		return "", fmt.Errorf("Couldn't find the osu! folder (%s is missing). Pass --songs <dir> or set \"songsDir\" in %s.", p.Tildify(p.WinelloOsuPathFile), p.ConfigFile)
	}
	return filepath.Join(strings.TrimSpace(string(data)), "Songs"), nil
}

// uploadLocalMap finds the replay's map in the Songs folder and uploads it as an .osz.
func uploadLocalMap(client *kiaiapi.Client, replay kiaiapi.Replay, dir string, io IO) error {
	fmt.Fprintf(io.Out, "The server can't download this map; looking for it in %s...\n", dir)
	folder, err := songs.FindFolder(dir, replay.BeatmapMD5)
	if errors.Is(err, songs.ErrNotFound) {
		return fmt.Errorf("The map this replay was played on (MD5 %s) isn't on osu!, any mirror, or in %s. Pass its .osz with --osz.", replay.BeatmapMD5, dir)
	}
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp("", "kiai-*.osz")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := songs.WriteOsz(folder, tmp); err != nil {
		tmp.Close()
		return fmt.Errorf("Couldn't pack %s: %v", folder, err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	fmt.Fprintf(io.Out, "Uploading %s...\n", filepath.Base(folder))
	return client.UploadBeatmapset(replay.ID, tmp.Name())
}

func renderCommand(args []string, io IO) (int, error) {
	a, err := parseArgs(args, map[string]flagKind{"devserver": stringFlag, "official": boolFlag, "osz": stringFlag, "songs": stringFlag, "no-wait": boolFlag})
	if err != nil {
		return 1, err
	}
	file, err := a.onePositional("kiai render <file.osr> [--devserver <host> | --official] [--osz <file>] [--songs <dir>] [--no-wait]")
	if err != nil {
		return 1, err
	}
	if _, ok := a.strings["devserver"]; ok && a.bools["official"] {
		return 1, fmt.Errorf("Use either --devserver or --official, not both.")
	}
	p := paths.Resolve(io.Getenv)
	cfg, err := config.Load(p.ConfigFile)
	if err != nil {
		return 1, err
	}
	server, err := serverSettings(cfg, io)
	if err != nil {
		return 1, err
	}

	// A .osr doesn't record the server; assume the one osu! was last launched on.
	devserver := ""
	switch {
	case a.bools["official"]:
	case a.strings["devserver"] != "":
		devserver = NormalizeDevserver(a.strings["devserver"])
	default:
		if session := launch.ReadSession(p.SessionFile); session != nil && session.Devserver != nil {
			devserver = *session.Devserver
			fmt.Fprintf(io.Out, "Tagging it as played on %s (the last preset you launched; use --devserver or --official to change).\n", devserver)
		}
	}

	client := kiaiapi.New(server.URL, server.Token)
	replay, err := client.UploadReplay(file, devserver)
	if err != nil {
		return 1, err
	}
	verb := "Uploaded"
	if !replay.Created {
		verb = "Already uploaded"
	}
	fmt.Fprintf(io.Out, "%s replay %s: %s, %s by %s\n", verb, replay.ID, replay.Title(), rankName(replay.Rank), replay.PlayerName)

	mapUploaded := false
	if osz := a.strings["osz"]; osz != "" {
		if err := client.UploadBeatmapset(replay.ID, osz); err != nil {
			return 1, err
		}
		mapUploaded = true
		fmt.Fprintln(io.Out, "Uploaded the beatmap.")
	}

	page := server.URL + "/replays/" + replay.ID
	if a.bools["no-wait"] {
		fmt.Fprintf(io.Out, "Rendering in the background: %s\n", page)
		return 0, nil
	}

	sleep := io.Sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	lastStatus, lastProgress := "", -1
	for {
		render := replay.Render
		if render == nil {
			return 1, fmt.Errorf("The server has no render for this replay. Start one at %s", page)
		}
		switch render.Status {
		case "success":
			fmt.Fprintf(io.Out, "Rendered: %s\nVideo: %s%s\n", page, server.URL, deref(render.VideoURL))
			return 0, nil
		case "failed":
			return 1, fmt.Errorf("The render failed: %s\nDetails: %s", deref(render.Error), page)
		case "needs_map":
			if mapUploaded {
				return 1, fmt.Errorf("The server still can't use the map: %s", deref(render.Error))
			}
			dir := a.strings["songs"]
			if dir == "" {
				if dir, err = songsDir(cfg, p); err != nil {
					return 1, fmt.Errorf("%s\n%v", deref(render.Error), err)
				}
			}
			if err := uploadLocalMap(client, replay, dir, io); err != nil {
				return 1, err
			}
			mapUploaded = true
		case "running":
			if render.Status != lastStatus || render.Progress >= lastProgress+10 {
				fmt.Fprintf(io.Out, "Rendering... %d%%\n", render.Progress)
				lastProgress = render.Progress
			}
		case "queued":
			if render.Status != lastStatus {
				fmt.Fprintln(io.Out, "Queued; waiting for the render worker...")
			}
		}
		lastStatus = render.Status
		sleep(pollInterval)
		if replay, err = client.GetReplay(replay.ID); err != nil {
			return 1, err
		}
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// rankName turns osu!'s grade codes into what the game shows: X -> SS, XH -> SS (silver).
func rankName(rank string) string {
	switch rank {
	case "X", "XH":
		return "SS"
	case "SH":
		return "S"
	}
	return rank
}
