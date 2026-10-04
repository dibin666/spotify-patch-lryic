package server

// Relay of provider requests built by the client. Only a fixed allow-list of
// NetEase / QQ Music hosts and API paths can be reached, redirects are not
// followed, responses are capped at 2 MiB.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

var allowedHosts = map[string]bool{
	"music.163.com": true, "interface.music.163.com": true, "interface3.music.163.com": true,
	"u.y.qq.com": true, "c.y.qq.com": true, "i.y.qq.com": true,
}

/* The endpoints src/core.js uses (search, song detail, lyrics). */
var allowedPaths = map[string]bool{
	"/api/search/get/web": true, "/api/song/detail/": true, "/api/song/detail": true, "/api/song/lyric": true, "/api/song/lyric/v1": true,
	"/cgi-bin/musicu.fcg": true, "/v8/fcg-bin/fcg_play_single_song.fcg": true, "/lyric/fcgi-bin/fcg_query_lyric_new.fcg": true,
}

func relayAllowed(method, href string) bool {
	if method != "GET" && method != "POST" {
		return false
	}
	u, err := url.Parse(href)
	if err != nil {
		return false
	}
	return u.Scheme == "https" && (u.Port() == "" || u.Port() == "443") && u.User == nil &&
		allowedHosts[u.Hostname()] && allowedPaths[u.Path]
}

const (
	maxResponse = 2 << 20
	userAgent   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

type UpstreamRequest struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    *string
}

type UpstreamResponse struct {
	Status     int
	Body       string
	RetryAfter string
}

type Transport func(ctx context.Context, req UpstreamRequest) (*UpstreamResponse, error)

/* pacer spaces requests out: QQ Music throttles bursts per IP. */
type pacer struct {
	mu   sync.Mutex
	gap  time.Duration
	next time.Time
}

func (p *pacer) wait(ctx context.Context) {
	p.mu.Lock()
	now := time.Now()
	at := p.next
	if at.Before(now) {
		at = now
	}
	p.next = at.Add(p.gap)
	p.mu.Unlock()
	if d := at.Sub(now); d > 0 {
		select {
		case <-time.After(d):
		case <-ctx.Done():
		}
	}
}

var qqThrottled = regexp.MustCompile(`"code":\s*2001\b`)

func newTransport(neteaseRealIP string, qqGap, neteaseGap time.Duration) Transport {
	client := &http.Client{
		Timeout:       12 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	qq, netease := &pacer{gap: qqGap}, &pacer{gap: neteaseGap}
	retryDelays := []time.Duration{2 * time.Second}

	once := func(ctx context.Context, r UpstreamRequest) (*UpstreamResponse, error) {
		method := strings.ToUpper(r.Method)
		if method == "" {
			method = "GET"
		}
		u, err := url.Parse(r.URL)
		if method != "GET" && method != "POST" {
			return nil, errors.New("method not allowed")
		}
		if err != nil {
			return nil, errors.New("bad url")
		}
		if u.Scheme != "https" || !allowedHosts[u.Hostname()] || (u.Port() != "" && u.Port() != "443") {
			return nil, errors.New("host not allowed")
		}
		headers := http.Header{}
		headers.Set("User-Agent", userAgent)
		headers.Set("Accept", "application/json")
		for name, value := range r.Headers {
			switch strings.ToLower(name) {
			case "referer", "content-type", "accept":
				headers.Set(name, value)
			}
		}
		if r.Body != nil && headers.Get("Content-Type") == "" {
			headers.Set("Content-Type", "application/json")
		}
		host := u.Hostname()
		/* NetEase answers overseas / datacenter addresses with encrypted search results. */
		if neteaseRealIP != "" && strings.HasSuffix(host, "163.com") {
			headers.Set("X-Real-IP", neteaseRealIP)
			headers.Set("X-Forwarded-For", neteaseRealIP)
		}
		if strings.HasSuffix(host, "qq.com") {
			qq.wait(ctx)
		} else {
			netease.wait(ctx)
		}
		var body io.Reader
		if r.Body != nil {
			body = strings.NewReader(*r.Body)
		}
		req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
		if err != nil {
			return nil, errors.New("bad url")
		}
		req.Header = headers
		resp, err := client.Do(req)
		if err != nil {
			var timeout interface{ Timeout() bool }
			if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &timeout) && timeout.Timeout()) {
				return nil, errors.New("upstream timeout")
			}
			return nil, fmt.Errorf("upstream error: %v", errors.Unwrap(err))
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
		if err != nil {
			return nil, fmt.Errorf("upstream error: %v", err)
		}
		if len(data) > maxResponse {
			return nil, errors.New("响应超过 2 MiB 限制")
		}
		return &UpstreamResponse{resp.StatusCode, string(data), resp.Header.Get("Retry-After")}, nil
	}

	/* QQ answers HTTP 200 + code 2001 (empty results) while it throttles this
	 * address; the window passes within seconds, so back off and try again. */
	return func(ctx context.Context, r UpstreamRequest) (*UpstreamResponse, error) {
		res, err := once(ctx, r)
		for _, delay := range retryDelays {
			if err != nil || !strings.HasSuffix(hostOf(r.URL), "qq.com") || !qqThrottled.MatchString(truncate(res.Body, 200)) {
				break
			}
			select {
			case <-time.After(delay):
			case <-ctx.Done():
			}
			res, err = once(ctx, r)
		}
		return res, err
	}
}

func hostOf(href string) string {
	u, err := url.Parse(href)
	if err != nil {
		return ""
	}
	return u.Hostname()
}
