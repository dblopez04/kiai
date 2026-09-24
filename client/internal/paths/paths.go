// Package paths resolves every filesystem location the client reads or writes.
package paths

import (
	"os"
	"path/filepath"
	"strings"
)

// Getenv looks up an environment variable; tests substitute their own.
type Getenv func(string) string

type Paths struct {
	Home string
	// Our own preset list and settings.
	ConfigFile string
	// Which preset launched osu! most recently; the replay watcher tags uploads with it.
	SessionFile string
	// Where .desktop entries go so app launchers pick them up.
	ApplicationsDir string
	// osu-winello installs `osu-wine` here (it honours $BINDIR the same way).
	WinelloBinDir string
	// Icon osu-winello installs for its own desktop entry.
	WinelloIcon string
	// osu-winello writes the osu! stable install path into this file.
	WinelloOsuPathFile string
	// Replays the watcher has already seen or uploaded.
	WatchStateFile string
	// lazer writes exported replays here (its default data folder on Linux).
	LazerExportsDir string
	// systemd user units, for the watcher service.
	SystemdUserDir string
}

func Resolve(getenv Getenv) Paths {
	home := getenv("HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	// The XDG spec says relative values are invalid and must be ignored.
	xdg := func(name, fallback string) string {
		if value := getenv(name); value != "" && filepath.IsAbs(value) {
			return value
		}
		return filepath.Join(home, fallback)
	}
	configHome := xdg("XDG_CONFIG_HOME", ".config")
	dataHome := xdg("XDG_DATA_HOME", ".local/share")
	stateHome := xdg("XDG_STATE_HOME", ".local/state")

	binDir := getenv("BINDIR")
	if binDir == "" {
		binDir = filepath.Join(home, ".local", "bin")
	}

	return Paths{
		Home:               home,
		ConfigFile:         filepath.Join(configHome, "kiai", "config.json"),
		SessionFile:        filepath.Join(stateHome, "kiai", "session.json"),
		ApplicationsDir:    filepath.Join(dataHome, "applications"),
		WinelloBinDir:      binDir,
		WinelloIcon:        filepath.Join(dataHome, "icons", "osu-wine.png"),
		WinelloOsuPathFile: filepath.Join(dataHome, "osuconfig", "osupath"),
		WatchStateFile:     filepath.Join(stateHome, "kiai", "watch.json"),
		LazerExportsDir:    filepath.Join(dataHome, "osu", "exports"),
		SystemdUserDir:     filepath.Join(configHome, "systemd", "user"),
	}
}

// Tildify replaces the home directory prefix with `~` for friendlier output.
func (p Paths) Tildify(path string) string {
	if path == p.Home {
		return "~"
	}
	if strings.HasPrefix(path, p.Home+string(filepath.Separator)) {
		return "~" + path[len(p.Home):]
	}
	return path
}
