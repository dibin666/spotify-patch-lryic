package server

// Input validation for data received from clients; port of the relevant parts
// of src/core.js (spotifyId, candidateFromJson, candidateJson, sanitizeLyrics,
// exportLrc).

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

var providerNames = map[string]string{"netease": "网易云音乐", "qq": "QQ 音乐", "spotify": "Spotify", "local": "本地文件"}

type obj = map[string]any

/* truncate keeps at most max characters. */
func truncate(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max])
}

func str(v any, max int) string {
	s, _ := v.(string)
	return truncate(s, max)
}

func finite(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && !math.IsInf(f, 0) && !math.IsNaN(f)
}

func clampInt(f float64, lo, hi int64) int64 {
	n := int64(math.Trunc(f))
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

var spotifyIDRe = regexp.MustCompile(`^[A-Za-z0-9]{22}(\?.*)?$`)

func spotifyID(uri string) string {
	var id string
	switch {
	case strings.HasPrefix(uri, "spotify:track:"):
		id = uri[len("spotify:track:"):]
	case strings.HasPrefix(uri, "https://open.spotify.com/track/"):
		id = uri[len("https://open.spotify.com/track/"):]
	default:
		return ""
	}
	if !spotifyIDRe.MatchString(id) {
		return ""
	}
	return id[:22]
}

/* ------------------------------------------------------------ track ---- */
type Track struct {
	URI        string   `json:"uri"`
	Title      string   `json:"title"`
	Artists    []string `json:"artists"`
	Album      string   `json:"album"`
	DurationMS int64    `json:"duration_ms"`
}

func cleanTrack(input any) (*Track, error) {
	m, ok := input.(obj)
	if !ok {
		return nil, &HTTPError{400, "track required"}
	}
	t := &Track{URI: str(m["uri"], 200), Title: str(m["title"], 500), Album: str(m["album"], 500), Artists: []string{}}
	if list, ok := m["artists"].([]any); ok {
		for _, a := range list {
			if s, ok := a.(string); ok {
				if len(t.Artists) >= 20 {
					break
				}
				t.Artists = append(t.Artists, truncate(s, 300))
			}
		}
	}
	if f, ok := finite(m["duration_ms"]); ok {
		t.DurationMS = clampInt(f, 0, 86400000)
	}
	if strings.TrimSpace(t.Title) == "" {
		return nil, &HTTPError{400, "track.title required"}
	}
	return t, nil
}

/* -------------------------------------------------------- candidate ---- */
type Candidate struct {
	Provider   string
	ID, Mid    string
	Title      string
	Album      string
	DurationMS int64
	Verified   bool
	Artists    []string
	Aliases    []string
}

type MatchDoc struct {
	ID           string   `json:"id"`
	Mid          string   `json:"mid"`
	Provider     string   `json:"provider"`
	Title        string   `json:"title"`
	Album        string   `json:"album"`
	DurationMS   int64    `json:"duration_ms"`
	Artists      []string `json:"artists"`
	Aliases      []string `json:"aliases,omitempty"`
	Verified     bool     `json:"verified,omitempty"`
	ProviderName string   `json:"provider_name"`
	URL          string   `json:"url"`
}

func strings300(v any, max int) []string {
	out := []string{}
	list, _ := v.([]any)
	for _, a := range list {
		if s, ok := a.(string); ok {
			if len(out) >= max {
				break
			}
			out = append(out, truncate(s, 300))
		}
	}
	return out
}

var digitsRe = regexp.MustCompile(`^\d{1,20}$`)
var leadingInt = regexp.MustCompile(`^\s*[+-]?\d+`)

/* int(node,'duration_ms') of core.js: number, or a string parsed like parseInt. */
func looseInt(v any) int64 {
	switch x := v.(type) {
	case float64:
		if !math.IsInf(x, 0) && !math.IsNaN(x) {
			return int64(math.Trunc(x))
		}
	case string:
		if m := leadingInt.FindString(x); m != "" {
			n, _ := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(m, "+")), 10, 64)
			return n
		}
	}
	return 0
}

func cleanCandidate(input any) (*Candidate, error) {
	if input == nil {
		return nil, nil
	}
	m, ok := input.(obj)
	provider, _ := m["provider"].(string)
	id, _ := m["id"].(string)
	if !ok || (provider != "netease" && provider != "qq") || id == "" {
		return nil, &HTTPError{400, "bad candidate"}
	}
	mid, _ := m["mid"].(string)
	title, _ := m["title"].(string)
	album, _ := m["album"].(string)
	c := &Candidate{
		Provider: provider, ID: truncate(id, 64), Mid: truncate(mid, 64), Title: title, Album: album,
		DurationMS: looseInt(m["duration_ms"]), Verified: m["verified"] == true,
		Artists: strings300(m["artists"], 50), Aliases: strings300(m["aliases"], 8),
	}
	if !digitsRe.MatchString(c.ID) {
		return nil, &HTTPError{400, "bad candidate id"}
	}
	return c, nil
}

func providerURL(c *Candidate) string {
	if c.Provider == "qq" {
		if c.Mid != "" {
			return "https://y.qq.com/n/ryqq/songDetail/" + c.Mid
		}
		return ""
	}
	return "https://music.163.com/#/song?id=" + c.ID
}

func (c *Candidate) doc() *MatchDoc {
	return &MatchDoc{
		ID: c.ID, Mid: c.Mid, Provider: c.Provider, Title: c.Title, Album: c.Album, DurationMS: c.DurationMS,
		Artists: c.Artists, Aliases: c.Aliases, Verified: c.Verified,
		ProviderName: providerNames[c.Provider], URL: providerURL(c),
	}
}

/* ----------------------------------------------------------- lyrics ---- */
type Word struct {
	Text    string `json:"text"`
	StartMS int64  `json:"start_time_ms"`
	EndMS   int64  `json:"end_time_ms"`
}

type Line struct {
	Text           string `json:"text"`
	StartMS        int64  `json:"start_time_ms"`
	EndMS          int64  `json:"end_time_ms"`
	TranslatedText string `json:"translated_text,omitempty"`
	Words          []Word `json:"words"`
}

type Lyrics struct {
	Source   string `json:"source"`
	Provider string `json:"provider"`
	SyncType string `json:"sync_type"`
	Parser   int64  `json:"parser"`
	Lines    []Line `json:"lines"`
	TrackURI string `json:"track_uri,omitempty"`
	TrackID  string `json:"track_id,omitempty"`
}

func cleanText(v any, max int) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	s = strings.Map(func(r rune) rune {
		if r <= 8 || (r >= 0x0b && r <= 0x1f) || r == 0x7f {
			return -1
		}
		return r
	}, s)
	return truncate(s, max)
}

func timeMS(v any) int64 {
	f, ok := finite(v)
	if !ok {
		return 0
	}
	return clampInt(f, -3600000, 86400000)
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

/* sanitizeLyrics bounds client lyrics and strips them to the known shape; nil when unusable. */
func sanitizeLyrics(input any) *Lyrics {
	m, ok := input.(obj)
	if !ok {
		return nil
	}
	rawLines, ok := m["lines"].([]any)
	if !ok {
		return nil
	}
	sync, _ := m["sync_type"].(string)
	if sync != "word" && sync != "line" && sync != "unsynced" {
		sync = "line"
	}
	source, _ := m["source"].(string)
	if source != "netease" && source != "qq" && source != "local" && source != "spotify" {
		source = "local"
	}
	r := &Lyrics{Source: source, Provider: source, SyncType: sync, Lines: []Line{}}
	if f, ok := finite(m["parser"]); ok && f == math.Trunc(f) {
		r.Parser = int64(f)
	}
	if len(rawLines) > 5000 {
		rawLines = rawLines[:5000]
	}
	usable := false
	for _, rl := range rawLines {
		line, ok := rl.(obj)
		if !ok {
			continue
		}
		start := timeMS(line["start_time_ms"])
		out := Line{
			Text: cleanText(line["text"], 500), StartMS: start, EndMS: max64(start, timeMS(line["end_time_ms"])),
			TranslatedText: cleanText(line["translated_text"], 500), Words: []Word{},
		}
		if sync == "word" {
			if words, ok := line["words"].([]any); ok {
				if len(words) > 400 {
					words = words[:400]
				}
				for _, rw := range words {
					w, ok := rw.(obj)
					if !ok {
						continue
					}
					text := cleanText(w["text"], 200)
					if text == "" {
						continue
					}
					ws := timeMS(w["start_time_ms"])
					out.Words = append(out.Words, Word{text, ws, max64(ws, timeMS(w["end_time_ms"]))})
				}
			}
		}
		if out.Text != "" {
			usable = true
		}
		r.Lines = append(r.Lines, out)
	}
	if !usable {
		return nil
	}
	sort.SliceStable(r.Lines, func(i, j int) bool { return r.Lines[i].StartMS < r.Lines[j].StartMS })
	return r
}

func stamp(t int64, left, right string) string {
	if t < 0 {
		t = 0
	}
	return fmt.Sprintf("%s%02d:%02d.%03d%s", left, t/60000, t/1000%60, t%1000, right)
}

func exportLRC(l *Lyrics) string {
	var b strings.Builder
	for _, line := range l.Lines {
		if l.SyncType != "unsynced" {
			b.WriteString(stamp(line.StartMS, "[", "]"))
		}
		if len(line.Words) > 0 {
			for j, w := range line.Words {
				b.WriteString(stamp(w.StartMS, "<", ">") + w.Text)
				if j+1 == len(line.Words) {
					b.WriteString(stamp(w.EndMS, "<", ">"))
				}
			}
		} else {
			b.WriteString(line.Text)
		}
		b.WriteByte('\n')
	}
	return b.String()
}
