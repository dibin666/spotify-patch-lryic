package server

/*
 * Spot-Lyric lyrics server.
 *
 * Matching runs in the Spotify client (src/core.js): NetEase / QQ Music search,
 * scoring, lyric download and parsing all happen on the user's machine. This
 * server only
 *   - stores shared matches: one object per Spotify track in Cloudflare R2 with the
 *     chosen NetEase / QQ song and its lyrics ("使用此歌词" / the upload button);
 *     the latest upload wins; the track's timing offset is uploaded with the lyrics;
 *   - relays provider requests verbatim for clients whose renderer cannot reach
 *     NetEase / QQ directly (CORS). Only an allow-list of hosts and API paths is
 *     forwarded and nothing is interpreted (RELAY=0 turns this off).
 * Besides a bounded memory cache the server keeps no state of its own.
 */

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var version = "0.0.0" // set by the program (SetVersion) from the embedded VERSION file

const maxBody = 2 * 1024 * 1024 // word-timed lyrics with translations stay well below this

type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string { return e.Message }

type Config struct {
	Host, DataDir, Token, R2Prefix    string
	Port                              int
	Origins                           map[string]bool
	TrustProxy, Relay, LogRequests    bool
	NeteaseRealIP                     string
	QQGap, NeteaseGap                 time.Duration
	CacheBytes                        int
	ReadLimit, WriteLimit, RelayLimit int
}

func loadConfig(env func(string) (string, bool)) Config {
	get := func(k, def string) string {
		if v, ok := env(k); ok {
			return v
		}
		return def
	}
	num := func(k string, def int) int {
		if n, err := strconv.Atoi(strings.TrimSpace(get(k, ""))); err == nil {
			return n
		}
		return def
	}
	origins := map[string]bool{}
	for _, o := range strings.Split(get("ALLOWED_ORIGINS", "https://xpui.app.spotify.com"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			origins[o] = true
		}
	}
	return Config{
		Host: get("HOST", "0.0.0.0"), Port: num("PORT", 8080), DataDir: get("DATA_DIR", "./data"),
		Origins: origins, Token: get("API_TOKEN", ""),
		TrustProxy: get("TRUST_PROXY", "") != "0", Relay: get("RELAY", "") != "0",
		NeteaseRealIP: get("NETEASE_REAL_IP", "211.161.244.70"),
		QQGap:         time.Duration(num("QQ_MIN_INTERVAL_MS", 400)) * time.Millisecond,
		NeteaseGap:    time.Duration(num("NETEASE_MIN_INTERVAL_MS", 120)) * time.Millisecond,
		CacheBytes:    num("CACHE_MB", 64) * 1024 * 1024,
		ReadLimit:     num("RATE_LIMIT", 240), WriteLimit: num("WRITE_RATE_LIMIT", 30), RelayLimit: num("RELAY_RATE_LIMIT", 120),
		R2Prefix: get("R2_PREFIX", "lyrics/"), LogRequests: get("LOG_REQUESTS", "") != "0",
	}
}

/* Fixed one-minute windows per client address. */
type RateLimiter struct {
	mu     sync.Mutex
	limit  int
	window int64
	counts map[string]int
}

func NewRateLimiter(limit int) *RateLimiter {
	return &RateLimiter{limit: limit, counts: map[string]int{}}
}

func (r *RateLimiter) Allow(key string) bool {
	if r.limit <= 0 {
		return true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if w := time.Now().Unix() / 60; w != r.window {
		r.window = w
		r.counts = map[string]int{}
	}
	r.counts[key]++
	return r.counts[key] <= r.limit
}

type App struct {
	cfg       Config
	cache     *MemoryCache
	bucket    Bucket
	storage   string
	bindings  *BindingStore
	upstream  Transport
	read      *RateLimiter
	write     *RateLimiter
	relayRate *RateLimiter

	lockMu sync.Mutex
	locks  map[string]*trackLock
}

type trackLock struct {
	mu   sync.Mutex
	refs int
}

func NewApp(cfg Config, bucket Bucket, transport Transport) *App {
	cache := NewMemoryCache(cfg.CacheBytes, 24*time.Hour)
	if transport == nil {
		transport = newTransport(cfg.NeteaseRealIP, cfg.QQGap, cfg.NeteaseGap)
	}
	a := &App{
		cfg: cfg, cache: cache, bucket: bucket, storage: "r2", upstream: transport, locks: map[string]*trackLock{},
		bindings: NewBindingStore(bucket, cache, cfg.R2Prefix),
		read:     NewRateLimiter(cfg.ReadLimit), write: NewRateLimiter(cfg.WriteLimit), relayRate: NewRateLimiter(cfg.RelayLimit),
	}
	if bucket.Local() {
		a.storage = "local"
	}
	return a
}

/* One write at a time per track, so the last click is also the last write. */
func (a *App) serialize(id string, task func()) {
	a.lockMu.Lock()
	l := a.locks[id]
	if l == nil {
		l = &trackLock{}
		a.locks[id] = l
	}
	l.refs++
	a.lockMu.Unlock()
	l.mu.Lock()
	defer func() {
		l.mu.Unlock()
		a.lockMu.Lock()
		if l.refs--; l.refs == 0 {
			delete(a.locks, id)
		}
		a.lockMu.Unlock()
	}()
	task()
}

func trackID(t *Track) (string, error) {
	id := spotifyID(t.URI)
	if id == "" {
		return "", &HTTPError{400, "只有 Spotify 曲目可以保存到服务器"}
	}
	return id, nil
}

/* What GET /api/bindings returns: everything but the LRC copy (kept in the object for people reading the bucket). */
func publicDoc(doc obj) obj {
	out := make(obj, len(doc))
	for k, v := range doc {
		if k != "lrc" {
			out[k] = v
		}
	}
	return out
}

func marshalIndent(v any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", " ")
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimRight(buf.String(), "\n"), nil
}

type bindingDoc struct {
	SpotifyURL   string    `json:"spotify_url"`
	SpotifyURI   string    `json:"spotify_uri"`
	Track        *Track    `json:"track"`
	Match        *MatchDoc `json:"match"`
	Source       string    `json:"source"`
	SyncType     string    `json:"sync_type"`
	LineCount    int       `json:"line_count"`
	Translated   bool      `json:"translated"`
	LyricsSHA256 string    `json:"lyrics_sha256"`
	OffsetMS     int64     `json:"offset_ms"`
	BindCount    int       `json:"bind_count"`
	CreatedAt    string    `json:"created_at"`
	UpdatedAt    string    `json:"updated_at"`
	LRC          string    `json:"lrc"`
	Lyrics       *Lyrics   `json:"lyrics"`
}

/* Per-track timing offset ("偏移"), bounded like the client's. */
const maxOffset = 5000

func cleanOffset(v any) (int64, bool) {
	f, ok := finite(v)
	if !ok {
		return 0, false
	}
	return clampInt(f, -maxOffset, maxOffset), true
}

func bindingMetadata(doc *bindingDoc) map[string]string {
	metadata := map[string]string{"spotify-url": doc.SpotifyURL, "source": doc.Source}
	if doc.Match != nil {
		metadata["provider"] = doc.Match.Provider
		metadata["provider-id"] = doc.Match.ID
	}
	return metadata
}

func (a *App) saveError(id string, err error) error {
	log.Printf("[storage] put %s %v", id, err)
	name := "存储"
	if a.storage == "r2" {
		name = "R2"
	}
	return &HTTPError{502, fmt.Sprintf("保存到 %s失败：%v", name, err)}
}

/* "使用此歌词" or the upload button: the lyrics come from the client. */
func (a *App) bind(ctx context.Context, body obj) (any, error) {
	track, err := cleanTrack(body["track"])
	if err != nil {
		return nil, err
	}
	id, err := trackID(track)
	if err != nil {
		return nil, err
	}
	candidate, err := cleanCandidate(body["candidate"])
	if err != nil {
		return nil, err
	}
	lyrics := sanitizeLyrics(body["lyrics"])
	if lyrics == nil {
		return nil, &HTTPError{422, "没有可保存的歌词"}
	}
	/* Spotify's own (licensed) lyrics are never redistributed. */
	if lyrics.Source == "spotify" {
		return nil, &HTTPError{422, "Spotify 官方歌词不能上传"}
	}
	if candidate != nil && lyrics.Source != candidate.Provider {
		return nil, &HTTPError{400, "歌词来源与匹配结果不一致"}
	}
	lyrics.TrackURI = "spotify:track:" + id
	lyrics.TrackID = id
	spotifyURL := "https://open.spotify.com/track/" + id
	offset, hasOffset := cleanOffset(body["offset_ms"])

	var result any
	var resultErr error
	a.serialize(id, func() {
		now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		previous, err := a.bindings.Get(ctx, id)
		if err != nil {
			log.Printf("[storage] get %s %v", id, err)
		}
		lrc := exportLRC(lyrics)
		sum := sha256.Sum256([]byte(lrc))
		doc := &bindingDoc{
			SpotifyURL: spotifyURL, SpotifyURI: "spotify:track:" + id, Track: track,
			Source: lyrics.Source, SyncType: lyrics.SyncType, LineCount: len(lyrics.Lines),
			LyricsSHA256: hex.EncodeToString(sum[:]), OffsetMS: offset, BindCount: 1, CreatedAt: now, UpdatedAt: now, LRC: lrc, Lyrics: lyrics,
		}
		for _, l := range lyrics.Lines {
			if l.TranslatedText != "" {
				doc.Translated = true
				break
			}
		}
		if previous != nil {
			if n, ok := previous["bind_count"].(float64); ok {
				doc.BindCount = int(n) + 1
			}
			if s, ok := previous["created_at"].(string); ok && s != "" {
				doc.CreatedAt = s
			}
			/* Older clients send no offset: the stored one stays. */
			if n, ok := cleanOffset(previous["offset_ms"]); ok && !hasOffset {
				doc.OffsetMS = n
			}
		}
		if candidate != nil {
			doc.Match = candidate.doc()
		}
		saved, err := a.bindings.Save(ctx, id, doc, bindingMetadata(doc))
		if err != nil {
			resultErr = a.saveError(id, err)
			return
		}
		result = obj{"stored": a.storage, "updated_at": now, "binding": publicDoc(saved)}
	})
	return result, resultErr
}

func (a *App) unbind(ctx context.Context, body obj) (any, error) {
	track, err := cleanTrack(body["track"])
	if err != nil {
		return nil, err
	}
	id, err := trackID(track)
	if err != nil {
		return nil, err
	}
	var resultErr error
	a.serialize(id, func() {
		if err := a.bindings.Remove(ctx, id); err != nil {
			log.Printf("[storage] delete %s %v", id, err)
			resultErr = &HTTPError{502, "从存储删除失败：" + err.Error()}
		}
	})
	if resultErr != nil {
		return nil, resultErr
	}
	return obj{"removed": true}, nil
}

/* The stored match and lyrics for one Spotify track. */
func (a *App) binding(ctx context.Context, id string) (any, error) {
	doc, err := a.bindings.Get(ctx, id)
	if err != nil {
		return nil, &HTTPError{502, err.Error()}
	}
	if doc == nil {
		return nil, &HTTPError{404, "not bound"}
	}
	return obj{"binding": publicDoc(doc)}, nil
}

/* Forwards one provider request built by the client (allow-listed, not interpreted). */
func (a *App) relay(ctx context.Context, body obj) (any, error) {
	if !a.cfg.Relay {
		return nil, &HTTPError{403, "此服务器未开启转发"}
	}
	method := "GET"
	if m, ok := body["method"].(string); ok && m != "" {
		method = strings.ToUpper(m)
	}
	target := str(body["url"], 4096)
	if !relayAllowed(method, target) {
		return nil, &HTTPError{400, "不允许转发这个地址"}
	}
	headers := map[string]string{}
	if h, ok := body["headers"].(obj); ok {
		names := make([]string, 0, len(h))
		for n := range h {
			names = append(names, n)
		}
		sort.Strings(names)
		if len(names) > 10 {
			names = names[:10]
		}
		for _, n := range names {
			if s, ok := h[n].(string); ok {
				headers[n] = truncate(s, 500)
			}
		}
	}
	var payload *string
	if body["body"] != nil {
		s := str(body["body"], 64*1024)
		payload = &s
	}
	resp, err := a.upstream(ctx, UpstreamRequest{Method: method, URL: target, Headers: headers, Body: payload})
	if err != nil {
		return nil, &HTTPError{502, "转发失败：" + err.Error()}
	}
	var retry any
	if resp.RetryAfter != "" {
		retry = resp.RetryAfter
	}
	return obj{"status": resp.Status, "body": resp.Body, "retry_after": retry}, nil
}

/* ------------------------------------------------------------ http ---- */
func (a *App) clientAddress(r *http.Request) string {
	if a.cfg.TrustProxy {
		if v := r.Header.Get("Cf-Connecting-Ip"); v != "" {
			return v
		}
		if v := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0]); v != "" {
			return v
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (a *App) respond(w http.ResponseWriter, r *http.Request, status int, payload any, empty bool) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	if origin := r.Header.Get("Origin"); origin != "" && (a.cfg.Origins["*"] || a.cfg.Origins[origin]) {
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Vary", "Origin")
		h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		h.Set("Access-Control-Max-Age", "86400")
		/* Private Network Access: the Spotify renderer may ask before calling the local service on 127.0.0.1. */
		if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
			h.Set("Access-Control-Allow-Private-Network", "true")
		}
	}
	w.WriteHeader(status)
	if empty {
		return
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(payload)
}

func readBody(w http.ResponseWriter, r *http.Request) (obj, error) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, &HTTPError{413, "request too large"}
		}
		return nil, err
	}
	if len(data) == 0 {
		return obj{}, nil
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, &HTTPError{400, "invalid JSON"}
	}
	if m, ok := v.(obj); ok {
		return m, nil
	}
	return obj{}, nil
}

var bindingPathRe = regexp.MustCompile(`^/api/bindings/([A-Za-z0-9]{22})$`)

/* Matching moved to the client in v1.2: tell old clients to update. */
var retired = map[string]bool{"/api/match": true, "/api/search": true, "/api/lyrics": true}

func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	status := 500
	path := r.URL.Path
	send := func(code int, payload any) { status = code; a.respond(w, r, code, payload, false) }
	defer func() {
		if a.cfg.LogRequests && path != "/health" {
			log.Printf("%s %s %d %dms", r.Method, path, status, time.Since(started).Milliseconds())
		}
	}()
	err := a.route(w, r, send, &status)
	if err == nil {
		return
	}
	var he *HTTPError
	if errors.As(err, &he) {
		send(he.Status, obj{"error": he.Message})
		return
	}
	log.Printf("[server] %s %s %v", r.Method, path, err)
	send(500, obj{"error": "internal error"})
}

func (a *App) route(w http.ResponseWriter, r *http.Request, send func(int, any), status *int) error {
	path := r.URL.Path
	if origin := r.Header.Get("Origin"); origin != "" && !a.cfg.Origins["*"] && !a.cfg.Origins[origin] {
		return &HTTPError{403, "origin not allowed"}
	}
	if r.Method == "OPTIONS" {
		*status = 204
		a.respond(w, r, 204, nil, true)
		return nil
	}
	if (r.Method == "GET" || r.Method == "HEAD") && path == "/health" {
		send(200, obj{"ok": true, "version": version, "storage": a.storage, "auth": a.cfg.Token != "", "relay": a.cfg.Relay})
		return nil
	}
	if r.Method == "GET" && path == "/" {
		send(200, obj{"name": "spot-lyric-server", "version": version, "docs": "GET /api/bindings/<spotify-track-id> | POST /api/bind | /api/unbind | /api/relay"})
		return nil
	}
	if !strings.HasPrefix(path, "/api/") {
		return &HTTPError{404, "not found"}
	}
	if a.cfg.Token != "" {
		given, wanted := []byte(r.Header.Get("Authorization")), []byte("Bearer "+a.cfg.Token)
		if subtle.ConstantTimeCompare(given, wanted) != 1 {
			return &HTTPError{401, "需要歌词服务器令牌"}
		}
	}
	if retired[path] {
		return &HTTPError{410, "客户端版本过旧：请重新运行 patch 脚本更新 Spot-Lyric"}
	}
	address := a.clientAddress(r)
	isWrite := path == "/api/bind" || path == "/api/unbind"
	isRelay := path == "/api/relay"
	if !a.read.Allow(address) || (isWrite && !a.write.Allow(address)) || (isRelay && !a.relayRate.Allow(address)) {
		return &HTTPError{429, "请求过于频繁，请稍后再试"}
	}
	if m := bindingPathRe.FindStringSubmatch(path); r.Method == "GET" && m != nil {
		out, err := a.binding(r.Context(), m[1])
		if err != nil {
			return err
		}
		send(200, out)
		return nil
	}
	var handler func(context.Context, obj) (any, error)
	switch path {
	case "/api/bind":
		handler = a.bind
	case "/api/unbind":
		handler = a.unbind
	case "/api/relay":
		handler = a.relay
	default:
		return &HTTPError{404, "not found"}
	}
	if r.Method != "POST" {
		return &HTTPError{405, "method not allowed"}
	}
	body, err := readBody(w, r)
	if err != nil {
		return err
	}
	out, err := handler(r.Context(), body)
	if err != nil {
		return err
	}
	send(200, out)
	return nil
}

func newServer(a *App) *http.Server {
	return &http.Server{
		Addr: net.JoinHostPort(a.cfg.Host, strconv.Itoa(a.cfg.Port)), Handler: a,
		ReadHeaderTimeout: 15 * time.Second, ReadTimeout: 60 * time.Second, IdleTimeout: 65 * time.Second,
	}
}

func newBucket(cfg Config, env func(string) (string, bool)) Bucket {
	if s3 := newS3FromEnv(env); s3 != nil {
		return s3
	}
	return &DirBucket{dir: filepath.Join(cfg.DataDir, "objects")}
}
