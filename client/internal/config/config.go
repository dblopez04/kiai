// Package config holds the client's settings in ~/.config/kiai/config.json.
package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/dblopez04/kiai/client/internal/fsutil"
)

// devserver is a hostname with an optional port, e.g. `gatari.pw` or `localhost:8080`.
var devserver = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$`)

// Server is the kiai server on the homelab that renders replays.
type Server struct {
	// Base URL of the private app, e.g. http://homelab:8080.
	URL string `json:"url"`
	// The server's UPLOAD_TOKEN.
	Token string `json:"token,omitempty"`
}

type Config struct {
	Version int `json:"version"`
	// The osu! server you play on (as `osu-wine --devserver` takes it). Uploads are tagged with
	// it, since a .osr doesn't record one. Empty means the official servers.
	Devserver string `json:"devserver,omitempty"`
	// Overrides the osu! Songs folder searched for maps no mirror has (default: <osu! path>/Songs).
	SongsDir string `json:"songsDir,omitempty"`
	// Folders the replay watcher checks for new .osr files (default: osu! stable's Replays folder
	// and lazer's exports folder).
	WatchDirs []string `json:"watchDirs,omitempty"`
	Server    *Server  `json:"server,omitempty"`
}

func Empty() Config {
	return Config{Version: 1}
}

// ValidDevserver reports whether host is a bare hostname such as gatari.pw.
func ValidDevserver(host string) bool {
	return devserver.MatchString(host)
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
	if cfg.Devserver != "" && !ValidDevserver(cfg.Devserver) {
		problems = append(problems, "devserver: expected a hostname such as gatari.pw")
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
