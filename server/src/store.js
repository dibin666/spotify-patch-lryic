'use strict';
/*
 * Storage for the lyrics server.
 *
 * Everything persistent lives in object storage (Cloudflare R2): one JSON object
 * per Spotify track holding the Spotify link, the chosen NetEase / QQ song (match
 * info) and its lyrics. The latest "使用此歌词" overwrites the object. The server
 * keeps only a bounded in-memory cache.
 */
const fs = require('node:fs');
const path = require('node:path');

/* --------------------------------------------------------------- cache --- */
/* LRU with TTL and a byte budget; never written to disk. */
class MemoryCache {
  constructor(maxBytes, defaultTtl) {
    this.maxBytes = maxBytes; this.defaultTtl = defaultTtl; this.bytes = 0; this.map = new Map();
  }
  has(key) { return this.get(key) !== undefined; }
  /** @returns {any} the value, or undefined when missing / expired */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) { this.delete(key); return undefined; }
    this.map.delete(key); this.map.set(key, entry);
    return entry.value;
  }
  set(key, value, ttlSeconds, size) {
    if (this.maxBytes <= 0) return;
    size = size || key.length + (typeof value === 'string' ? value.length * 2 : 256);
    if (size > this.maxBytes / 4) return;
    this.delete(key);
    this.map.set(key, { value, size, expires: Date.now() + (ttlSeconds || this.defaultTtl) * 1000 });
    this.bytes += size;
    for (const [oldest] of this.map) { if (this.bytes <= this.maxBytes) break; this.delete(oldest); }
  }
  delete(key) {
    const entry = this.map.get(key);
    if (entry) { this.bytes -= entry.size; this.map.delete(key); }
  }
  clear() { this.map.clear(); this.bytes = 0; }
}

/* Same interface as S3Bucket, backed by a directory. Used only when no R2 /
 * S3 bucket is configured (local development, tests). */
class DirBucket {
  constructor(dir) { this.dir = dir; this.local = true; }
  _file(key) {
    if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.includes('..')) throw new Error('bad key');
    return path.join(this.dir, key);
  }
  async put(key, body) {
    const file = this._file(key);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, body);
    await fs.promises.rename(temp, file);
  }
  async get(key) {
    try { return await fs.promises.readFile(this._file(key), 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async delete(key) { await fs.promises.rm(this._file(key), { force: true }); }
}

/* ------------------------------------------------------------ bindings --- */
/* Manual matches, one object per Spotify track id: `${prefix}${id}.json`. */
class BindingStore {
  constructor(bucket, cache, prefix = 'lyrics/', ttl = 300) {
    this.bucket = bucket; this.cache = cache; this.prefix = prefix; this.ttl = ttl;
  }
  key(id) { return `${this.prefix}${id}.json`; }
  /** @returns {Promise<object|null>} the stored document; throws when storage is unreachable */
  async get(id) {
    const cacheKey = `binding:${id}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const text = await this.bucket.get(this.key(id));
    let doc = null;
    if (text) { try { doc = JSON.parse(text); } catch (_) { doc = null; } }
    this.cache.set(cacheKey, doc, this.ttl, text ? text.length * 2 : 64);
    return doc;
  }
  async save(id, doc, metadata) {
    const text = JSON.stringify(doc, null, 1);
    await this.bucket.put(this.key(id), text, 'application/json; charset=utf-8', metadata);
    this.cache.set(`binding:${id}`, doc, this.ttl, text.length * 2);
  }
  async remove(id) {
    await this.bucket.delete(this.key(id));
    this.cache.set(`binding:${id}`, null, this.ttl, 64);
  }
}

/* -------------------------------------------------- engine store adapter --- */
/* The matching engine (src/core.js) talks to a "store". On the server provider
 * responses go to the shared memory cache; per-track results are not cached
 * (they depend on each client's settings); manual bindings come from R2. */
class EngineStore {
  constructor(cache, bindings, core) { this.cache = cache; this.bindings = bindings; this.core = core; }
  get(_key, fallback) { return fallback; }
  getInt(_key, fallback) { return fallback; }
  set() {}
  static transient(key) { return key.startsWith('tracklyrics') || key.startsWith('negative:'); }
  async cacheGet(key) { if (EngineStore.transient(key)) return null; const v = this.cache.get(`p:${key}`); return v === undefined ? null : v; }
  async cachePut(key, value, ttl) {
    if (EngineStore.transient(key)) return;
    /* A provider failure pauses that provider for every user here: keep it short. */
    if (key.startsWith('failure:')) ttl = Math.min(ttl || 20, 20);
    this.cache.set(`p:${key}`, value, ttl || undefined);
  }
  async cacheRemove(key) { this.cache.delete(`p:${key}`); }
  async cacheClear() {}
  async kvGet() { return null; }
  async kvSet() {}
  async matchGet(track) {
    const id = this.core.spotifyId(track && track.uri);
    let doc = null;
    if (id) { try { doc = await this.bindings.get(id); } catch (e) { console.error('[storage] get', id, e.message); } }
    const candidate = doc ? this.core.candidateFromJson(doc.match) : null;
    return { candidate, manual: !!candidate };
  }
  /* Automatic / lyric-verified matches are not stored: only "使用此歌词" (POST /api/bind). */
  async matchSave() {}
  async matchRemove() {}
}

module.exports = { MemoryCache, DirBucket, BindingStore, EngineStore };
