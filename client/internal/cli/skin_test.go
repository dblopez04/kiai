package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSkinUpload(t *testing.T) {
	var got struct{ path, auth, body string }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got.path, got.auth, got.body = r.URL.EscapedPath(), r.Header.Get("Authorization"), string(body)
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"skin": "My Skin", "skins": []string{"My Skin", "Other"}})
	}))
	t.Cleanup(server.Close)

	h := newHarness(t)
	h.mustRun("server", "set", server.URL, "--token", token)
	osk := filepath.Join(h.env["HOME"], "My Skin.osk")
	os.WriteFile(osk, []byte("zip bytes"), 0o644)

	h.mustRun("skin", "upload", osk)
	if got.path != "/api/skins/My%20Skin" || got.auth != "Bearer "+token || got.body != "zip bytes" {
		t.Errorf("request %+v", got)
	}
	if !strings.Contains(h.out.String(), `Uploaded skin "My Skin".`) || !strings.Contains(h.out.String(), "Skins on the server: My Skin, Other") {
		t.Errorf("output: %s", h.out.String())
	}
	h.mustRun("skin", "upload", osk, "--name", "Renamed")
	if got.path != "/api/skins/Renamed" {
		t.Errorf("path %s", got.path)
	}
	if code := h.run("skin", "list"); code != 1 || !strings.Contains(h.err.String(), "Usage: kiai skin upload") {
		t.Errorf("%d %s", code, h.err.String())
	}
}
