// Package kiaiapi talks to the kiai server's replay API on the homelab.
package kiaiapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type Beatmap struct {
	ID         *int64   `json:"id"`
	SetID      *int64   `json:"beatmapset_id"`
	Artist     *string  `json:"artist"`
	Title      *string  `json:"title"`
	Version    *string  `json:"version"`
	Difficulty *float64 `json:"difficulty_rating"`
}

type Render struct {
	ID       int64   `json:"id"`
	Status   string  `json:"status"`
	Progress int     `json:"progress"`
	Error    *string `json:"error"`
	VideoURL *string `json:"video_url"`
}

type Replay struct {
	ID         string   `json:"id"`
	Created    bool     `json:"created"`
	PlayerName string   `json:"player_name"`
	BeatmapMD5 string   `json:"beatmap_md5"`
	Devserver  *string  `json:"devserver"`
	Beatmap    *Beatmap `json:"beatmap"`
	Accuracy   float64  `json:"accuracy"`
	Rank       string   `json:"rank"`
	ScoreID    *int64   `json:"score_id"`
	Render     *Render  `json:"render"`
}

// Title is "Artist - Title [Version]", or the map's MD5 when the server doesn't know it yet.
func (r Replay) Title() string {
	b := r.Beatmap
	if b == nil || b.Title == nil {
		return "beatmap " + r.BeatmapMD5
	}
	title := *b.Title
	if b.Artist != nil {
		title = *b.Artist + " - " + title
	}
	if b.Version != nil {
		title += " [" + *b.Version + "]"
	}
	return title
}

type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func New(baseURL, token string) *Client {
	// Uploads of large .osz files over a slow link can take a while; polling is quick.
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), Token: token, HTTP: &http.Client{Timeout: 30 * time.Minute}}
}

// APIError is a response from the server that wasn't a success.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return e.Message }

func (c *Client) do(method, path string, body io.Reader, size int64, out any) error {
	req, err := http.NewRequest(method, c.BaseURL+path, body)
	if err != nil {
		return err
	}
	if body != nil {
		req.ContentLength = size
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("Couldn't reach the kiai server at %s: %v", c.BaseURL, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		var problem struct {
			Error string `json:"error"`
		}
		message := strings.TrimSpace(string(data))
		if json.Unmarshal(data, &problem) == nil && problem.Error != "" {
			message = problem.Error
		}
		if message == "" {
			message = resp.Status
		}
		return &APIError{Status: resp.StatusCode, Message: fmt.Sprintf("The kiai server said: %s (HTTP %d)", message, resp.StatusCode)}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("Unexpected response from the kiai server (is %s the kiai server?): %v", c.BaseURL, err)
	}
	return nil
}

// UploadReplay sends a .osr. devserver is the osu! server it was set on; empty means official.
func (c *Client) UploadReplay(file string, devserver string) (Replay, error) {
	f, err := os.Open(file)
	if err != nil {
		return Replay{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return Replay{}, err
	}
	path := "/api/replays"
	if devserver != "" {
		path += "?devserver=" + url.QueryEscape(devserver)
	}
	var replay Replay
	err = c.do(http.MethodPost, path, f, info.Size(), &replay)
	return replay, err
}

func (c *Client) GetReplay(id string) (Replay, error) {
	var replay Replay
	err := c.do(http.MethodGet, "/api/replays/"+url.PathEscape(id), nil, 0, &replay)
	return replay, err
}

// UploadBeatmapset sends the .osz a replay was played on, for maps the server can't download.
func (c *Client) UploadBeatmapset(id string, osz string) error {
	f, err := os.Open(osz)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	return c.do(http.MethodPut, "/api/replays/"+url.PathEscape(id)+"/beatmapset", f, info.Size(), nil)
}
