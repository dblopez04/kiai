// Package cli is the kiai command line.
package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/dblopez04/kiai/client/internal/config"
	"github.com/dblopez04/kiai/client/internal/desktop"
	"github.com/dblopez04/kiai/client/internal/launch"
	"github.com/dblopez04/kiai/client/internal/paths"
)

// version is set at build time: -ldflags "-X github.com/dblopez04/kiai/client/internal/cli.version=..."
var version = "0.1.0"

func help() string {
	return `kiai ` + version + `

Usage:
  kiai preset add <name> [options]   Create a preset and its app launcher entry
      --devserver <host>    Server for osu-wine --devserver (omit for official servers)
      --label <text>        Launcher name (default: "osu! (<host or name>)")
      --icon <path|name>    Launcher icon (default: osu-winello's icon)
      --keyword <word>      Extra launcher search term; repeatable
      --force               Replace an existing preset with the same name
  kiai preset list [--json]          Show presets
  kiai preset remove <name>          Delete a preset and its launcher entry
  kiai preset sync                   Rewrite every launcher entry from the config
                                     (run after moving the kiai binary)
  kiai launch <name>                 Start osu! with a preset (the launcher entries run this)
  kiai server set <url> [--token <UPLOAD_TOKEN>]
                                     Point kiai at your kiai server (e.g. http://homelab:8080)
  kiai server show                   Show the configured server
  kiai render <file.osr> [options]   Upload a replay, render it on the server, and wait for the video
      --devserver <host>    Server the play was set on (default: the last preset launched)
      --official            It was set on the official servers
      --osz <file>          Also upload the beatmap set it was played on
      --songs <dir>         osu! Songs folder, searched when the server can't download the map
      --no-wait             Upload and return without waiting for the render
  kiai help | --help | --version

Example:
  kiai preset add gatari --devserver gatari.pw
  -> "osu! (gatari.pw)" shows up when you search "gatari" in your app launcher.
`
}

// IO is everything the CLI takes from its process; tests substitute their own.
type IO struct {
	Getenv  paths.Getenv
	Environ []string
	Out     io.Writer
	Err     io.Writer
	Now     func() time.Time
	// The running binary, for launcher entries (os.Executable in production).
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
	case "preset":
		return 0, presetCommand(args[1:], io)
	case "launch":
		return launchCommand(args[1:], io)
	case "server":
		return 0, serverCommand(args[1:], io)
	case "render":
		return renderCommand(args[1:], io)
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

// selfCommand is the command that re-runs this tool, for generated .desktop entries.
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

func presetCommand(args []string, io IO) error {
	p := paths.Resolve(io.Getenv)
	sub := ""
	if len(args) > 0 {
		sub, args = args[0], args[1:]
	}

	switch sub {
	case "add":
		a, err := parseArgs(args, map[string]flagKind{"devserver": stringFlag, "label": stringFlag, "icon": stringFlag, "keyword": listFlag, "force": boolFlag})
		if err != nil {
			return err
		}
		name, err := a.onePositional("kiai preset add <name> [--devserver <host>] ...")
		if err != nil {
			return err
		}
		preset := config.Preset{Name: name, Label: a.strings["label"], Icon: a.strings["icon"], Keywords: a.lists["keyword"]}
		if preset.Keywords == nil {
			preset.Keywords = []string{}
		}
		if devserver, ok := a.strings["devserver"]; ok {
			preset.Devserver = NormalizeDevserver(devserver)
			if preset.Devserver == "" {
				return fmt.Errorf("Invalid preset:\n  devserver: expected a hostname such as gatari.pw")
			}
		}
		if err := preset.Validate(); err != nil {
			return err
		}

		cfg, err := config.Load(p.ConfigFile)
		if err != nil {
			return err
		}
		index := cfg.Index(preset.Name)
		if index >= 0 && !a.bools["force"] {
			return fmt.Errorf("Preset %q already exists. Use --force to replace it.", preset.Name)
		}
		if index < 0 {
			cfg.Presets = append(cfg.Presets, preset)
		} else {
			cfg.Presets[index] = preset
		}

		launcher, err := selfCommand(io)
		if err != nil {
			return err
		}
		// Write the entry first: if that fails, the config is left untouched.
		file, err := desktop.WritePresetEntry(p, preset, launcher)
		if err != nil {
			return err
		}
		if err := config.Save(p.ConfigFile, cfg); err != nil {
			return err
		}
		desktop.RefreshDatabase(p)

		verb := "Added"
		if index >= 0 {
			verb = "Replaced"
		}
		fmt.Fprintf(io.Out, "%s preset %q -> %s\n", verb, preset.Name, desktop.Label(preset))
		fmt.Fprintf(io.Out, "  launcher entry: %s\n", p.Tildify(file))
		return nil

	case "list", "ls":
		a, err := parseArgs(args, map[string]flagKind{"json": boolFlag})
		if err != nil {
			return err
		}
		if err := a.noPositionals("kiai preset list [--json]"); err != nil {
			return err
		}
		cfg, err := config.Load(p.ConfigFile)
		if err != nil {
			return err
		}
		if a.bools["json"] {
			data, err := json.MarshalIndent(cfg.Presets, "", "  ")
			if err != nil {
				return err
			}
			fmt.Fprintln(io.Out, string(data))
			return nil
		}
		if len(cfg.Presets) == 0 {
			fmt.Fprintln(io.Out, "No presets yet. Try: kiai preset add gatari --devserver gatari.pw")
			return nil
		}
		nameWidth, labelWidth := 0, 0
		for _, preset := range cfg.Presets {
			nameWidth = max(nameWidth, len(preset.Name))
			labelWidth = max(labelWidth, len([]rune(desktop.Label(preset))))
		}
		for _, preset := range cfg.Presets {
			server := preset.Devserver
			if server == "" {
				server = "(official servers)"
			}
			label := desktop.Label(preset)
			fmt.Fprintf(io.Out, "%-*s  %s%s  %s\n", nameWidth, preset.Name, label, strings.Repeat(" ", labelWidth-len([]rune(label))), server)
		}
		return nil

	case "remove", "rm":
		a, err := parseArgs(args, nil)
		if err != nil {
			return err
		}
		name, err := a.onePositional("kiai preset remove <name>")
		if err != nil {
			return err
		}
		cfg, err := config.Load(p.ConfigFile)
		if err != nil {
			return err
		}
		if _, err := cfg.Find(name); err != nil {
			return err
		}
		removed, err := desktop.RemovePresetEntry(p, name)
		if err != nil {
			return err
		}
		index := cfg.Index(name)
		cfg.Presets = slices.Delete(cfg.Presets, index, index+1)
		if err := config.Save(p.ConfigFile, cfg); err != nil {
			return err
		}
		desktop.RefreshDatabase(p)
		note := ""
		if !removed {
			note = " (it had no launcher entry)"
		}
		fmt.Fprintf(io.Out, "Removed preset %q%s.\n", name, note)
		return nil

	case "sync":
		a, err := parseArgs(args, nil)
		if err != nil {
			return err
		}
		if err := a.noPositionals("kiai preset sync"); err != nil {
			return err
		}
		cfg, err := config.Load(p.ConfigFile)
		if err != nil {
			return err
		}
		launcher, err := selfCommand(io)
		if err != nil {
			return err
		}
		wanted := map[string]bool{}
		for _, preset := range cfg.Presets {
			file, err := desktop.WritePresetEntry(p, preset, launcher)
			if err != nil {
				return err
			}
			wanted[preset.Name] = true
			fmt.Fprintf(io.Out, "wrote   %s\n", p.Tildify(file))
		}
		owned, err := desktop.ListOwnedEntries(p)
		if err != nil {
			return err
		}
		for _, name := range owned {
			if wanted[name] {
				continue
			}
			if removed, err := desktop.RemovePresetEntry(p, name); err != nil {
				return err
			} else if removed {
				fmt.Fprintf(io.Out, "removed stale entry for %q\n", name)
			}
		}
		desktop.RefreshDatabase(p)
		return nil

	default:
		return fmt.Errorf(`Usage: kiai preset <add|list|remove|sync>. Run "kiai help" for details.`)
	}
}

func launchCommand(args []string, io IO) (int, error) {
	a, err := parseArgs(args, nil)
	if err != nil {
		return 1, err
	}
	name, err := a.onePositional("kiai launch <name>")
	if err != nil {
		return 1, err
	}
	p := paths.Resolve(io.Getenv)
	cfg, err := config.Load(p.ConfigFile)
	if err != nil {
		return 1, err
	}
	preset, err := cfg.Find(name)
	if err != nil {
		return 1, err
	}
	return launch.Launch(p, cfg, preset, launch.Options{Getenv: io.Getenv, Environ: io.Environ, Now: io.Now()})
}
