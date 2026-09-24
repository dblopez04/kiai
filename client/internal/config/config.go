// Package config holds the preset list in ~/.config/kiai/config.json.
package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/dblopez04/kiai/client/internal/fsutil"
)

// PresetName keeps names safe for file names and command lines.
var PresetName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// devserver is a hostname with an optional port, e.g. `gatari.pw` or `localhost:8080`.
var devserver = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$`)

type Preset struct {
	Name string `json:"name"`
	// Passed to `osu-wine --devserver`. Empty means the official servers.
	Devserver string `json:"devserver,omitempty"`
	// Launcher display name; defaults to `osu! (<devserver or name>)`.
	Label string `json:"label,omitempty"`
	// Icon path or theme icon name; defaults to the icon osu-winello installs.
	Icon string `json:"icon,omitempty"`
	// Extra launcher search terms on top of the generated ones.
	Keywords []string `json:"keywords"`
}

// Server is the kiai server on the homelab that renders replays.
type Server struct {
	// Base URL of the private app, e.g. http://homelab:8080.
	URL string `json:"url"`
	// The server's UPLOAD_TOKEN.
	Token string `json:"token,omitempty"`
}

type Config struct {
	Version int `json:"version"`
	// Overrides where `osu-wine` is looked up.
	OsuWinePath string `json:"osuWinePath,omitempty"`
	// Overrides the osu! Songs folder searched for maps no mirror has (default: <osu! path>/Songs).
	SongsDir string `json:"songsDir,omitempty"`
	// Folders the replay watcher checks for new .osr files (default: osu! stable's Replays folder
	// and lazer's exports folder).
	WatchDirs []string `json:"watchDirs,omitempty"`
	Server    *Server  `json:"server,omitempty"`
	Presets   []Preset `json:"presets"`
}

func Empty() Config {
	return Config{Version: 1, Presets: []Preset{}}
}

// Problems lists what's wrong with a preset, prefixed with `prefix` (e.g. "presets.0.").
func (p Preset) problems(prefix string) []string {
	var out []string
	if !PresetName.MatchString(p.Name) {
		out = append(out, prefix+"name: lowercase letters, digits, '-' and '_' only, starting with a letter or digit")
	}
	if p.Devserver != "" && !devserver.MatchString(p.Devserver) {
		out = append(out, prefix+"devserver: expected a hostname such as gatari.pw")
	}
	for i, keyword := range p.Keywords {
		if keyword == "" {
			out = append(out, fmt.Sprintf("%skeywords.%d: must not be empty", prefix, i))
		}
	}
	return out
}

// Validate checks user input for a new preset.
func (p Preset) Validate() error {
	if problems := p.problems(""); len(problems) > 0 {
		return fmt.Errorf("Invalid preset:\n  %s", strings.Join(problems, "\n  "))
	}
	return nil
}

// ValidateServerURL accepts an http(s) base URL such as http://homelab:8080.
func ValidateServerURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("expected the server's address, such as http://homelab:8080")
	}
	return nil
}

func Load(path string) (Config, error) {
	data, ok, err := fsutil.ReadFileIfExists(path)
	if err != nil {
		return Config{}, err
	}
	if !ok {
		return Empty(), nil
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("%s is not valid JSON: %v", path, err)
	}
	var problems []string
	if cfg.Version != 1 {
		problems = append(problems, "version: expected 1")
	}
	if cfg.Presets == nil {
		cfg.Presets = []Preset{}
	}
	for i := range cfg.Presets {
		if cfg.Presets[i].Keywords == nil {
			cfg.Presets[i].Keywords = []string{}
		}
		problems = append(problems, cfg.Presets[i].problems(fmt.Sprintf("presets.%d.", i))...)
	}
	if cfg.Server != nil {
		if err := ValidateServerURL(cfg.Server.URL); err != nil {
			problems = append(problems, "server.url: "+err.Error())
		}
	}
	if len(problems) > 0 {
		return Config{}, fmt.Errorf("%s is invalid:\n  %s", path, strings.Join(problems, "\n  "))
	}
	return cfg, nil
}

func Save(path string, cfg Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	// Owner-only: it can hold the server's upload token.
	return fsutil.WriteFileAtomic(path, append(data, '\n'), 0o600)
}

// Index returns the position of the named preset, or -1.
func (c Config) Index(name string) int {
	for i, p := range c.Presets {
		if p.Name == name {
			return i
		}
	}
	return -1
}

func (c Config) Find(name string) (Preset, error) {
	if i := c.Index(name); i >= 0 {
		return c.Presets[i], nil
	}
	names := make([]string, len(c.Presets))
	for i, p := range c.Presets {
		names[i] = p.Name
	}
	known := strings.Join(names, ", ")
	if known == "" {
		known = "none yet"
	}
	return Preset{}, fmt.Errorf("No preset named %q (known presets: %s).", name, known)
}
