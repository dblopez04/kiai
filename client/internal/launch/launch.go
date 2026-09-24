// Package launch starts osu! through osu-winello for a preset.
package launch

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/dblopez04/kiai/client/internal/config"
	"github.com/dblopez04/kiai/client/internal/fsutil"
	"github.com/dblopez04/kiai/client/internal/paths"
)

// Session is written on every launch. A .osr file doesn't say which server a score was set on,
// so the replay watcher tags exports with the preset that started the game.
type Session struct {
	Preset string `json:"preset"`
	// Null for the official servers.
	Devserver  *string `json:"devserver"`
	LaunchedAt string  `json:"launchedAt"`
}

func WriteSession(path string, s Session) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(path, append(data, '\n'), 0o644)
}

// ReadSession returns the last recorded session, or nil if there is none or it's unreadable.
func ReadSession(path string) *Session {
	data, ok, err := fsutil.ReadFileIfExists(path)
	if err != nil || !ok {
		return nil
	}
	var s Session
	if json.Unmarshal(data, &s) != nil || s.Preset == "" {
		return nil
	}
	if _, err := time.Parse(time.RFC3339Nano, s.LaunchedAt); err != nil {
		return nil
	}
	return &s
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && syscall.Access(path, 0x1 /* X_OK */) == nil
}

// ResolveOsuWine finds osu-winello's launcher. Checked in order: the config override,
// osu-winello's install location, then $PATH. The install location comes before $PATH because
// app launchers often start programs without ~/.local/bin on $PATH.
func ResolveOsuWine(cfg config.Config, p paths.Paths, getenv paths.Getenv) (string, error) {
	if cfg.OsuWinePath != "" {
		if isExecutable(cfg.OsuWinePath) {
			return cfg.OsuWinePath, nil
		}
		return "", fmt.Errorf("osuWinePath in %s (%s) is not an executable file.", p.ConfigFile, cfg.OsuWinePath)
	}
	candidates := []string{filepath.Join(p.WinelloBinDir, "osu-wine")}
	for _, dir := range filepath.SplitList(getenv("PATH")) {
		if dir != "" {
			candidates = append(candidates, filepath.Join(dir, "osu-wine"))
		}
	}
	for _, candidate := range candidates {
		if isExecutable(candidate) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("Couldn't find osu-wine. Install osu-winello (https://github.com/NelloKudo/osu-winello), or set \"osuWinePath\" in %s.", p.ConfigFile)
}

// OsuWineArgs are the arguments for osu-wine. With none, osu-wine falls back to
// POST_LAUNCH_ARGS from its own config, which may already contain a -devserver.
func OsuWineArgs(p config.Preset) []string {
	if p.Devserver != "" {
		return []string{"--devserver", p.Devserver}
	}
	return []string{}
}

// Options are what Launch needs from the process environment; tests substitute their own.
type Options struct {
	Getenv  paths.Getenv
	Environ []string
	Now     time.Time
}

// Launch records the session, then runs osu-wine in the foreground with our stdio and returns
// its exit code (128+signal if it was killed by a signal).
func Launch(p paths.Paths, cfg config.Config, preset config.Preset, opts Options) (int, error) {
	osuWine, err := ResolveOsuWine(cfg, p, opts.Getenv)
	if err != nil {
		return 1, err
	}
	var devserver *string
	if preset.Devserver != "" {
		devserver = &preset.Devserver
	}
	session := Session{Preset: preset.Name, Devserver: devserver, LaunchedAt: opts.Now.UTC().Format("2006-01-02T15:04:05.000Z")}
	if err := WriteSession(p.SessionFile, session); err != nil {
		return 1, err
	}

	cmd := exec.Command(osuWine, OsuWineArgs(preset)...)
	cmd.Env = opts.Environ
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return 1, fmt.Errorf("Failed to start %s: %v", osuWine, err)
	}

	// Pass termination on to osu-wine (e.g. logging out of the desktop session). Ctrl+C already
	// reaches it through the terminal, so just keep waiting instead of dying first.
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGINT)
	defer func() {
		signal.Stop(signals)
		close(signals)
	}()
	go func() {
		for sig := range signals {
			if sig != syscall.SIGINT {
				_ = cmd.Process.Signal(sig)
			}
		}
	}()

	err = cmd.Wait()
	var exitErr *exec.ExitError
	if err != nil && !errors.As(err, &exitErr) {
		return 1, err
	}
	if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return 128 + int(status.Signal()), nil
	}
	return cmd.ProcessState.ExitCode(), nil
}
