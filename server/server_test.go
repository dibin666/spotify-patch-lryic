package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRelayAllowed(t *testing.T) {
	cases := []struct {
		method, url string
		want        bool
	}{
		{"POST", "https://u.y.qq.com/cgi-bin/musicu.fcg", true},
		{"GET", "https://music.163.com/api/song/lyric?id=1", true},
		{"GET", "https://music.163.com:8443/api/song/lyric", false},
		{"GET", "http://music.163.com/api/song/lyric", false},
		{"GET", "https://evil.example/api/search/get/web", false},
		{"GET", "https://music.163.com/weapi/user/account", false},
		{"DELETE", "https://music.163.com/api/song/lyric?id=1", false},
		{"GET", "https://user@music.163.com/api/song/lyric", false},
	}
	for _, c := range cases {
		if got := relayAllowed(c.method, c.url); got != c.want {
			t.Errorf("relayAllowed(%s %s) = %v, want %v", c.method, c.url, got, c.want)
		}
	}
}

func TestEncodeKey(t *testing.T) {
	if got := encodeKey("lyrics/a b!'()*~.json"); got != "lyrics/a%20b%21%27%28%29%2A~.json" {
		t.Errorf("encodeKey = %q", got)
	}
}

func TestRelayThroughApp(t *testing.T) {
	cfg := loadConfig(func(k string) (string, bool) { return "", false })
	cfg.DataDir = t.TempDir()
	fake := func(_ context.Context, r UpstreamRequest) (*UpstreamResponse, error) {
		return &UpstreamResponse{Status: 200, Body: `{"code":200,"url":"` + r.URL + `"}`}, nil
	}
	app := NewApp(cfg, &DirBucket{dir: cfg.DataDir}, fake)
	srv := httptest.NewServer(app)
	defer srv.Close()

	post := func(body string) (int, map[string]any) {
		resp, err := http.Post(srv.URL+"/api/relay", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		var out map[string]any
		_ = json.Unmarshal(data, &out)
		return resp.StatusCode, out
	}
	if code, out := post(`{"method":"GET","url":"https://music.163.com/api/song/lyric?id=7"}`); code != 200 || out["status"] != float64(200) {
		t.Errorf("allowed relay: %d %v", code, out)
	}
	if code, _ := post(`{"method":"GET","url":"https://evil.example/api/song/lyric"}`); code != 400 {
		t.Errorf("evil host: %d", code)
	}
}

func TestSanitizeLyrics(t *testing.T) {
	var in any
	_ = json.Unmarshal([]byte(`{"source":"local","evil":1,"lines":[{"text":"b","start_time_ms":9},{"text":"a\u0000x","start_time_ms":1}]}`), &in)
	l := sanitizeLyrics(in)
	if l == nil || len(l.Lines) != 2 || l.Lines[0].Text != "ax" {
		t.Fatalf("unexpected: %+v", l)
	}
	if got := exportLRC(l); got != "[00:00.001]ax\n[00:00.009]b\n" {
		t.Errorf("lrc = %q", got)
	}
	_ = json.Unmarshal([]byte(`{"lines":[{"text":""}]}`), &in)
	if sanitizeLyrics(in) != nil {
		t.Error("empty lyrics must be rejected")
	}
}
