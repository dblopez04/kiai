// Package cli is the kiai command line.
package cli

import (
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/dblopez04/kiai/client/internal/paths"
)

// version is set at build time: -ldflags "-X github.com/dblopez04/kiai/client/internal/cli.version=..."
var version = "0.1.0"

func help() string {
	return `kiai ` + version + `

Usage:
  kiai server set <url> [--token <UPLOAD_TOKEN>]
                                     Point kiai at your kiai server (e.g. http://homelab:8080)
  kiai server show                   Show the configured server
  kiai watch [--backlog]             Upload every replay you export (F2 in osu! stable, or lazer's
                                     export) and follow its render; --backlog also uploads old ones
  kiai watch install                 Run the watcher as a systemd user service, starting at login
  kiai watch uninstall               Stop and remove that service
  kiai render <file.osr> [options]   Upload a replay, render it on the server, and wait for the video
      --devserver <host>    Server the play was set on (default: "devserver" in config.json)
      --official            It was set on the official servers
      --osz <file>          Also upload the beatmap set it was played on
      --songs <dir>         osu! Songs folder, searched when the server can't download the map
      --no-wait             Upload and return without waiting for the render
  kiai skin upload <file.osk> [--name <name>]
                                     Upload a skin for render presets (default name: the file's)
  kiai help | --help | --version

Example:
  kiai server set http://homelab:8080 --token <UPLOAD_TOKEN>
  kiai watch install
`
}

// IO is everything the CLI takes from its process; tests substitute their own.
type IO struct {
	Getenv  paths.Getenv
	Environ []string
	Out     io.Writer
	Err     io.Writer
	Now     func() time.Time
	// The running binary, for the watcher service (os.Executable in production).
	Executable func() (string, error)
	// Waits between render status checks; nil means time.Sleep.
	Sleep func(time.Duration)
}

func DefaultIO() IO {
	return IO{Getenv: os.Getenv, Environ: os.Environ(), Out: os.Stdout, Err: os.Stderr, Now: time.Now, Executable: os.Executable}
}

// Run runs the CLI and returns the process exit code.
func Run(args []string, io IO) int {
	code, err := dispatch(args, io)
	if err != nil {
		fmt.Fprintf(io.Err, "error: %v\n", err)
		return 1
	}
	return code
}

func dispatch(args []string, io IO) (int, error) {
	if len(args) == 0 {
		fmt.Fprintln(io.Out, help())
		return 0, nil
	}
	switch args[0] {
	case "help", "--help", "-h":
		fmt.Fprintln(io.Out, help())
		return 0, nil
	case "--version", "-V":
		fmt.Fprintln(io.Out, version)
		return 0, nil
	case "server":
		return 0, serverCommand(args[1:], io)
	case "render":
		return renderCommand(args[1:], io)
	case "watch":
		return watchCommand(args[1:], io)
	case "skin":
		return 0, skinCommand(args[1:], io)
	default:
		return 1, fmt.Errorf("Unknown command %q. Run \"kiai help\" for usage.", args[0])
	}
}

var scheme = regexp.MustCompile(`^[a-z]+://`)

// NormalizeDevserver accepts what people paste: `https://Gatari.pw/` becomes `gatari.pw`.
func NormalizeDevserver(input string) string {
	host := strings.ToLower(strings.TrimSpace(input))
	host = scheme.ReplaceAllString(host, "")
	return strings.TrimRight(host, "/")
}

// selfCommand is the command that re-runs this tool, for the watcher's systemd unit.
// $KIAI_BIN overrides it, for unusual installs such as wrapper scripts.
func selfCommand(io IO) ([]string, error) {
	if bin := io.Getenv("KIAI_BIN"); bin != "" {
		return []string{bin}, nil
	}
	exe, err := io.Executable()
	if err != nil {
		return nil, fmt.Errorf("can't find the kiai binary (%v); set KIAI_BIN", err)
	}
	if strings.Contains(exe, string(os.PathSeparator)+"go-build") {
		return nil, fmt.Errorf("running from `go run`, whose binary is deleted afterwards: build it (make build) or set KIAI_BIN")
	}
	return []string{exe}, nil
}
