package cli

import (
	"archive/zip"
	"bytes"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const token = "0123456789abcdef-token"

// fakeServer plays the kiai server: each status poll advances the render one step.
type fakeServer struct {
	mu          sync.Mutex
	needsMap    bool
	fail        bool
	polls       int
	devserver   string
	uploadedOsz []string
	auth        []string
}

func (f *fakeServer) replay() map[string]any {
	status, progress := "queued", 0
	switch {
	case f.polls >= 3 && f.needsMap:
		status = "needs_map"
	case f.polls >= 3 && f.fail:
		status = "failed"
	case f.polls >= 3:
		status = "success"
	case f.polls >= 1:
		status, progress = "running", 40*f.polls
	}
	render := map[string]any{"id": 1, "status": status, "progress": progress, "error": nil, "video_url": nil}
	if status == "success" {
		render["video_url"] = "/replays/abcdefghij/video"
	}
	if status == "needs_map" {
		render["error"] = "osu! doesn't know this version of the map."
	}
	if status == "failed" {
		render["error"] = "danser exited with code 2."
	}
	return map[string]any{
		"id": "abcdefghij", "created": true, "player_name": "tester", "beatmap_md5": md5hex("map"), "rank": "SH",
		"beatmap": map[string]any{"artist": "Artist", "title": "Song", "version": "Insane"}, "render": render,
	}
}

func (f *fakeServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.auth = append(f.auth, r.Method+" "+r.Header.Get("Authorization"))
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/api/replays":
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]string{"error": "That upload token is wrong."})
			return
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "replay bytes" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		f.devserver = r.URL.Query().Get("devserver")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(f.replay())
	case r.Method == http.MethodGet && r.URL.Path == "/api/replays/abcdefghij":
		f.polls++
		json.NewEncoder(w).Encode(f.replay())
	case r.Method == http.MethodPut && r.URL.Path == "/api/replays/abcdefghij/beatmapset":
		body, _ := io.ReadAll(r.Body)
		archive, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		for _, file := range archive.File {
			f.uploadedOsz = append(f.uploadedOsz, file.Name)
		}
		f.needsMap = false
		f.polls = 1
		json.NewEncoder(w).Encode(map[string]any{"difficulties": 1})
	default:
		http.NotFound(w, r)
	}
}

func md5hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

func setupRender(t *testing.T, fake *fakeServer) (*harness, string) {
	h := newHarness(t)
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	h.mustRun("server", "set", server.URL+"/", "--token", token)
	osr := filepath.Join(h.env["HOME"], "play.osr")
	if err := os.WriteFile(osr, []byte("replay bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	return h, osr
}

func (h *harness) runNoSleep(args ...string) int {
	h.out.Reset()
	h.err.Reset()
	return Run(args, IO{Getenv: h.getenv, Out: &h.out, Err: &h.err, Now: time.Now, Sleep: func(time.Duration) {}})
}

func TestServerSetStoresURLAndTokenPrivately(t *testing.T) {
	h := newHarness(t)
	h.mustRun("server", "set", "http://homelab:8080/", "--token", token)
	h.mustRun("server", "show")
	if got := h.out.String(); got != "http://homelab:8080 (upload token set)\n" {
		t.Errorf("show: %q", got)
	}
	info, err := os.Stat(h.paths.ConfigFile)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("config mode %v, %v", info.Mode(), err)
	}
	// Changing the address keeps the token.
	h.mustRun("server", "set", "http://10.0.0.5:8080")
	h.mustRun("server", "show")
	if !strings.Contains(h.out.String(), "10.0.0.5:8080 (upload token set)") {
		t.Errorf("token lost: %q", h.out.String())
	}
	if code := h.run("server", "set", "homelab:8080"); code != 1 || !strings.Contains(h.err.String(), "such as http://homelab:8080") {
		t.Errorf("bad URL accepted: %d %s", code, h.err.String())
	}
}

func TestRenderNeedsAServer(t *testing.T) {
	h := newHarness(t)
	if code := h.run("render", "x.osr"); code != 1 || !strings.Contains(h.err.String(), "kiai server set") {
		t.Errorf("%d %s", code, h.err.String())
	}
}

func TestRenderUploadsAndWaitsForTheVideo(t *testing.T) {
	fake := &fakeServer{}
	h, osr := setupRender(t, fake)
	h.setDevserver("gatari.pw")
	if code := h.runNoSleep("render", osr); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	out := h.out.String()
	for _, want := range []string{
		"Tagging it as played on gatari.pw",
		"Uploaded replay abcdefghij: Artist - Song [Insane], S by tester",
		"Rendering... 40%",
		"Rendering... 80%",
		"Video: " + strings.TrimSuffix(h.configuredServerURL(), "/") + "/replays/abcdefghij/video",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	if fake.devserver != "gatari.pw" {
		t.Errorf("devserver %q", fake.devserver)
	}
	if fake.auth[0] != "POST Bearer "+token {
		t.Errorf("auth %v", fake.auth)
	}
}

func (h *harness) configuredServerURL() string {
	data, _ := os.ReadFile(h.paths.ConfigFile)
	var cfg struct{ Server struct{ URL string } }
	json.Unmarshal(data, &cfg)
	return cfg.Server.URL
}

func TestRenderOfficialAndNoWait(t *testing.T) {
	fake := &fakeServer{}
	h, osr := setupRender(t, fake)
	h.setDevserver("gatari.pw")
	if code := h.runNoSleep("render", osr, "--official", "--no-wait"); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	if fake.devserver != "" || fake.polls != 0 || !strings.Contains(h.out.String(), "Rendering in the background: ") {
		t.Errorf("devserver %q polls %d: %s", fake.devserver, fake.polls, h.out.String())
	}
}

func TestRenderUploadsTheMapFromTheSongsFolderWhenTheServerCantGetIt(t *testing.T) {
	fake := &fakeServer{needsMap: true}
	h, osr := setupRender(t, fake)
	songs := filepath.Join(h.env["HOME"], "osu", "Songs")
	for name, content := range map[string]string{
		"1 Other - Map/other.osu":           "other",
		"2 Artist - Song/song [Insane].osu": "map",
		"2 Artist - Song/audio.mp3":         "audio",
		"2 Artist - Song/bg.mp4":            "video",
	} {
		os.MkdirAll(filepath.Dir(filepath.Join(songs, name)), 0o755)
		os.WriteFile(filepath.Join(songs, name), []byte(content), 0o644)
	}
	os.MkdirAll(filepath.Dir(h.paths.WinelloOsuPathFile), 0o755)
	os.WriteFile(h.paths.WinelloOsuPathFile, []byte(filepath.Join(h.env["HOME"], "osu")+"\n"), 0o644)

	if code := h.runNoSleep("render", osr, "--official"); code != 0 {
		t.Fatalf("exit %d: %s\n%s", code, h.err.String(), h.out.String())
	}
	if got := strings.Join(fake.uploadedOsz, ","); got != "audio.mp3,song [Insane].osu" {
		t.Errorf("uploaded %s", got)
	}
	if !strings.Contains(h.out.String(), "Rendered: ") {
		t.Errorf("output:\n%s", h.out.String())
	}
}

func TestRenderExplainsAMissingMapAndFailures(t *testing.T) {
	fake := &fakeServer{needsMap: true}
	h, osr := setupRender(t, fake)
	empty := filepath.Join(h.env["HOME"], "Songs")
	os.MkdirAll(empty, 0o755)
	if code := h.runNoSleep("render", osr, "--official", "--songs", empty); code != 1 || !strings.Contains(h.err.String(), "Pass its .osz with --osz") {
		t.Errorf("%d %s", code, h.err.String())
	}

	fake = &fakeServer{fail: true}
	h, osr = setupRender(t, fake)
	if code := h.runNoSleep("render", osr, "--official"); code != 1 || !strings.Contains(h.err.String(), "danser exited with code 2.") {
		t.Errorf("%d %s", code, h.err.String())
	}

	h.mustRun("server", "set", h.configuredServerURL(), "--token", "wrong-token-wrong")
	if code := h.runNoSleep("render", osr); code != 1 || !strings.Contains(h.err.String(), "That upload token is wrong. (HTTP 403)") {
		t.Errorf("%d %s", code, h.err.String())
	}
}
