'use strict';
/*
 * Spot-Lyric lyrics server.
 *
 * Matching runs in the Spotify client (src/core.js): NetEase / QQ Music search,
 * scoring, lyric download and parsing all happen on the user's machine. This
 * server only
 *   - stores shared matches: one object per Spotify track in Cloudflare R2 with the
 *     chosen NetEase / QQ song and its lyrics ("使用此歌词" / the upload button);
 *     the latest upload wins;
 *   - relays provider requests verbatim for clients whose renderer cannot reach
 *     NetEase / QQ directly (CORS). Only an allow-list of hosts and API paths is
 *     forwarded and nothing is interpreted (RELAY=0 turns this off).
 * Besides a bounded memory cache the server keeps no state of its own.
 */
const nodeHttp = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const core = require(process.env.SPOT_LYRIC_CORE || path.join(__dirname, '../../src/core.js'));
const { MemoryCache, DirBucket, BindingStore } = require('./store');
const { S3Bucket } = require('./r2');
const { createTransport, relayAllowed } = require('./upstream');

const VERSION = (() => {
  try { return fs.readFileSync(path.join(__dirname, '../../VERSION'), 'utf8').trim(); } catch (_) { return '0.0.0'; }
})();
/* Word-timed lyrics with translations stay well below this. */
const MAX_BODY = 2 * 1024 * 1024;
const NAMES = core.PROVIDER_NAMES;

function config(env) {
  const int = (value, fallback) => { const n = parseInt(value, 10); return Number.isFinite(n) ? n : fallback; };
  return {
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 8080),
    dataDir: env.DATA_DIR || path.join(__dirname, '../data'),
    origins: new Set((env.ALLOWED_ORIGINS || 'https://xpui.app.spotify.com').split(',').map(s => s.trim()).filter(Boolean)),
    token: env.API_TOKEN || '',
    trustProxy: env.TRUST_PROXY !== '0',
    relay: env.RELAY !== '0',
    neteaseRealIp: env.NETEASE_REAL_IP === undefined ? '211.161.244.70' : env.NETEASE_REAL_IP,
    qqGapMs: int(env.QQ_MIN_INTERVAL_MS, 400),
    neteaseGapMs: int(env.NETEASE_MIN_INTERVAL_MS, 120),
    cacheBytes: int(env.CACHE_MB, 64) * 1024 * 1024,
    readLimit: int(env.RATE_LIMIT, 240),
    writeLimit: int(env.WRITE_RATE_LIMIT, 30),
    relayLimit: int(env.RELAY_RATE_LIMIT, 120),
    r2Prefix: env.R2_PREFIX === undefined ? 'lyrics/' : env.R2_PREFIX,
    logRequests: env.LOG_REQUESTS !== '0',
  };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* Fixed one-minute windows per client address. */
class RateLimiter {
  constructor(limit) { this.limit = limit; this.window = 0; this.counts = new Map(); }
  allow(key) {
    if (this.limit <= 0) return true;
    const window = Math.floor(Date.now() / 60000);
    if (window !== this.window) { this.window = window; this.counts.clear(); }
    const n = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, n);
    return n <= this.limit;
  }
}

/* ------------------------------------------------------------ input ------ */
const str = (value, max) => (typeof value === 'string' ? value : '').slice(0, max);
function cleanTrack(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'track required');
  const track = {
    uri: str(input.uri, 200),
    title: str(input.title, 500),
    artists: Array.isArray(input.artists) ? input.artists.filter(a => typeof a === 'string').slice(0, 20).map(a => a.slice(0, 300)) : [],
    album: str(input.album, 500),
    duration_ms: Number.isFinite(input.duration_ms) ? Math.max(0, Math.min(86400000, Math.trunc(input.duration_ms))) : 0,
  };
  if (!track.title.trim()) throw new HttpError(400, 'track.title required');
  return track;
}
/* The provider song the lyrics came from; optional (local LRC files have none). */
function cleanCandidate(input) {
  if (input == null) return null;
  const candidate = core.candidateFromJson(input);
  if (!candidate) throw new HttpError(400, 'bad candidate');
  candidate.id = candidate.id.slice(0, 64); candidate.mid = (candidate.mid || '').slice(0, 64);
  if (!/^\d{1,20}$/.test(candidate.id)) throw new HttpError(400, 'bad candidate id');
  return candidate;
}
const providerUrl = c => c.provider === 'qq' ? (c.mid ? `https://y.qq.com/n/ryqq/songDetail/${c.mid}` : '') : `https://music.163.com/#/song?id=${c.id}`;
/* What GET /api/bindings returns: everything but the LRC copy (kept in the object for people reading the bucket). */
const publicDoc = doc => { const { lrc: _lrc, ...rest } = doc; return rest; };

/* ------------------------------------------------------------- app ------- */
function createApp(options = {}) {
  const env = options.env || process.env;
  const cfg = { ...config(env), ...(options.config || {}) };
  const cache = new MemoryCache(cfg.cacheBytes, 86400);
  /* R2 (or any S3-compatible bucket); without one, a local directory for development. */
  const bucket = options.bucket || S3Bucket.fromEnv(env) || new DirBucket(path.join(cfg.dataDir, 'objects'));
  const storage = bucket.local ? 'local' : 'r2';
  const bindings = new BindingStore(bucket, cache, cfg.r2Prefix);
  const upstream = options.transport || createTransport({ neteaseRealIp: cfg.neteaseRealIp, qqGapMs: cfg.qqGapMs, neteaseGapMs: cfg.neteaseGapMs });
  const readLimiter = new RateLimiter(cfg.readLimit), writeLimiter = new RateLimiter(cfg.writeLimit), relayLimiter = new RateLimiter(cfg.relayLimit);
  const locks = new Map();

  /* One write at a time per track, so the last click is also the last write. */
  function serialize(id, task) {
    const previous = locks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    const tail = next.catch(() => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return next;
  }
  function trackId(track) {
    const id = core.spotifyId(track.uri);
    if (!id) throw new HttpError(400, '只有 Spotify 曲目可以保存到服务器');
    return id;
  }

  /* "使用此歌词" or the upload button: the lyrics come from the client. */
  async function bind(body) {
    const track = cleanTrack(body.track);
    const id = trackId(track);
    const candidate = cleanCandidate(body.candidate);
    const lyrics = core.sanitizeLyrics(body.lyrics);
    if (!lyrics) throw new HttpError(422, '没有可保存的歌词');
    /* Spotify's own (licensed) lyrics are never redistributed. */
    if (lyrics.source === 'spotify') throw new HttpError(422, 'Spotify 官方歌词不能上传');
    if (candidate && lyrics.source !== candidate.provider) throw new HttpError(400, '歌词来源与匹配结果不一致');
    lyrics.track_uri = `spotify:track:${id}`; lyrics.track_id = id;
    const spotifyUrl = `https://open.spotify.com/track/${id}`;
    return serialize(id, async () => {
      const now = new Date().toISOString();
      let previous = null;
      try { previous = await bindings.get(id); } catch (err) { console.error('[storage] get', id, err.message); }
      const lrc = core.exportLrc(lyrics);
      /* One object per Spotify track: link + match info + lyrics. */
      const doc = {
        spotify_url: spotifyUrl,
        spotify_uri: `spotify:track:${id}`,
        track: { title: track.title, artists: track.artists, album: track.album, duration_ms: track.duration_ms },
        match: candidate ? { ...core.candidateJson(candidate), provider_name: NAMES[candidate.provider], url: providerUrl(candidate) } : null,
        source: lyrics.source,
        sync_type: lyrics.sync_type,
        line_count: lyrics.lines.length,
        translated: lyrics.lines.some(l => l.translated_text),
        lyrics_sha256: crypto.createHash('sha256').update(lrc).digest('hex'),
        bind_count: ((previous && previous.bind_count) || 0) + 1,
        created_at: (previous && previous.created_at) || now,
        updated_at: now,
        lrc,
        lyrics,
      };
      try {
        const metadata = { 'spotify-url': spotifyUrl, source: lyrics.source };
        if (candidate) { metadata.provider = candidate.provider; metadata['provider-id'] = candidate.id; }
        await bindings.save(id, doc, metadata);
      } catch (err) {
        console.error('[storage] put', id, err.message);
        throw new HttpError(502, `保存到 ${storage === 'r2' ? 'R2' : '存储'}失败：${err.message}`);
      }
      return { stored: storage, updated_at: now, binding: publicDoc(doc) };
    });
  }

  async function unbind(body) {
    const id = trackId(cleanTrack(body.track));
    return serialize(id, async () => {
      try { await bindings.remove(id); }
      catch (err) { console.error('[storage] delete', id, err.message); throw new HttpError(502, `从存储删除失败：${err.message}`); }
      return { removed: true };
    });
  }

  /* The stored match and lyrics for one Spotify track. */
  async function binding(id) {
    let doc;
    try { doc = await bindings.get(id); } catch (err) { throw new HttpError(502, err.message); }
    if (!doc) throw new HttpError(404, 'not bound');
    return { binding: publicDoc(doc) };
  }

  /* Forwards one provider request built by the client (allow-listed, not interpreted). */
  async function relay(body) {
    if (!cfg.relay) throw new HttpError(403, '此服务器未开启转发');
    const method = String(body.method || 'GET').toUpperCase();
    const url = str(body.url, 4096);
    if (!relayAllowed(method, url)) throw new HttpError(400, '不允许转发这个地址');
    const headers = {};
    if (body.headers && typeof body.headers === 'object') {
      for (const [name, value] of Object.entries(body.headers).slice(0, 10)) if (typeof value === 'string') headers[name] = value.slice(0, 500);
    }
    const payload = body.body == null ? null : str(body.body, 64 * 1024);
    let response;
    try { response = await upstream({ method, url, headers, body: payload }); }
    catch (err) { throw new HttpError(502, `转发失败：${err.message}`); }
    return { status: response.status, body: response.body, retry_after: response.retryAfter || null };
  }

  /* ------------------------------------------------------------ http ---- */
  function clientAddress(req) {
    if (cfg.trustProxy) {
      const forwarded = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || '';
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) { reject(new HttpError(413, 'request too large')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!size) return resolve({});
        try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(value && typeof value === 'object' ? value : {}); }
        catch (_) { reject(new HttpError(400, 'invalid JSON')); }
      });
      req.on('error', reject);
    });
  }
  function respond(req, res, status, payload) {
    const origin = req.headers.origin;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (origin && (cfg.origins.has('*') || cfg.origins.has(origin))) {
      headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      headers['Access-Control-Max-Age'] = '86400';
    }
    if (payload === null) { res.writeHead(status, headers); res.end(); return; }
    res.writeHead(status, headers);
    res.end(JSON.stringify(payload));
  }

  const routes = { '/api/bind': bind, '/api/unbind': unbind, '/api/relay': relay };
  const writes = new Set(['/api/bind', '/api/unbind']);
  /* Matching moved to the client in v1.2: tell old clients to update. */
  const retired = new Set(['/api/match', '/api/search', '/api/lyrics']);

  async function handle(req, res) {
    const started = Date.now();
    let status = 500;
    const url = new URL(req.url, 'http://localhost');
    const send = (code, payload) => { status = code; respond(req, res, code, payload); };
    try {
      const origin = req.headers.origin;
      if (origin && !cfg.origins.has('*') && !cfg.origins.has(origin)) throw new HttpError(403, 'origin not allowed');
      if (req.method === 'OPTIONS') return send(204, null);
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
        return send(200, { ok: true, version: VERSION, storage, auth: !!cfg.token, relay: cfg.relay });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        return send(200, { name: 'spot-lyric-server', version: VERSION, docs: 'GET /api/bindings/<spotify-track-id> | POST /api/bind | /api/unbind | /api/relay' });
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
      if (cfg.token) {
        const given = Buffer.from(String(req.headers.authorization || '')), wanted = Buffer.from(`Bearer ${cfg.token}`);
        if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) throw new HttpError(401, '需要歌词服务器令牌');
      }
      if (retired.has(url.pathname)) throw new HttpError(410, '客户端版本过旧：请重新运行 patch 脚本更新 Spot-Lyric');
      const address = clientAddress(req);
      const write = writes.has(url.pathname), relaying = url.pathname === '/api/relay';
      if (!readLimiter.allow(address) || (write && !writeLimiter.allow(address)) || (relaying && !relayLimiter.allow(address))) {
        throw new HttpError(429, '请求过于频繁，请稍后再试');
      }
      const bindingMatch = /^\/api\/bindings\/([A-Za-z0-9]{22})$/.exec(url.pathname);
      if (req.method === 'GET' && bindingMatch) return send(200, await binding(bindingMatch[1]));
      const route = routes[url.pathname];
      if (!route) throw new HttpError(404, 'not found');
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      const body = await readBody(req);
      return send(200, await route(body));
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.message });
      console.error('[server]', req.method, url.pathname, err);
      return send(500, { error: 'internal error' });
    } finally {
      if (cfg.logRequests && url.pathname !== '/health') console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    }
  }

  const server = nodeHttp.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 65000;
  return {
    server, cache, bucket, storage, config: cfg,
    listen() { return new Promise(resolve => server.listen(cfg.port, cfg.host, () => resolve(server.address()))); },
    close() { return new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections && server.closeAllConnections(); }); },
  };
}

if (require.main === module) {
  const app = createApp();
  app.listen().then(address => {
    console.log(`spot-lyric-server v${VERSION} listening on ${address.address}:${address.port} · storage: ${app.storage === 'r2' ? 'R2' : 'local directory (no R2 configured)'} · relay: ${app.config.relay ? 'on' : 'off'}`);
  });
  const stop = () => { app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createApp, config, VERSION };
