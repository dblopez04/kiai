// Package desktop writes app-launcher entries for presets, following the freedesktop Desktop
// Entry Specification 1.5: https://specifications.freedesktop.org/desktop-entry-spec/latest/
package desktop

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/dblopez04/kiai/client/internal/config"
	"github.com/dblopez04/kiai/client/internal/fsutil"
	"github.com/dblopez04/kiai/client/internal/paths"
)

// MarkerKey marks entries we generated, so we never touch a .desktop file we didn't write.
const MarkerKey = "X-Kiai-Preset"

const filePrefix = "kiai-"

func FileName(presetName string) string {
	return filePrefix + presetName + ".desktop"
}

func FilePath(p paths.Paths, presetName string) string {
	return filepath.Join(p.ApplicationsDir, FileName(presetName))
}

// EscapeValue escapes a value of type `string` / `localestring` (spec: "Possible value types").
func EscapeValue(value string) string {
	value = strings.NewReplacer(`\`, `\\`, "\n", `\n`, "\t", `\t`, "\r", `\r`).Replace(value)
	if strings.HasPrefix(value, " ") {
		value = `\s` + value[1:]
	}
	return value
}

// EscapeList escapes a list value: `;` separates items and is escaped inside them.
func EscapeList(items []string) string {
	var b strings.Builder
	for _, item := range items {
		b.WriteString(strings.ReplaceAll(EscapeValue(item), ";", `\;`))
		b.WriteString(";")
	}
	return b.String()
}

// Characters that force an Exec argument to be quoted (spec: "The Exec key").
var execReserved = regexp.MustCompile("[\\s\"'\\\\><~|&;$*?#()`]")
var execQuoteEscapes = strings.NewReplacer(`"`, `\"`, "`", "\\`", `$`, `\$`, `\`, `\\`)

// QuoteExecArg quotes one Exec argument. Inside double quotes, double quote, backtick, dollar and
// backslash take a backslash, and `%` is doubled everywhere so it can't be read as a field code. The general
// string escaping in EscapeValue is applied afterwards to the whole line, which is why a literal
// backslash ends up written as four.
func QuoteExecArg(arg string) string {
	percentSafe := strings.ReplaceAll(arg, "%", "%%")
	if percentSafe != "" && !execReserved.MatchString(percentSafe) {
		return percentSafe
	}
	return `"` + execQuoteEscapes.Replace(percentSafe) + `"`
}

func ExecValue(argv []string) string {
	quoted := make([]string, len(argv))
	for i, arg := range argv {
		quoted[i] = QuoteExecArg(arg)
	}
	return EscapeValue(strings.Join(quoted, " "))
}

func Label(p config.Preset) string {
	if p.Label != "" {
		return p.Label
	}
	if p.Devserver != "" {
		return "osu! (" + p.Devserver + ")"
	}
	return "osu! (" + p.Name + ")"
}

var portSuffix = regexp.MustCompile(`:\d+$`)

// Keywords are search terms: the preset name, the server host, and the host without its TLD ("gatari").
func Keywords(p config.Preset) []string {
	words := []string{"osu", p.Name}
	if p.Devserver != "" {
		host := portSuffix.ReplaceAllString(p.Devserver, "")
		words = append(words, host, strings.Split(host, ".")[0])
	}
	words = append(words, p.Keywords...)
	var unique []string
	for _, word := range words {
		if !slices.Contains(unique, word) {
			unique = append(unique, word)
		}
	}
	return unique
}

// Render builds the entry. `launcher` is the command that runs this tool; `defaultIcon` is used
// when the preset doesn't set one (empty for none).
func Render(p config.Preset, launcher []string, defaultIcon string) string {
	server := "on the official servers"
	if p.Devserver != "" {
		server = "on " + p.Devserver
	}
	icon := p.Icon
	if icon == "" {
		icon = defaultIcon
	}
	lines := []string{
		"[Desktop Entry]",
		"Type=Application",
		"Version=1.5",
		"Name=" + EscapeValue(Label(p)),
		"GenericName=Rhythm Game",
		"Comment=" + EscapeValue(fmt.Sprintf("osu! stable %s (kiai preset %q)", server, p.Name)),
		"Exec=" + ExecValue(append(slices.Clone(launcher), "launch", p.Name)),
	}
	if icon != "" {
		lines = append(lines, "Icon="+EscapeValue(icon))
	}
	lines = append(lines,
		"Terminal=false",
		"Categories=Game;",
		"Keywords="+EscapeList(Keywords(p)),
		"StartupNotify=true",
		"StartupWMClass=osu!.exe",
		MarkerKey+"="+EscapeValue(p.Name),
	)
	return strings.Join(lines, "\n") + "\n"
}

var markerLine = regexp.MustCompile(`(?m)^` + MarkerKey + `=(.+)$`)

// OwnedPresetName is the preset name recorded in an entry we generated, or "" if it isn't ours.
func OwnedPresetName(contents string) string {
	if m := markerLine.FindStringSubmatch(contents); m != nil {
		return m[1]
	}
	return ""
}

// WritePresetEntry writes (or replaces) the preset's entry and returns its path.
func WritePresetEntry(p paths.Paths, preset config.Preset, launcher []string) (string, error) {
	file := FilePath(p, preset.Name)
	existing, ok, err := fsutil.ReadFileIfExists(file)
	if err != nil {
		return "", err
	}
	if ok && OwnedPresetName(string(existing)) == "" {
		return "", fmt.Errorf("%s exists and was not created by kiai; refusing to overwrite it.", file)
	}
	defaultIcon := ""
	if _, err := os.Stat(p.WinelloIcon); err == nil {
		defaultIcon = p.WinelloIcon
	}
	// Executable like osu-winello's own entry; some desktops won't launch untrusted entries otherwise.
	if err := fsutil.WriteFileAtomic(file, []byte(Render(preset, launcher, defaultIcon)), 0o755); err != nil {
		return "", err
	}
	return file, nil
}

// RemovePresetEntry deletes a preset's entry. It returns false if there was nothing to delete.
func RemovePresetEntry(p paths.Paths, presetName string) (bool, error) {
	file := FilePath(p, presetName)
	existing, ok, err := fsutil.ReadFileIfExists(file)
	if err != nil || !ok {
		return false, err
	}
	if OwnedPresetName(string(existing)) == "" {
		return false, fmt.Errorf("%s was not created by kiai; refusing to delete it.", file)
	}
	return true, os.Remove(file)
}

// ListOwnedEntries returns the names of presets that have an entry we generated, sorted.
func ListOwnedEntries(p paths.Paths) ([]string, error) {
	entries, err := os.ReadDir(p.ApplicationsDir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var owned []string
	for _, entry := range entries {
		file := entry.Name()
		if !strings.HasPrefix(file, filePrefix) || !strings.HasSuffix(file, ".desktop") {
			continue
		}
		contents, ok, err := fsutil.ReadFileIfExists(filepath.Join(p.ApplicationsDir, file))
		if err != nil || !ok {
			continue
		}
		if name := OwnedPresetName(string(contents)); name != "" && file == FileName(name) {
			owned = append(owned, name)
		}
	}
	slices.Sort(owned)
	return owned, nil
}

// RefreshDatabase refreshes the desktop database cache. Most launchers watch the directory and
// don't need this, so a missing or failing `update-desktop-database` is not an error.
func RefreshDatabase(p paths.Paths) {
	_ = exec.Command("update-desktop-database", "-q", p.ApplicationsDir).Run()
}
