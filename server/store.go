package server

// Storage: one JSON object per Spotify track in object storage (R2 / S3), with a
// bounded in-memory LRU cache. A local directory is used when no bucket is set.

import (
	"container/list"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Bucket interface {
	Put(ctx context.Context, key, body, contentType string, metadata map[string]string) error
	// Get returns ("", false, nil) when the object does not exist.
	Get(ctx context.Context, key string) (string, bool, error)
	Delete(ctx context.Context, key string) error
	Local() bool
}

/* ----------------------------------------------------------- cache ---- */
type cacheEntry struct {
	key     string
	value   obj // nil = cached "not found"
	size    int
	expires time.Time
}

type MemoryCache struct {
	mu       sync.Mutex
	maxBytes int
	bytes    int
	ttl      time.Duration
	order    *list.List // front = most recently used
	items    map[string]*list.Element
}

func NewMemoryCache(maxBytes int, ttl time.Duration) *MemoryCache {
	return &MemoryCache{maxBytes: maxBytes, ttl: ttl, order: list.New(), items: map[string]*list.Element{}}
}

func (c *MemoryCache) Get(key string) (value obj, found bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[key]
	if !ok {
		return nil, false
	}
	e := el.Value.(*cacheEntry)
	if !e.expires.After(time.Now()) {
		c.remove(el)
		return nil, false
	}
	c.order.MoveToFront(el)
	return e.value, true
}

func (c *MemoryCache) Set(key string, value obj, ttl time.Duration, size int) {
	if c.maxBytes <= 0 || size > c.maxBytes/4 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.remove(el)
	}
	if ttl <= 0 {
		ttl = c.ttl
	}
	c.items[key] = c.order.PushFront(&cacheEntry{key, value, size, time.Now().Add(ttl)})
	c.bytes += size
	for c.bytes > c.maxBytes && c.order.Len() > 0 {
		c.remove(c.order.Back())
	}
}

func (c *MemoryCache) remove(el *list.Element) {
	e := el.Value.(*cacheEntry)
	c.bytes -= e.size
	delete(c.items, e.key)
	c.order.Remove(el)
}

/* ------------------------------------------------------- DirBucket ---- */
type DirBucket struct{ dir string }

var keyRe = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)

func (d *DirBucket) Local() bool { return true }

func (d *DirBucket) file(key string) (string, error) {
	if !keyRe.MatchString(key) || strings.Contains(key, "..") {
		return "", errors.New("bad key")
	}
	return filepath.Join(d.dir, key), nil
}

func (d *DirBucket) Put(_ context.Context, key, body, _ string, _ map[string]string) error {
	file, err := d.file(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if err := os.WriteFile(tmp, []byte(body), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

func (d *DirBucket) Get(_ context.Context, key string) (string, bool, error) {
	file, err := d.file(key)
	if err != nil {
		return "", false, err
	}
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	return string(data), err == nil, err
}

func (d *DirBucket) Delete(_ context.Context, key string) error {
	file, err := d.file(key)
	if err != nil {
		return err
	}
	if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

/* -------------------------------------------------- BindingStore ---- */
type BindingStore struct {
	bucket Bucket
	cache  *MemoryCache
	prefix string
	ttl    time.Duration
}

func NewBindingStore(b Bucket, c *MemoryCache, prefix string) *BindingStore {
	return &BindingStore{b, c, prefix, 5 * time.Minute}
}

func (s *BindingStore) key(id string) string { return s.prefix + id + ".json" }

/* Get returns the stored document, or nil when there is none; errors when storage is unreachable. */
func (s *BindingStore) Get(ctx context.Context, id string) (obj, error) {
	cacheKey := "binding:" + id
	if v, ok := s.cache.Get(cacheKey); ok {
		return v, nil
	}
	text, found, err := s.bucket.Get(ctx, s.key(id))
	if err != nil {
		return nil, err
	}
	var doc obj
	size := 64
	if found {
		size = len(text) * 2
		if json.Unmarshal([]byte(text), &doc) != nil {
			doc = nil
		}
	}
	s.cache.Set(cacheKey, doc, s.ttl, size)
	return doc, nil
}

func (s *BindingStore) Save(ctx context.Context, id string, doc any, metadata map[string]string) (obj, error) {
	text, err := marshalIndent(doc)
	if err != nil {
		return nil, err
	}
	if err := s.bucket.Put(ctx, s.key(id), text, "application/json; charset=utf-8", metadata); err != nil {
		return nil, err
	}
	var m obj
	_ = json.Unmarshal([]byte(text), &m)
	s.cache.Set("binding:"+id, m, s.ttl, len(text)*2)
	return m, nil
}

func (s *BindingStore) Remove(ctx context.Context, id string) error {
	if err := s.bucket.Delete(ctx, s.key(id)); err != nil {
		return err
	}
	s.cache.Set("binding:"+id, nil, s.ttl, 64)
	return nil
}
