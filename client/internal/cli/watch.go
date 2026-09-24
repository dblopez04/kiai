package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/dblopez04/kiai/client/internal/config"
	"github.com/dblopez04/kiai/client/internal/fsutil"
	"github.com/dblopez04/kiai/client/internal/kiaiapi"
	"github.com/dblopez04/kiai/client/internal/paths"
)

const (
	watchInterval   = 3 * time.Second
	statusInterval  = 15 * time.Second
	uploadRetry     = 30 * time.Second
	watchUnitName   = "kiai-watch.service"
	maxPendingHours = 24
)

// watchState is saved between runs so each replay is uploaded once.
type watchState struct {
	// Replay files already handled, by path, with the size and mtime they had.
	Seen map[string]seenFile `json:"seen"`
	// Uploaded replays whose render hasn't finished.
	Pending []pendingRender `json:"pending"`
}

type seenFile struct {
	Size    int64  `json:"size"`
	ModTime int64  `json:"mtime"`
	Replay  string `json:"replay,omitempty"`
}

type pendingRender struct {
	Replay      string    `json:"replay"`
	File        string    `json:"file"`
	Since       time.Time `json:"since"`
	MapUploaded bool      `json:"mapUploaded,omitempty"`
}

func loadWatchState(path string) (watchState, bool, error) {
	data, ok, err := fsutil.ReadFileIfExists(path)
	state := watchState{Seen: map[string]seenFile{}}
	if err != nil || !ok {
		return state, ok, err
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return state, true, fmt.Errorf("%s is not valid JSON: %v", path, err)
	}
	if state.Seen == nil {
		state.Seen = map[string]seenFile{}
	}
	return state, true, nil
}

func saveWatchState(path string, state watchState) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(path, append(data, '\n'), 0o600)
}

// watchDirs are the folders to watch: config's watchDirs, or osu! stable's Replays folder (from
// osu-winello) plus lazer's exports folder.
func watchDirs(cfg config.Config, p paths.Paths) []string {
	if len(cfg.WatchDirs) > 0 {
		return cfg.WatchDirs
	}
	var dirs []string
	if data, ok, _ := fsutil.ReadFileIfExists(p.WinelloOsuPathFile); ok && strings.TrimSpace(string(data)) != "" {
		dirs = append(dirs, filepath.Join(strings.TrimSpace(string(data)), "Replays"))
	}
	return append(dirs, p.LazerExportsDir)
}

// watcher uploads new replays and follows their renders. tick does one round; the command
// calls it on a timer, tests call it directly.
type watcher struct {
	io        IO
	p         paths.Paths
	cfg       config.Config
	client    *kiaiapi.Client
	serverURL string
	dirs      []string
	state     watchState
	// Size seen on the previous scan for files not yet uploaded: uploaded once it stops changing.
	sizes      map[string]int64
	retryAfter map[string]time.Time
	lastStatus time.Time
	now        func() time.Time
}

func (w *watcher) log(format string, args ...any) {
	fmt.Fprintf(w.io.Out, format+"\n", args...)
}

// scan lists the .osr files in the watched folders.
func (w *watcher) scan() map[string]os.FileInfo {
	found := map[string]os.FileInfo{}
	for _, dir := range w.dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".osr") {
				continue
			}
			if info, err := entry.Info(); err == nil {
				found[filepath.Join(dir, entry.Name())] = info
			}
		}
	}
	return found
}

// markExisting records every replay already there, so starting the watcher doesn't upload the backlog.
func (w *watcher) markExisting() {
	for file, info := range w.scan() {
		w.state.Seen[file] = seenFile{Size: info.Size(), ModTime: info.ModTime().Unix()}
	}
}

func (w *watcher) tick() error {
	now := w.now()
	changed := false
	files := w.scan()
	names := make([]string, 0, len(files))
	for file := range files {
		names = append(names, file)
	}
	sort.Strings(names)
	for _, file := range names {
		info := files[file]
		if seen, ok := w.state.Seen[file]; ok && seen.Size == info.Size() && seen.ModTime == info.ModTime().Unix() {
			continue
		}
		// Wait until osu! has finished writing: the same size on two scans in a row.
		if previous, ok := w.sizes[file]; !ok || previous != info.Size() || info.Size() == 0 {
			w.sizes[file] = info.Size()
			continue
		}
		if now.Before(w.retryAfter[file]) {
			continue
		}
		devserver := w.cfg.Devserver
		replay, err := w.client.UploadReplay(file, devserver)
		if err != nil {
			w.log("upload of %s failed, retrying in %s: %v", filepath.Base(file), uploadRetry, err)
			w.retryAfter[file] = now.Add(uploadRetry)
			if apiErr, ok := err.(*kiaiapi.APIError); ok && apiErr.Status == 400 {
				// The server refused the file itself (not a standard replay): don't retry it.
				w.state.Seen[file] = seenFile{Size: info.Size(), ModTime: info.ModTime().Unix()}
				changed = true
			}
			continue
		}
		delete(w.sizes, file)
		w.state.Seen[file] = seenFile{Size: info.Size(), ModTime: info.ModTime().Unix(), Replay: replay.ID}
		server := "osu!"
		if devserver != "" {
			server = devserver
		}
		w.log("uploaded %s as replay %s: %s (%s, played by %s on %s)", filepath.Base(file), replay.ID, replay.Title(), rankName(replay.Rank), replay.PlayerName, server)
		if replay.Render != nil && replay.Render.Status != "success" {
			w.state.Pending = append(w.state.Pending, pendingRender{Replay: replay.ID, File: file, Since: now})
		}
		changed = true
	}

	if len(w.state.Pending) > 0 && now.Sub(w.lastStatus) >= statusInterval {
		w.lastStatus = now
		if w.followRenders(now) {
			changed = true
		}
	}
	if changed {
		return saveWatchState(w.p.WatchStateFile, w.state)
	}
	return nil
}

// followRenders checks pending renders: reports finished ones and uploads maps the server needs.
func (w *watcher) followRenders(now time.Time) bool {
	changed := false
	kept := w.state.Pending[:0]
	for _, pending := range w.state.Pending {
		replay, err := w.client.GetReplay(pending.Replay)
		if err != nil {
			kept = append(kept, pending)
			continue
		}
		status, reason := "", ""
		if replay.Render != nil {
			status, reason = replay.Render.Status, deref(replay.Render.Error)
		}
		switch {
		case status == "success":
			w.log("rendered %s: %s/replays/%s", replay.Title(), w.serverURL, replay.ID)
			changed = true
		case status == "failed":
			w.log("render of %s failed: %s", replay.Title(), reason)
			changed = true
		case status == "":
			w.log("replay %s has no render; start one at %s/replays/%s", replay.ID, w.serverURL, replay.ID)
			changed = true
		case status == "needs_map" && !pending.MapUploaded:
			pending.MapUploaded = true
			changed = true
			dir, err := songsDir(w.cfg, w.p)
			if err == nil {
				err = uploadLocalMap(w.client, replay, dir, w.io)
			}
			if err != nil {
				w.log("replay %s needs its map: %v", replay.ID, err)
				continue
			}
			kept = append(kept, pending)
		case status == "needs_map":
			w.log("replay %s still can't be rendered: %s", replay.ID, reason)
			changed = true
		case now.Sub(pending.Since) > maxPendingHours*time.Hour:
			w.log("stopped following replay %s: no result after %dh", replay.ID, maxPendingHours)
			changed = true
		default:
			kept = append(kept, pending)
		}
	}
	w.state.Pending = kept
	return changed
}

func newWatcher(io IO, backlog bool) (*watcher, error) {
	p := paths.Resolve(io.Getenv)
	cfg, err := config.Load(p.ConfigFile)
	if err != nil {
		return nil, err
	}
	server, err := serverSettings(cfg, io)
	if err != nil {
		return nil, err
	}
	state, existed, err := loadWatchState(p.WatchStateFile)
	if err != nil {
		return nil, err
	}
	now := io.Now
	if now == nil {
		now = time.Now
	}
	w := &watcher{
		io: io, p: p, cfg: cfg, client: kiaiapi.New(server.URL, server.Token), serverURL: server.URL,
		dirs: watchDirs(cfg, p), state: state, sizes: map[string]int64{}, retryAfter: map[string]time.Time{}, now: now,
	}
	if !existed && !backlog {
		w.markExisting()
		if err := saveWatchState(p.WatchStateFile, w.state); err != nil {
			return nil, err
		}
	}
	return w, nil
}

func watchCommand(args []string, io IO) (int, error) {
	if len(args) > 0 && (args[0] == "install" || args[0] == "uninstall") {
		return 0, watchServiceCommand(args[0], args[1:], io)
	}
	a, err := parseArgs(args, map[string]flagKind{"backlog": boolFlag})
	if err != nil {
		return 1, err
	}
	if err := a.noPositionals("kiai watch [--backlog] | kiai watch install | kiai watch uninstall"); err != nil {
		return 1, err
	}
	w, err := newWatcher(io, a.bools["backlog"])
	if err != nil {
		return 1, err
	}
	w.log("watching %s for new replays; uploading to %s", strings.Join(w.dirs, ", "), w.serverURL)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(stop)
	ticker := time.NewTicker(watchInterval)
	defer ticker.Stop()
	for {
		if err := w.tick(); err != nil {
			w.log("error: %v", err)
		}
		select {
		case <-stop:
			w.log("stopped")
			return 0, nil
		case <-ticker.C:
		}
	}
}

// findExecutable looks a program up on the PATH the CLI was given.
func findExecutable(io IO, name string) (string, error) {
	for _, dir := range filepath.SplitList(io.Getenv("PATH")) {
		candidate := filepath.Join(dir, name)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%s isn't on PATH", name)
}

func systemctl(io IO, args ...string) error {
	bin, err := findExecutable(io, "systemctl")
	if err != nil {
		return fmt.Errorf("Can't manage the service: %v. Run `kiai watch` yourself instead.", err)
	}
	cmd := exec.Command(bin, append([]string{"--user"}, args...)...)
	cmd.Env = io.Environ
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl --user %s: %v\n%s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// watchUnit is the systemd user unit that keeps `kiai watch` running.
func watchUnit(launcher []string) string {
	quoted := make([]string, len(launcher))
	for i, part := range launcher {
		quoted[i] = `"` + strings.ReplaceAll(part, `"`, `\"`) + `"`
	}
	return `[Unit]
Description=kiai replay watcher: uploads new osu! replays to your kiai server for rendering
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=` + strings.Join(quoted, " ") + ` watch
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
`
}

func watchServiceCommand(sub string, args []string, io IO) error {
	a, err := parseArgs(args, nil)
	if err != nil {
		return err
	}
	if err := a.noPositionals("kiai watch " + sub); err != nil {
		return err
	}
	p := paths.Resolve(io.Getenv)
	unit := filepath.Join(p.SystemdUserDir, watchUnitName)
	if sub == "uninstall" {
		_ = systemctl(io, "disable", "--now", watchUnitName)
		if err := os.Remove(unit); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := systemctl(io, "daemon-reload"); err != nil {
			return err
		}
		fmt.Fprintln(io.Out, "Removed the replay watcher service.")
		return nil
	}

	// Fail early, before installing a service that would only crash-loop.
	cfg, err := config.Load(p.ConfigFile)
	if err != nil {
		return err
	}
	if _, err := serverSettings(cfg, io); err != nil {
		return err
	}
	launcher, err := selfCommand(io)
	if err != nil {
		return err
	}
	if err := fsutil.WriteFileAtomic(unit, []byte(watchUnit(launcher)), 0o644); err != nil {
		return err
	}
	if err := systemctl(io, "daemon-reload"); err != nil {
		return err
	}
	if err := systemctl(io, "enable", "--now", watchUnitName); err != nil {
		return err
	}
	fmt.Fprintf(io.Out, "Installed and started %s (%s).\nIt uploads every replay you export from now on. Logs: journalctl --user -u %s -f\n", watchUnitName, p.Tildify(unit), watchUnitName)
	return nil
}
