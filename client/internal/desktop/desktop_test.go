package desktop

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/dblopez04/kiai/client/internal/config"
	"github.com/dblopez04/kiai/client/internal/paths"
)

var gatari = config.Preset{Name: "gatari", Devserver: "gatari.pw", Keywords: []string{}}

func TestQuoteExecArg(t *testing.T) {
	cases := map[string]string{
		"/usr/bin/kiai":        "/usr/bin/kiai",
		"launch":               "launch",
		"/opt/kiai client/bin": `"/opt/kiai client/bin"`,
		"a$b":                  `"a\$b"`,
		`say "hi"`:             `"say \"hi\""`,
		"":                     `""`,
		"100%":                 "100%%",
	}
	for in, want := range cases {
		if got := QuoteExecArg(in); got != want {
			t.Errorf("QuoteExecArg(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExecValueEscapesBackslashTwice(t *testing.T) {
	// Quoting doubles the backslash, then string escaping doubles it again.
	got := ExecValue([]string{`/weird\dir/kiai`, "launch", "x"})
	if want := `"/weird\\\\dir/kiai" launch x`; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestEscapeList(t *testing.T) {
	if got := EscapeList([]string{"osu", "a;b"}); got != `osu;a\;b;` {
		t.Errorf("got %q", got)
	}
}

func TestKeywords(t *testing.T) {
	if got := Keywords(gatari); !slices.Equal(got, []string{"osu", "gatari", "gatari.pw"}) {
		t.Errorf("got %v", got)
	}
	local := config.Preset{Name: "local", Devserver: "my.server.lan:8080", Keywords: []string{"private", "osu"}}
	if got := Keywords(local); !slices.Equal(got, []string{"osu", "local", "my.server.lan", "my", "private"}) {
		t.Errorf("got %v", got)
	}
}

func TestRender(t *testing.T) {
	got := Render(gatari, []string{"/home/me/.local/bin/kiai"}, "/icons/osu.png")
	want := strings.Join([]string{
		"[Desktop Entry]",
		"Type=Application",
		"Version=1.5",
		"Name=osu! (gatari.pw)",
		"GenericName=Rhythm Game",
		`Comment=osu! stable on gatari.pw (kiai preset "gatari")`,
		"Exec=/home/me/.local/bin/kiai launch gatari",
		"Icon=/icons/osu.png",
		"Terminal=false",
		"Categories=Game;",
		"Keywords=osu;gatari;gatari.pw;",
		"StartupNotify=true",
		"StartupWMClass=osu!.exe",
		"X-Kiai-Preset=gatari",
		"",
	}, "\n")
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}

	bancho := Render(config.Preset{Name: "bancho"}, []string{"kiai"}, "")
	for _, fragment := range []string{"Name=osu! (bancho)\n", "on the official servers"} {
		if !strings.Contains(bancho, fragment) {
			t.Errorf("bancho entry lacks %q", fragment)
		}
	}
	if strings.Contains(bancho, "Icon=") {
		t.Error("entry without an icon has an Icon key")
	}

	custom := Render(config.Preset{Name: "ak", Devserver: "akatsuki.gg", Label: "Akatsuki relax", Icon: "akatsuki"}, []string{"kiai"}, "/icons/osu.png")
	if !strings.Contains(custom, "Name=Akatsuki relax\n") || !strings.Contains(custom, "Icon=akatsuki\n") {
		t.Errorf("preset label/icon not used:\n%s", custom)
	}
}

func TestRenderPassesDesktopFileValidate(t *testing.T) {
	if _, err := exec.LookPath("desktop-file-validate"); err != nil {
		t.Skip("desktop-file-validate not installed")
	}
	preset := config.Preset{Name: "gatari", Devserver: "gatari.pw", Label: `osu! 100% \ gatari`, Keywords: []string{"a;b"}}
	file := filepath.Join(t.TempDir(), "kiai-gatari.desktop")
	if err := os.WriteFile(file, []byte(Render(preset, []string{"/opt/kiai client/$bin", `--flag="x"`}, "")), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("desktop-file-validate", file).CombinedOutput()
	if err != nil || len(out) > 0 {
		t.Errorf("desktop-file-validate: %v\n%s", err, out)
	}
}

func testPaths(t *testing.T) paths.Paths {
	home := t.TempDir()
	return paths.Resolve(func(name string) string {
		if name == "HOME" {
			return home
		}
		return ""
	})
}

func TestUsesWinelloIconWhenInstalled(t *testing.T) {
	p := testPaths(t)
	os.MkdirAll(filepath.Dir(p.WinelloIcon), 0o755)
	os.WriteFile(p.WinelloIcon, []byte("png"), 0o644)
	file, err := WritePresetEntry(p, gatari, []string{"kiai"})
	if err != nil {
		t.Fatal(err)
	}
	contents, _ := os.ReadFile(file)
	if !strings.Contains(string(contents), "Icon="+p.WinelloIcon+"\n") {
		t.Errorf("icon missing:\n%s", contents)
	}
}

func TestRefusesFilesItDidNotCreate(t *testing.T) {
	p := testPaths(t)
	file := filepath.Join(p.ApplicationsDir, "kiai-gatari.desktop")
	os.MkdirAll(p.ApplicationsDir, 0o755)
	os.WriteFile(file, []byte("[Desktop Entry]\nName=Someone else's\n"), 0o644)

	if _, err := WritePresetEntry(p, gatari, []string{"kiai"}); err == nil || !strings.Contains(err.Error(), "not created by kiai") {
		t.Errorf("write: %v", err)
	}
	if _, err := RemovePresetEntry(p, "gatari"); err == nil || !strings.Contains(err.Error(), "not created by kiai") {
		t.Errorf("remove: %v", err)
	}
	if contents, _ := os.ReadFile(file); !strings.Contains(string(contents), "Someone else's") {
		t.Error("foreign file was modified")
	}
	if owned, _ := ListOwnedEntries(p); len(owned) != 0 {
		t.Errorf("foreign file listed as owned: %v", owned)
	}
}

func TestListsAndRemovesItsOwnEntries(t *testing.T) {
	p := testPaths(t)
	WritePresetEntry(p, gatari, []string{"kiai"})
	WritePresetEntry(p, config.Preset{Name: "bancho"}, []string{"kiai"})
	if owned, _ := ListOwnedEntries(p); !slices.Equal(owned, []string{"bancho", "gatari"}) {
		t.Errorf("owned = %v", owned)
	}
	if removed, err := RemovePresetEntry(p, "gatari"); !removed || err != nil {
		t.Errorf("first remove = %v, %v", removed, err)
	}
	if removed, err := RemovePresetEntry(p, "gatari"); removed || err != nil {
		t.Errorf("second remove = %v, %v", removed, err)
	}
	if owned, _ := ListOwnedEntries(p); !slices.Equal(owned, []string{"bancho"}) {
		t.Errorf("owned = %v", owned)
	}
}
