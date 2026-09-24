package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// watchHarness has a server, an osu! install whose Replays folder is watched, and a clock.
type watchHarness struct {
	*harness
	fake    *fakeServer
	replays string
	clock   time.Time
}

func newWatchHarness(t *testing.T, fake *fakeServer) *watchHarness {
	h, _ := setupRender(t, fake)
	osu := filepath.Join(h.env["HOME"], "osu")
	os.MkdirAll(filepath.Join(osu, "Replays"), 0o755)
	os.MkdirAll(filepath.Dir(h.paths.WinelloOsuPathFile), 0o755)
	os.WriteFile(h.paths.WinelloOsuPathFile, []byte(osu+"\n"), 0o644)
	return &watchHarness{harness: h, fake: fake, replays: filepath.Join(osu, "Replays"), clock: time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)}
}

func (w *watchHarness) io() IO {
	return IO{Getenv: w.getenv, Out: &w.out, Err: &w.err, Now: func() time.Time { return w.clock }, Sleep: func(time.Duration) {}}
}

func (w *watchHarness) watcher(backlog bool) *watcher {
	w.t.Helper()
	watcher, err := newWatcher(w.io(), backlog)
	if err != nil {
		w.t.Fatal(err)
	}
	return watcher
}

// step advances the clock past the status interval and runs one tick.
func (w *watchHarness) step(watcher *watcher) {
	w.t.Helper()
	w.clock = w.clock.Add(statusInterval + time.Second)
	if err := watcher.tick(); err != nil {
		w.t.Fatal(err)
	}
}

func (w *watchHarness) uploads() int {
	n := 0
	for _, call := range w.fake.auth {
		if strings.HasPrefix(call, "POST") {
			n++
		}
	}
	return n
}

func TestWatchUploadsNewReplaysOnceTheyAreWritten(t *testing.T) {
	w := newWatchHarness(t, &fakeServer{})
	os.WriteFile(filepath.Join(w.replays, "old.osr"), []byte("replay bytes"), 0o644)
	w.setDevserver("akatsuki.gg")
	watcher := w.watcher(false)

	w.step(watcher)
	if w.uploads() != 0 {
		t.Fatalf("uploaded the backlog")
	}
	os.WriteFile(filepath.Join(w.replays, "new.osr"), []byte("replay bytes"), 0o644)
	os.WriteFile(filepath.Join(w.replays, "notes.txt"), []byte("ignored"), 0o644)
	w.step(watcher) // First sight: waits for the size to settle.
	if w.uploads() != 0 {
		t.Fatalf("uploaded before the file settled")
	}
	w.step(watcher)
	if w.uploads() != 1 || w.fake.devserver != "akatsuki.gg" {
		t.Fatalf("uploads %d, devserver %q", w.uploads(), w.fake.devserver)
	}
	if !strings.Contains(w.out.String(), "uploaded new.osr as replay abcdefghij: Artist - Song [Insane] (S, played by tester on akatsuki.gg)") {
		t.Errorf("log:\n%s", w.out.String())
	}

	// A restarted watcher remembers what it uploaded.
	again := w.watcher(false)
	w.step(again)
	w.step(again)
	if w.uploads() != 1 {
		t.Errorf("re-uploaded after restart: %d", w.uploads())
	}
}

func TestWatchFollowsRendersAndUploadsMissingMaps(t *testing.T) {
	w := newWatchHarness(t, &fakeServer{needsMap: true})
	song := filepath.Join(w.env["HOME"], "osu", "Songs", "1 Artist - Song")
	os.MkdirAll(song, 0o755)
	os.WriteFile(filepath.Join(song, "map.osu"), []byte("map"), 0o644)
	watcher := w.watcher(false)

	os.WriteFile(filepath.Join(w.replays, "play.osr"), []byte("replay bytes"), 0o644)
	for i := 0; i < 10 && !strings.Contains(w.out.String(), "rendered "); i++ {
		w.step(watcher)
	}
	out := w.out.String()
	if len(w.fake.uploadedOsz) == 0 || !strings.Contains(out, "rendered Artist - Song [Insane]: http://127.0.0.1") {
		t.Fatalf("osz %v, log:\n%s", w.fake.uploadedOsz, out)
	}
	if len(watcher.state.Pending) != 0 {
		t.Errorf("still pending: %+v", watcher.state.Pending)
	}
}

func TestWatchBacklogAndFailures(t *testing.T) {
	w := newWatchHarness(t, &fakeServer{fail: true})
	os.WriteFile(filepath.Join(w.replays, "old.osr"), []byte("replay bytes"), 0o644)
	watcher := w.watcher(true)
	for i := 0; i < 6; i++ {
		w.step(watcher)
	}
	if w.uploads() != 1 || !strings.Contains(w.out.String(), "render of Artist - Song [Insane] failed: danser exited with code 2.") {
		t.Fatalf("uploads %d, log:\n%s", w.uploads(), w.out.String())
	}

	// A file the server refuses isn't retried.
	os.WriteFile(filepath.Join(w.replays, "broken.osr"), []byte("not a replay"), 0o644)
	w.step(watcher)
	w.step(watcher)
	w.step(watcher)
	if got := w.uploads(); got != 2 {
		t.Errorf("uploads %d", got)
	}
	data, _ := os.ReadFile(w.paths.WatchStateFile)
	var state watchState
	json.Unmarshal(data, &state)
	if _, ok := state.Seen[filepath.Join(w.replays, "broken.osr")]; !ok {
		t.Errorf("broken replay not recorded: %s", data)
	}
}

func TestWatchInstallWritesAndStartsAUserService(t *testing.T) {
	h := newHarness(t)
	h.mustRun("server", "set", "http://homelab:8080", "--token", token)
	bin := filepath.Join(h.env["HOME"], "bin")
	os.MkdirAll(bin, 0o755)
	calls := filepath.Join(h.env["HOME"], "systemctl-calls")
	os.WriteFile(filepath.Join(bin, "systemctl"), []byte("#!/bin/sh\necho \"$*\" >> '"+calls+"'\n"), 0o755)
	h.env["PATH"] = bin

	h.mustRun("watch", "install")
	unit, err := os.ReadFile(filepath.Join(h.paths.SystemdUserDir, "kiai-watch.service"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(unit), `ExecStart="/opt/kiai client/kiai" watch`) || !strings.Contains(string(unit), "WantedBy=default.target") {
		t.Errorf("unit:\n%s", unit)
	}
	h.mustRun("watch", "uninstall")
	if _, err := os.Stat(filepath.Join(h.paths.SystemdUserDir, "kiai-watch.service")); !os.IsNotExist(err) {
		t.Errorf("unit left behind")
	}
	got, _ := os.ReadFile(calls)
	want := "--user daemon-reload\n--user enable --now kiai-watch.service\n--user disable --now kiai-watch.service\n--user daemon-reload\n"
	if string(got) != want {
		t.Errorf("systemctl calls:\n%s", got)
	}
}

func TestWatchInstallNeedsAServer(t *testing.T) {
	h := newHarness(t)
	if code := h.run("watch", "install"); code != 1 || !strings.Contains(h.err.String(), "kiai server set") {
		t.Errorf("%d %s", code, h.err.String())
	}
}
