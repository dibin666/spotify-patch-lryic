'use strict';
/*
 * Spot-Lyric lyrics server.
 *
 * Runs the spot-lyric matching engine (src/core.js) for the Spotify client:
 * NetEase / QQ Music search, scoring, lyric download and parsing all happen here.
 * Manual matches ("使用此歌词") are stored in Cloudflare R2: one object per
 * Spotify track with the match info and the chosen lyrics; the latest choice wins.
 * The server keeps no state of its own besides a bounded memory cache.
 */
const nodeHttp = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const core = require(process.env.SPOT_LYRIC_CORE || path.join(__dirname, '../../src/core.js'));
const { MemoryCache, DirBucket, BindingStore, EngineStore } = require('./store');
const { S3Bucket } = require('./r2');
const { createTransport } = require('./upstream');

const VERSION = (() => {
  try { return fs.readFileSync(path.join(__dirname, '../../VERSION'), 'utf8').trim(); } catch (_) { return '0.0.0'; }
})();
const MAX_BODY = 512 * 1024;
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
    neteaseRealIp: env.NETEASE_REAL_IP === undefined ? '211.161.244.70' : env.NETEASE_REAL_IP,
    qqGapMs: int(env.QQ_MIN_INTERVAL_MS, 400),
    neteaseGapMs: int(env.NETEASE_MIN_INTERVAL_MS, 120),
    cacheBytes: int(env.CACHE_MB, 64) * 1024 * 1024,
    readLimit: int(env.RATE_LIMIT, 240),
    writeLimit: int(env.WRITE_RATE_LIMIT, 30),
    matchTimeoutMs: int(env.MATCH_TIMEOUT_MS, 30000),
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
function cleanSettings(input) {
  const s = input && typeof input === 'object' ? input : {};
  return {
    preferred_provider: core.PROVIDERS.includes(s.preferred_provider) ? s.preferred_provider : 'netease',
    spotify_first: s.spotify_first === true, loose_match: s.loose_match === true, verify_lyrics: s.verify_lyrics !== false,
  };
}
/* Spotify's lyrics as sent by the client (line text only). */
function cleanReference(input) {
  if (input === undefined) return core.DEFER;
  if (!input || input === 'none' || typeof input !== 'object' || !Array.isArray(input.lines)) return null;
  const lines = input.lines.slice(0, 400).map((l, i) => {
    const start = l && Number.isFinite(l.start_time_ms) ? Math.trunc(l.start_time_ms) : i * 1000;
    return { text: str(l && l.text, 300), start_time_ms: start, end_time_ms: start, words: [] };
  });
  const sync = ['word', 'line', 'unsynced'].includes(input.sync_type) ? input.sync_type : 'line';
  return { source: 'spotify', provider: 'spotify', sync_type: sync, lines };
}
function cleanCandidate(input) {
  const candidate = core.candidateFromJson(input);
  if (!candidate) throw new HttpError(400, 'candidate required');
  candidate.id = candidate.id.slice(0, 64); candidate.mid = (candidate.mid || '').slice(0, 64);
  if (!/^\d{1,20}$/.test(candidate.id)) throw new HttpError(400, 'bad candidate id');
  return candidate;
}
const failedStatus = status => /^(请求失败|来源暂不可用)/.test(status || '');
const providerUrl = c => c.provider === 'qq' ? (c.mid ? `https://y.qq.com/n/ryqq/songDetail/${c.mid}` : '') : `https://music.163.com/#/song?id=${c.id}`;

/* ------------------------------------------------------------- app ------- */
function createApp(options = {}) {
  const env = options.env || process.env;
  const cfg = { ...config(env), ...(options.config || {}) };
  const cache = new MemoryCache(cfg.cacheBytes, 86400);
  /* R2 (or any S3-compatible bucket); without one, a local directory for development. */
  const bucket = options.bucket || S3Bucket.fromEnv(env) || new DirBucket(path.join(cfg.dataDir, 'objects'));
  const storage = bucket.local ? 'local' : 'r2';
  const bindings = new BindingStore(bucket, cache, cfg.r2Prefix);
  const http = new core.Http(options.transport || createTransport({ neteaseRealIp: cfg.neteaseRealIp, qqGapMs: cfg.qqGapMs, neteaseGapMs: cfg.neteaseGapMs }));
  const store = new EngineStore(cache, bindings, core);
  const readLimiter = new RateLimiter(cfg.readLimit), writeLimiter = new RateLimiter(cfg.writeLimit);
  const locks = new Map();
  const engine = (settings, spotify) => new core.Engine({ store, http, settings: () => settings, spotify: spotify || null });

  /* One bind / unbind at a time per track, so the last click is also the last write. */
  function serialize(id, task) {
    const previous = locks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    const tail = next.catch(() => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return next;
  }

  async function storedBinding(id) {
    try { return await bindings.get(id); }
    catch (e) { console.error('[storage] get', id, e.message); return null; }
  }

  async function match(body, signal) {
    const track = cleanTrack(body.track);
    const settings = cleanSettings(body.settings);
    const reference = cleanReference(body.spotify);
    const id = core.spotifyId(track.uri);
    if (id && !body.force) {
      /* The lyrics the user chose are served straight from R2. */
      const doc = await storedBinding(id);
      /* Lyrics stored by an older parser (e.g. misplaced translations) are re-fetched from the bound source. */
      if (doc && doc.match && core.lyricsUsable(doc.lyrics) && doc.lyrics.parser !== core.PARSER_VERSION) {
        try { const fresh = await bind({ track: body.track, candidate: doc.match }); if (core.lyricsUsable(fresh.lyrics)) return { status: fresh.status, lyrics: fresh.lyrics, manual: true }; }
        catch (err) { console.error('[refresh]', id, err.message); }
      }
      if (doc && doc.match && core.lyricsUsable(doc.lyrics)) return { status: `已绑定歌词 · ${NAMES[doc.match.provider] || doc.match.provider}`, lyrics: doc.lyrics, manual: true };
    }
    const spotify = async () => reference === core.DEFER ? core.DEFER : reference ? { lyrics: reference, colors: null } : null;
    const e = engine(settings, spotify);
    const timer = setTimeout(() => e.controller && e.controller.abort(), cfg.matchTimeoutMs);
    const onAbort = () => e.controller && e.controller.abort();
    signal.addEventListener('abort', onAbort);
    try { await e.setTrack(track, !!body.force); } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
    if (e.busy) throw new HttpError(504, '匹配超时，请稍后重试');
    if (e.deferred) return { status: e.status, need_spotify: true, verifiable: e.deferred.verifiable, failed: e.deferred.failed };
    if (e.lyrics && e.lyrics.source === 'spotify') return { status: e.status, use_spotify: true };
    const usable = core.lyricsUsable(e.lyrics);
    return { status: e.status, lyrics: usable ? e.lyrics : null, manual: /^已绑定/.test(e.status), failed: !usable && failedStatus(e.status) };
  }

  async function search(body) {
    const query = str(body.query, 2048).trim();
    if (!query) throw new HttpError(400, 'query required');
    const e = engine(cleanSettings(body.settings));
    try { e.track = body.track ? cleanTrack(body.track) : null; } catch (_) { e.track = null; }
    const result = await e.search(query);
    return { providers: result.providers };
  }

  async function lyrics(body) {
    const candidate = cleanCandidate(body.candidate);
    try { return { lyrics: await engine(cleanSettings(null)).preview(candidate) }; }
    catch (err) { throw new HttpError(502, err.message || String(err)); }
  }

  async function bind(body) {
    const track = cleanTrack(body.track);
    const candidate = cleanCandidate(body.candidate);
    const id = core.spotifyId(track.uri);
    if (!id) throw new HttpError(400, '只有 Spotify 曲目可以保存到服务器');
    /* Lyrics are always downloaded by the server: the client cannot inject text. */
    let lyrics;
    try { lyrics = await engine(cleanSettings(null)).providerFetch(candidate, null, { remaining: 2 }); }
    catch (err) { throw new HttpError(502, err.message || String(err)); }
    if (!core.lyricsUsable(lyrics)) throw new HttpError(422, '这个结果没有歌词');
    lyrics = { ...lyrics, track_uri: `spotify:track:${id}`, track_id: id };
    const spotifyUrl = `https://open.spotify.com/track/${id}`;
    return serialize(id, async () => {
      const now = new Date().toISOString();
      const previous = await storedBinding(id);
      const lrc = core.exportLrc(lyrics);
      /* One object per Spotify track: link + match info + lyrics. */
      const doc = {
        spotify_url: spotifyUrl,
        spotify_uri: `spotify:track:${id}`,
        track: { title: track.title, artists: track.artists, album: track.album, duration_ms: track.duration_ms },
        match: { ...core.candidateJson(candidate), provider_name: NAMES[candidate.provider], url: providerUrl(candidate) },
        sync_type: lyrics.sync_type,
        line_count: lyrics.lines.length,
        lyrics_sha256: crypto.createHash('sha256').update(lrc).digest('hex'),
        bind_count: ((previous && previous.bind_count) || 0) + 1,
        created_at: (previous && previous.created_at) || now,
        updated_at: now,
        lrc,
        lyrics,
      };
      try {
        await bindings.save(id, doc, { 'spotify-url': spotifyUrl, provider: candidate.provider, 'provider-id': candidate.id });
      } catch (err) {
        console.error('[storage] put', id, err.message);
        throw new HttpError(502, `保存到 R2 失败：${err.message}`);
      }
      return { status: `已绑定歌词 · ${NAMES[candidate.provider]}`, lyrics, stored: storage, updated_at: now };
    });
  }

  async function unbind(body) {
    const track = cleanTrack(body.track);
    const id = core.spotifyId(track.uri);
    if (!id) throw new HttpError(400, '只有 Spotify 曲目保存在服务器');
    return serialize(id, async () => {
      try { await bindings.remove(id); }
      catch (err) { console.error('[storage] delete', id, err.message); throw new HttpError(502, `从 R2 删除失败：${err.message}`); }
      return { removed: true };
    });
  }

  /* Match info for one track (lyrics as LRC only, to keep it small). */
  async function binding(id) {
    let doc;
    try { doc = await bindings.get(id); } catch (err) { throw new HttpError(502, err.message); }
    if (!doc) throw new HttpError(404, 'not bound');
    const { lyrics: _lyrics, ...rest } = doc;
    return { binding: rest };
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

  const routes = { '/api/match': match, '/api/search': search, '/api/lyrics': lyrics, '/api/bind': bind, '/api/unbind': unbind };
  const writes = new Set(['/api/bind', '/api/unbind']);

  async function handle(req, res) {
    const started = Date.now();
    let status = 500;
    const url = new URL(req.url, 'http://localhost');
    const send = (code, payload) => { status = code; respond(req, res, code, payload); };
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      const origin = req.headers.origin;
      if (origin && !cfg.origins.has('*') && !cfg.origins.has(origin)) throw new HttpError(403, 'origin not allowed');
      if (req.method === 'OPTIONS') return send(204, null);
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
        return send(200, { ok: true, version: VERSION, storage, auth: !!cfg.token });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        return send(200, { name: 'spot-lyric-server', version: VERSION, docs: 'POST /api/match | /api/search | /api/lyrics | /api/bind | /api/unbind, GET /api/bindings/<spotify-track-id>' });
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
      if (cfg.token) {
        const given = Buffer.from(String(req.headers.authorization || '')), wanted = Buffer.from(`Bearer ${cfg.token}`);
        if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) throw new HttpError(401, '需要歌词服务器令牌');
      }
      const address = clientAddress(req);
      const write = writes.has(url.pathname);
      if (!readLimiter.allow(address) || (write && !writeLimiter.allow(address))) throw new HttpError(429, '请求过于频繁，请稍后再试');
      const bindingMatch = /^\/api\/bindings\/([A-Za-z0-9]{22})$/.exec(url.pathname);
      if (req.method === 'GET' && bindingMatch) return send(200, await binding(bindingMatch[1]));
      const route = routes[url.pathname];
      if (!route) throw new HttpError(404, 'not found');
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      const body = await readBody(req);
      return send(200, await route(body, controller.signal));
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
    console.log(`spot-lyric-server v${VERSION} listening on ${address.address}:${address.port} · storage: ${app.storage === 'r2' ? 'R2' : 'local directory (no R2 configured)'}`);
  });
  const stop = () => { app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createApp, config, VERSION };
