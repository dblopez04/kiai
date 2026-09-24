package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dblopez04/kiai/client/internal/launch"
	"github.com/dblopez04/kiai/client/internal/paths"
)

const launcher = "/opt/kiai client/kiai"

type harness struct {
	t     *testing.T
	env   map[string]string
	paths paths.Paths
	out   bytes.Buffer
	err   bytes.Buffer
}

func newHarness(t *testing.T) *harness {
	home := t.TempDir()
	// An empty PATH keeps a real osu-wine on this machine from being found.
	h := &harness{t: t, env: map[string]string{"HOME": home, "PATH": "", "KIAI_BIN": launcher}}
	h.paths = paths.Resolve(h.getenv)
	return h
}

func (h *harness) getenv(name string) string { return h.env[name] }

func (h *harness) run(args ...string) int {
	h.out.Reset()
	h.err.Reset()
	environ := []string{}
	for k, v := range h.env {
		environ = append(environ, k+"="+v)
	}
	return Run(args, IO{
		Getenv:     h.getenv,
		Environ:    environ,
		Out:        &h.out,
		Err:        &h.err,
		Now:        time.Now,
		Executable: func() (string, error) { return "", errors.New("tests set KIAI_BIN") },
	})
}

func (h *harness) mustRun(args ...string) {
	h.t.Helper()
	if code := h.run(args...); code != 0 {
		h.t.Fatalf("%v exited %d: %s", args, code, h.err.String())
	}
}

func (h *harness) lines() []string {
	return strings.Split(strings.TrimRight(h.out.String(), "\n"), "\n")
}

func (h *harness) entry(name string) string {
	data, err := os.ReadFile(filepath.Join(h.paths.ApplicationsDir, "kiai-"+name+".desktop"))
	if err != nil {
		return ""
	}
	return string(data)
}

type savedPreset struct {
	Name      string   `json:"name"`
	Devserver string   `json:"devserver,omitempty"`
	Keywords  []string `json:"keywords"`
}

func (h *harness) presets() []savedPreset {
	data, err := os.ReadFile(h.paths.ConfigFile)
	if err != nil {
		h.t.Fatal(err)
	}
	var cfg struct{ Presets []savedPreset }
	if err := json.Unmarshal(data, &cfg); err != nil {
		h.t.Fatal(err)
	}
	return cfg.Presets
}

// fakeOsuWine installs a stand-in for osu-winello's launcher that records its arguments.
func (h *harness) fakeOsuWine(exitCode int) string {
	argsFile := filepath.Join(h.env["HOME"], "osu-wine-args")
	os.MkdirAll(h.paths.WinelloBinDir, 0o755)
	script := "#!/bin/sh\n{ echo \"$#\"; printf '%s\\n' \"$@\"; } > '" + argsFile + "'\nexit " + string(rune('0'+exitCode)) + "\n"
	if err := os.WriteFile(filepath.Join(h.paths.WinelloBinDir, "osu-wine"), []byte(script), 0o755); err != nil {
		h.t.Fatal(err)
	}
	return argsFile
}

func TestNormalizeDevserver(t *testing.T) {
	if got := NormalizeDevserver(" https://Gatari.pw/ "); got != "gatari.pw" {
		t.Errorf("got %q", got)
	}
}

func TestPresetAdd(t *testing.T) {
	h := newHarness(t)
	h.mustRun("preset", "add", "gatari", "--devserver", "https://Gatari.pw/")
	if got := h.presets(); len(got) != 1 || got[0].Name != "gatari" || got[0].Devserver != "gatari.pw" || got[0].Keywords == nil {
		t.Errorf("saved %+v", got)
	}
	entry := h.entry("gatari")
	for _, fragment := range []string{"Name=osu! (gatari.pw)\n", `Exec="/opt/kiai client/kiai" launch gatari` + "\n"} {
		if !strings.Contains(entry, fragment) {
			t.Errorf("entry lacks %q:\n%s", fragment, entry)
		}
	}
	want := []string{`Added preset "gatari" -> osu! (gatari.pw)`, "  launcher entry: ~/.local/share/applications/kiai-gatari.desktop"}
	if got := h.lines(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("output %q", got)
	}
}

func TestPresetAddFlagsAfterOrBeforeName(t *testing.T) {
	h := newHarness(t)
	h.mustRun("preset", "add", "--devserver=akatsuki.gg", "--keyword", "relax", "ak", "--keyword", "rx", "--label", "osu! (akatsuki relax)")
	if !strings.Contains(h.entry("ak"), "Keywords=osu;ak;akatsuki.gg;akatsuki;relax;rx;\n") {
		t.Errorf("entry:\n%s", h.entry("ak"))
	}
}

func TestPresetAddRefusesDuplicatesUnlessForced(t *testing.T) {
	h := newHarness(t)
	h.mustRun("preset", "add", "gatari", "--devserver", "gatari.pw")
	if code := h.run("preset", "add", "gatari", "--devserver", "osu.gatari.pw"); code != 1 {
		t.Fatalf("exit %d", code)
	}
	if got := h.err.String(); got != "error: Preset \"gatari\" already exists. Use --force to replace it.\n" {
		t.Errorf("stderr %q", got)
	}
	h.mustRun("preset", "add", "gatari", "--devserver", "osu.gatari.pw", "--force")
	if got := h.presets(); len(got) != 1 || got[0].Devserver != "osu.gatari.pw" {
		t.Errorf("saved %+v", got)
	}
	if !strings.Contains(h.entry("gatari"), "Name=osu! (osu.gatari.pw)\n") {
		t.Error("entry not replaced")
	}
}

func TestPresetAddRejectsBadInputWithoutWriting(t *testing.T) {
	h := newHarness(t)
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"preset", "add", "Gatari Server", "--devserver", "gatari.pw"}, "lowercase letters"},
		{[]string{"preset", "add", "gatari", "--devserver", "not a host"}, "expected a hostname"},
		{[]string{"preset", "add", "gatari", "--devserver", ""}, "expected a hostname"},
		{[]string{"preset", "add", "gatari", "--server", "gatari.pw"}, "Unknown option '--server'"},
		{[]string{"preset", "add", "gatari", "--devserver"}, "argument missing"},
		{[]string{"preset", "add", "gatari", "--force=yes"}, "does not take a value"},
		{[]string{"preset", "add"}, "Usage: kiai preset add"},
	}
	for _, c := range cases {
		if code := h.run(c.args...); code != 1 || !strings.Contains(h.err.String(), c.want) {
			t.Errorf("%v: exit %d, stderr %q (want %q)", c.args, code, h.err.String(), c.want)
		}
	}
	if _, err := os.Stat(h.paths.ConfigFile); !os.IsNotExist(err) {
		t.Error("config was written")
	}
}

func TestPresetList(t *testing.T) {
	h := newHarness(t)
	h.mustRun("preset", "list")
	if !strings.HasPrefix(h.out.String(), "No presets yet") {
		t.Errorf("empty list: %q", h.out.String())
	}
	h.mustRun("preset", "add", "gatari", "--devserver", "gatari.pw")
	h.mustRun("preset", "add", "bancho")
	h.mustRun("preset", "list")
	want := []string{
		"gatari  osu! (gatari.pw)  gatari.pw",
		"bancho  osu! (bancho)     (official servers)",
	}
	if got := h.lines(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("list:\n%s", h.out.String())
	}
	h.mustRun("preset", "list", "--json")
	var presets []savedPreset
	if err := json.Unmarshal(h.out.Bytes(), &presets); err != nil || len(presets) != 2 || presets[1].Devserver != "" {
		t.Errorf("json: %v %s", err, h.out.String())
	}
}

func TestBrokenConfigIsReported(t *testing.T) {
	h := newHarness(t)
	os.MkdirAll(filepath.Dir(h.paths.ConfigFile), 0o755)
	os.WriteFile(h.paths.ConfigFile, []byte("{ nope"), 0o644)
	if code := h.run("preset", "list"); code != 1 || !strings.Contains(h.err.String(), "is not valid JSON") {
		t.Errorf("exit %d, stderr %q", code, h.err.String())
	}
	os.WriteFile(h.paths.ConfigFile, []byte(`{"version":1,"presets":[{"name":"BAD"}]}`), 0o644)
	if code := h.run("preset", "list"); code != 1 || !strings.Contains(h.err.String(), "presets.0.name") {
		t.Errorf("exit %d, stderr %q", code, h.err.String())
	}
}

func TestPresetRemove(t *testing.T) {
	h := newHarness(t)
	h.mustRun("preset", "add", "gatari", "--devserver", "gatari.pw")
	h.mustRun("preset", "remove", "gatari")
	if got := h.presets(); len(got) != 0 {
		t.Errorf("presets %+v", got)
	}
	if h.entry("gatari") != "" {
		t.Error("entry still exists")
	}
	if code := h.run("preset", "remove", "ghost"); code != 1 || h.err.String() != "error: No preset named \"ghost\" (known presets: none yet).\n" {
		t.Errorf("exit %d, stderr %q", code, h.err.String())
	}
}

func TestPresetSyncRewritesAndRemovesOnlyItsOwnStaleEntries(t *testing.T) {
	h := newHarness(t)
	h.mustRun("preset", "add", "gatari", "--devserver", "gatari.pw")
	h.mustRun("preset", "add", "old", "--devserver", "old.example")
	// A hand-edited config that dropped "old", and a foreign file with our prefix.
	os.WriteFile(h.paths.ConfigFile, []byte(`{"version":1,"presets":[{"name":"gatari","devserver":"gatari.pw"}]}`), 0o644)
	os.WriteFile(filepath.Join(h.paths.ApplicationsDir, "kiai-mine.desktop"), []byte("[Desktop Entry]\nName=hand made\n"), 0o644)

	h.env["KIAI_BIN"] = "/usr/local/bin/kiai"
	h.mustRun("preset", "sync")
	want := []string{"wrote   ~/.local/share/applications/kiai-gatari.desktop", `removed stale entry for "old"`}
	if got := h.lines(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("output %q", got)
	}
	if !strings.Contains(h.entry("gatari"), "Exec=/usr/local/bin/kiai launch gatari\n") {
		t.Error("entry not rewritten")
	}
	if h.entry("old") != "" {
		t.Error("stale entry kept")
	}
	if !strings.Contains(h.entry("mine"), "hand made") {
		t.Error("foreign entry touched")
	}
}

func TestLaunchRecordsSessionAndPassesExitCode(t *testing.T) {
	h := newHarness(t)
	argsFile := h.fakeOsuWine(3)
	h.mustRun("preset", "add", "gatari", "--devserver", "gatari.pw")
	before := time.Now().Add(-time.Second)
	if code := h.run("launch", "gatari"); code != 3 {
		t.Fatalf("exit %d (%s)", code, h.err.String())
	}
	if args, _ := os.ReadFile(argsFile); string(args) != "2\n--devserver\ngatari.pw\n" {
		t.Errorf("osu-wine args %q", args)
	}
	session := launch.ReadSession(h.paths.SessionFile)
	if session == nil || session.Preset != "gatari" || session.Devserver == nil || *session.Devserver != "gatari.pw" {
		t.Fatalf("session %+v", session)
	}
	if at, _ := time.Parse(time.RFC3339Nano, session.LaunchedAt); at.Before(before) {
		t.Errorf("launchedAt %s", session.LaunchedAt)
	}
}

func TestLaunchOfficialServers(t *testing.T) {
	h := newHarness(t)
	argsFile := h.fakeOsuWine(0)
	h.mustRun("preset", "add", "bancho")
	h.mustRun("launch", "bancho")
	if args, _ := os.ReadFile(argsFile); string(args) != "0\n\n" {
		t.Errorf("osu-wine args %q", args)
	}
	data, _ := os.ReadFile(h.paths.SessionFile)
	if !strings.Contains(string(data), `"devserver": null`) {
		t.Errorf("session %s", data)
	}
}

func TestLaunchFindsOsuWineOnPath(t *testing.T) {
	h := newHarness(t)
	bin := filepath.Join(h.env["HOME"], "elsewhere")
	os.MkdirAll(bin, 0o755)
	os.WriteFile(filepath.Join(bin, "osu-wine"), []byte("#!/bin/sh\nexit 7\n"), 0o755)
	h.env["PATH"] = bin
	h.mustRun("preset", "add", "bancho")
	if code := h.run("launch", "bancho"); code != 7 {
		t.Errorf("exit %d (%s)", code, h.err.String())
	}
}

func TestLaunchExplainsMissingOsuWine(t *testing.T) {
	h := newHarness(t)
	h.mustRun("preset", "add", "gatari", "--devserver", "gatari.pw")
	if code := h.run("launch", "gatari"); code != 1 || !strings.Contains(h.err.String(), "Couldn't find osu-wine. Install osu-winello") {
		t.Errorf("exit %d, stderr %q", code, h.err.String())
	}
	if launch.ReadSession(h.paths.SessionFile) != nil {
		t.Error("session recorded without launching")
	}
	if code := h.run("launch", "nope"); code != 1 || !strings.Contains(h.err.String(), `No preset named "nope"`) {
		t.Errorf("exit %d, stderr %q", code, h.err.String())
	}
}

func TestSelfCommandRefusesGoRunBinaries(t *testing.T) {
	io := IO{Getenv: func(string) string { return "" }, Executable: func() (string, error) { return "/tmp/go-build123/b001/exe/kiai", nil }}
	if _, err := selfCommand(io); err == nil || !strings.Contains(err.Error(), "go run") {
		t.Errorf("err = %v", err)
	}
	io.Executable = func() (string, error) { return "/home/me/.local/bin/kiai", nil }
	if cmd, err := selfCommand(io); err != nil || cmd[0] != "/home/me/.local/bin/kiai" {
		t.Errorf("cmd = %v, err = %v", cmd, err)
	}
}

func TestTopLevel(t *testing.T) {
	h := newHarness(t)
	h.mustRun()
	if !strings.HasPrefix(h.out.String(), "kiai 0.1.0") {
		t.Errorf("help %q", h.out.String())
	}
	if code := h.run("frobnicate"); code != 1 || !strings.Contains(h.err.String(), `Unknown command "frobnicate"`) {
		t.Errorf("exit %d, stderr %q", code, h.err.String())
	}
}
