package cli

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dblopez04/kiai/client/internal/config"
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
	// An empty PATH keeps real programs on this machine (such as systemctl) from being found.
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

// setDevserver edits config.json by hand, the way users set "devserver".
func (h *harness) setDevserver(host string) {
	h.t.Helper()
	cfg, err := config.Load(h.paths.ConfigFile)
	if err != nil {
		h.t.Fatal(err)
	}
	cfg.Devserver = host
	if err := config.Save(h.paths.ConfigFile, cfg); err != nil {
		h.t.Fatal(err)
	}
}

func TestNormalizeDevserver(t *testing.T) {
	if got := NormalizeDevserver(" https://Gatari.pw/ "); got != "gatari.pw" {
		t.Errorf("got %q", got)
	}
}

func TestBrokenConfigIsReported(t *testing.T) {
	h := newHarness(t)
	os.MkdirAll(filepath.Dir(h.paths.ConfigFile), 0o755)
	os.WriteFile(h.paths.ConfigFile, []byte("{ nope"), 0o644)
	if code := h.run("server", "show"); code != 1 || !strings.Contains(h.err.String(), "is not valid JSON") {
		t.Errorf("exit %d, stderr %q", code, h.err.String())
	}
	os.WriteFile(h.paths.ConfigFile, []byte(`{"version":1,"devserver":"https://Gatari.pw/"}`), 0o644)
	if code := h.run("server", "show"); code != 1 || !strings.Contains(h.err.String(), "devserver: expected a hostname") {
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
	for _, removed := range []string{"frobnicate", "preset", "launch"} {
		if code := h.run(removed); code != 1 || !strings.Contains(h.err.String(), `Unknown command "`+removed+`"`) {
			t.Errorf("%s: exit %d, stderr %q", removed, code, h.err.String())
		}
	}
}
