// Package songs finds beatmaps in the local osu! Songs folder, for maps the server can't
// download (unsubmitted, edited, or updated since the play): a replay names its map only by the
// .osu file's MD5.
package songs

import (
	"archive/zip"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// ErrNotFound means no .osu file in the Songs folder has the MD5.
var ErrNotFound = errors.New("not found in the Songs folder")

func fileMD5(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := md5.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// FindFolder returns the beatmap folder in songsDir holding a .osu file with this MD5. It hashes
// every difficulty, so it can take a few seconds on a large library.
func FindFolder(songsDir, hash string) (string, error) {
	hash = strings.ToLower(hash)
	folders, err := os.ReadDir(songsDir)
	if err != nil {
		return "", fmt.Errorf("Can't read the osu! Songs folder %s: %v", songsDir, err)
	}
	for _, folder := range folders {
		if !folder.IsDir() {
			continue
		}
		dir := filepath.Join(songsDir, folder.Name())
		files, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, file := range files {
			if file.IsDir() || !strings.EqualFold(filepath.Ext(file.Name()), ".osu") {
				continue
			}
			if sum, err := fileMD5(filepath.Join(dir, file.Name())); err == nil && sum == hash {
				return dir, nil
			}
		}
	}
	return "", ErrNotFound
}

// Video backgrounds are optional for rendering and often most of a set's size.
var skipped = map[string]bool{".avi": true, ".flv": true, ".mp4": true, ".m4v": true, ".mkv": true, ".wmv": true, ".webm": true}

// WriteOsz packs a beatmap folder into an .osz (a zip), leaving out video files.
func WriteOsz(dir string, w io.Writer) error {
	archive := zip.NewWriter(w)
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.Type().IsRegular() || skipped[strings.ToLower(filepath.Ext(path))] {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		out, err := archive.Create(filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		_, err = io.Copy(out, in)
		return err
	})
	if err != nil {
		return err
	}
	return archive.Close()
}
