/*
 * Spot-Lyric for Spotify — in-client lyrics page modelled on Spotify's own
 * lyrics view, backed by the spot-lyric matching engine (core.js).
 */
(function () {
  'use strict';
  if (window.__spotLyric) return;
  const Core = window.SpotLyricCore;
  if (!Core) { console.error('[spot-lyric] core missing'); return; }

  const VERSION = '__SPOT_LYRIC_VERSION__';
  /* Lyrics server (server/): stores shared matches and relays provider requests (cloud mode). */
  const DEFAULT_SERVER = '__SPOT_LYRIC_SERVER__';
  /* Usage mode chosen when patching: cloud (lyrics server), or pure local without any remote
   * server: local (the local service relays) or direct (Spotify runs with --disable-web-security). */
  const PATCH_MODE = '__SPOT_LYRIC_MODE__';
  /* The local service (`spot-lyric serve --local`). */
  const LOCAL_SERVICE = '__SPOT_LYRIC_LOCAL__';
  const MODES = ['cloud', 'local', 'direct'];
  const BAKED_MODE = MODES.includes(PATCH_MODE) ? PATCH_MODE : 'cloud';
  /* How NetEase / QQ are requested on this machine, chosen when patching (also in cloud mode):
   * direct (--disable-web-security), service (local service) or server (lyrics server relay only).
   * Whatever was chosen, local paths are always tried first: direct -> local service -> server. */
  const PATCH_REQUEST = '__SPOT_LYRIC_REQUEST__';
  const BAKED_REQUEST = ['direct', 'service', 'server'].includes(PATCH_REQUEST) ? PATCH_REQUEST
    : BAKED_MODE === 'direct' ? 'direct' : BAKED_MODE === 'local' ? 'service' : 'server';
  const LOCAL_URL = /^https?:\/\//.test(LOCAL_SERVICE) ? LOCAL_SERVICE.replace(/\/+$/, '') : 'http://127.0.0.1:38917';
  const log = (...args) => console.log('%c[spot-lyric]', 'color:#1ed760;font-weight:bold', ...args);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const NAMES = Core.PROVIDER_NAMES;

  /* ------------------------------------------------------------ DOM ----- */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const child of children.flat()) if (child != null && child !== false) el.append(child.nodeType ? child : String(child));
    return el;
  }
  const svg = (path, size = 16) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 16 16'); el.setAttribute('width', size); el.setAttribute('height', size);
    el.setAttribute('fill', 'currentColor'); el.setAttribute('aria-hidden', 'true');
    el.innerHTML = path; return el;
  };
  const ICON = {
    lyrics: '<path d="M1.5 2.75h9v1.5h-9zm0 4h6.5v1.5H1.5zm0 4h5v1.5h-5z"/><path d="M12.25 2.5h2.75V4.3h-1.25v7.45a2.25 2.25 0 1 1-1.5-2.12z"/>',
    search: '<path d="M7 1.75a5.25 5.25 0 1 0 3.17 9.44l3.32 3.32 1.06-1.06-3.32-3.32A5.25 5.25 0 0 0 7 1.75M3.25 7a3.75 3.75 0 1 1 7.5 0 3.75 3.75 0 0 1-7.5 0"/>',
    close: '<path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06"/>',
    gear: '<path d="M2 3.25h7.1a2.25 2.25 0 0 1 4.3 0H14v1.5h-.6a2.25 2.25 0 0 1-4.3 0H2zm9.25-.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5M2 11.25h.6a2.25 2.25 0 0 1 4.3 0H14v1.5H6.9a2.25 2.25 0 0 1-4.3 0H2zm2.75-.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5"/>',
    translate: '<path d="M1 2.75h7.5v1.5H6.06a9.4 9.4 0 0 1-1.6 3.62c.5.45 1.07.84 1.7 1.15l-.62 1.37a8.4 8.4 0 0 1-2.05-1.38 9.6 9.6 0 0 1-2.38 1.75l-.7-1.33a8 8 0 0 0 2.05-1.5A9.6 9.6 0 0 1 1.3 6h1.6c.22.62.54 1.2.93 1.72A7.9 7.9 0 0 0 4.5 4.25H1zM3.9 1h1.5v1.75H3.9z"/><path d="M10.75 6h1.5l3.2 8.25h-1.6l-.8-2.1h-3.1l-.8 2.1h-1.6zm.75 2.2-1 2.45h2z"/>',
    sync: '<path d="M8 1.5a6.5 6.5 0 0 0-6.06 4.15l1.4.54A5 5 0 0 1 12.28 5.5H10.5V7H15V2.5h-1.5v1.83A6.48 6.48 0 0 0 8 1.5m4.66 8.31A5 5 0 0 1 3.72 10.5H5.5V9H1v4.5h1.5v-1.83a6.5 6.5 0 0 0 11.56-1.32z"/>',
    minus: '<path d="M2 7.25h12v1.5H2z"/>',
    plus: '<path d="M7.25 2v5.25H2v1.5h5.25V14h1.5V8.75H14v-1.5H8.75V2z"/>',
    note: '<path d="M10 1.5v8.27A2.5 2.5 0 1 0 11.5 12V4.6l3-.86V1.95l-4.5 1.3z"/>',
    upload: '<path d="M8 1.94 12.03 6l-1.06 1.06-2.22-2.22v6.41h-1.5V4.84L5.03 7.06 3.97 6z"/><path d="M2 10.5h1.5v2h9v-2H14V14H2z"/>',
    uploaded: '<path d="M13.53 3.47a.75.75 0 0 1 0 1.06L6.5 11.56 2.47 7.53a.75.75 0 1 1 1.06-1.06L6.5 9.44l5.97-5.97a.75.75 0 0 1 1.06 0"/><path d="M2 12.5h12V14H2z"/>',
  };

  /* ------------------------------------------------------- platform ----- */
  function findPlatform() {
    const roots = [document.getElementById('main'), ...document.body.children].filter(Boolean);
    for (const el of roots) {
      const key = Object.keys(el).find(k => k.startsWith('__reactContainer'));
      if (!key) continue;
      const stack = [el[key].stateNode && el[key].stateNode.current || el[key]];
      const seen = new Set();
      for (let n = 0; stack.length && n < 60000; n++) {
        const fiber = stack.pop();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const value = fiber.memoizedProps && fiber.memoizedProps.value;
        if (value && typeof value === 'object' && typeof value.getRegistry === 'function' && typeof value.getHistory === 'function') return value;
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
    }
    return null;
  }
  const waitFor = (fn, interval = 400, timeout = 120000) => new Promise((resolve, reject) => {
    const started = Date.now();
    (function poll() {
      let value = null;
      try { value = fn(); } catch (_) { /* not ready */ }
      if (value) return resolve(value);
      if (Date.now() - started > timeout) return reject(new Error('timeout'));
      setTimeout(poll, interval);
    })();
  });

  /* ---------------------------------------------------------- store ----- */
  const SETTINGS_KEY = 'spot-lyric:settings';
  const DEFAULTS = {
    preferred_provider: 'netease', spotify_first: false, prefetch: true, verify_lyrics: true, relay: true,
    translation: true, word_sync: true, mini_player: true, font_scale: 1, color_mode: 'cover', only_eligible: false,
    server_url: '', server_token: '',
  };
  const cleanServerUrl = url => String(url || '').trim().replace(/\/+$/, '');
  class Store {
    constructor() {
      try { this.values = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (_) { this.values = {}; }
      this.memory = { cache: new Map(), kv: new Map(), matches: new Map() };
      this.db = null; this.puts = 0;
    }
    async open() {
      this.db = await new Promise(resolve => {
        try {
          const request = indexedDB.open('spot-lyric', 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            const cache = db.createObjectStore('cache', { keyPath: 'k' });
            cache.createIndex('a', 'a');
            db.createObjectStore('kv', { keyPath: 'k' });
            db.createObjectStore('matches', { keyPath: 'k' });
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        } catch (_) { resolve(null); }
      });
      if (!this.db) { log('IndexedDB unavailable, using memory store'); return; }
      /* Settings live in IndexedDB: Spotify (CEF) loses recent localStorage writes when it is
       * killed (patch restart, logout, crash), which silently reverted toggles such as 显示译文.
       * localStorage stays as a synchronous mirror and the source for older installs. */
      const saved = await this.kvGet(SETTINGS_KEY);
      if (saved && typeof saved === 'object') this.values = { ...saved };
      else if (Object.keys(this.values).length) this.kvSet(SETTINGS_KEY, { ...this.values });
    }
    /* settings (sync) */
    setting(key) { return key in this.values ? this.values[key] : DEFAULTS[key]; }
    settings() { return { ...DEFAULTS, ...this.values }; }
    get(key, fallback) { return key in this.values ? this.values[key] : fallback; }
    getInt(key, fallback) { const v = parseInt(this.get(key, ''), 10); return isFinite(v) ? v : fallback; }
    set(key, value) {
      if (value === undefined) delete this.values[key]; else this.values[key] = value;
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.values)); } catch (_) { /* quota */ }
      if (this.db) this._put('kv', { k: SETTINGS_KEY, v: { ...this.values } });
    }
    /* idb helpers */
    _tx(name, mode, fn) {
      return new Promise((resolve) => {
        try {
          const tx = this.db.transaction(name, mode);
          const result = fn(tx.objectStore(name));
          tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
          tx.onerror = tx.onabort = () => resolve(undefined);
        } catch (_) { resolve(undefined); }
      });
    }
    async _get(name, key) { return this.db ? this._tx(name, 'readonly', s => s.get(key)) : this.memory[name].get(key); }
    async _put(name, value) { if (this.db) await this._tx(name, 'readwrite', s => s.put(value)); else this.memory[name].set(value.k, value); }
    async _delete(name, key) { if (this.db) await this._tx(name, 'readwrite', s => s.delete(key)); else this.memory[name].delete(key); }
    /* bounded network cache */
    async cacheGet(key) {
      const entry = await this._get('cache', key);
      if (!entry) return null;
      if (entry.e && entry.e <= Date.now()) { this._delete('cache', key); return null; }
      if (Date.now() - entry.a > 3600000) { entry.a = Date.now(); this._put('cache', entry); }
      return entry.v;
    }
    async cachePut(key, value, ttl) {
      if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) return;
      await this._put('cache', { k: key, v: value, e: ttl ? Date.now() + ttl * 1000 : 0, a: Date.now() });
      if (++this.puts % 40 === 0) this._prune();
    }
    async _prune() {
      if (!this.db) { if (this.memory.cache.size > 2000) this.memory.cache.clear(); return; }
      const count = await this._tx('cache', 'readonly', s => s.count());
      if (!(count > 3000)) return;
      let remove = count - 2500;
      await this._tx('cache', 'readwrite', s => {
        const cursor = s.index('a').openCursor();
        cursor.onsuccess = () => { const c = cursor.result; if (c && remove-- > 0) { c.delete(); c.continue(); } };
      });
    }
    cacheRemove(key) { return this._delete('cache', key); }
    async cacheClear() { if (this.db) await this._tx('cache', 'readwrite', s => s.clear()); else this.memory.cache.clear(); }
    async kvGet(key) { const e = await this._get('kv', key); return e ? e.v : null; }
    kvSet(key, value) { return value ? this._put('kv', { k: key, v: value }) : this._delete('kv', key); }
    async matchGet(track) {
      const entry = await this._get('matches', Core.trackKey(track));
      const candidate = entry ? Core.candidateFromJson(entry.c) : null;
      return { candidate, manual: !!(entry && entry.manual) };
    }
    matchSave(track, candidate, manual) { return this._put('matches', { k: Core.trackKey(track), c: Core.candidateJson(candidate), manual: !!manual }); }
    matchRemove(track) { return this._delete('matches', Core.trackKey(track)); }
  }

  /* ---------------------------------------------------- network ----- */
  const serverState = { ok: null, version: '', storage: '', relay: null, error: '', checked: 0 };
  let serverConfig = () => ({ url: cleanServerUrl(DEFAULT_SERVER), token: '' });
  const withTimeout = (signal, ms) => {
    const timeout = AbortSignal.timeout ? AbortSignal.timeout(ms) : null;
    if (!signal) return timeout || undefined;
    return timeout && AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal;
  };
  async function checkServer() {
    const { url } = serverConfig();
    try {
      const r = await fetch(url + '/health', { cache: 'no-store', signal: withTimeout(null, 8000) });
      const data = await r.json();
      serverState.ok = !!data.ok; serverState.version = data.version || ''; serverState.storage = data.storage || '';
      serverState.relay = data.relay !== false; serverState.error = '';
    } catch (e) { serverState.ok = false; serverState.error = e.message || String(e); }
    serverState.checked = Date.now();
    return serverState.ok;
  }
  async function serverTransport(method, path, body, signal) {
    const { url, token } = serverConfig();
    /* text/plain keeps this a "simple" CORS request: no preflight round-trip. */
    const headers = {};
    if (body != null) headers['Content-Type'] = 'text/plain';
    if (token) headers.Authorization = 'Bearer ' + token;
    let response;
    try {
      response = await fetch(url + path, { method, headers, body: body == null ? undefined : body, signal: withTimeout(signal, 30000), cache: 'no-store' });
    } catch (e) {
      if (signal && signal.aborted) throw new Core.ProviderError('请求已取消', 'cancelled');
      serverState.ok = false;
      throw new Core.ProviderError('无法连接歌词服务器', 'network');
    }
    serverState.ok = true;
    return { status: response.status, body: await response.text() };
  }
  const cloud = new Core.Cloud(serverTransport);

  /* Pure local mode: no remote server at all. The local service on 127.0.0.1 (if installed)
   * relays provider requests the renderer may not send itself. */
  let currentMode = () => BAKED_MODE;
  const pureLocal = () => currentMode() !== 'cloud';
  const localState = { ok: null, version: '', error: '', checked: 0 };
  async function checkLocal() {
    try {
      const r = await fetch(LOCAL_URL + '/health', { cache: 'no-store', signal: withTimeout(null, 3000) });
      const data = await r.json();
      localState.ok = !!data.ok && data.relay !== false; localState.version = data.version || ''; localState.error = '';
    } catch (e) { localState.ok = false; localState.error = e.message || String(e); }
    localState.checked = Date.now();
    return localState.ok;
  }
  async function localTransport(method, path, body, signal) {
    let response;
    try {
      response = await fetch(LOCAL_URL + path, {
        method, headers: body != null ? { 'Content-Type': 'text/plain' } : {}, body: body == null ? undefined : body,
        signal: withTimeout(signal, 30000), cache: 'no-store',
      });
    } catch (e) {
      if (signal && signal.aborted) throw new Core.ProviderError('请求已取消', 'cancelled');
      localState.ok = false; localState.checked = Date.now();
      throw new Core.ProviderError('本地服务未运行', 'network');
    }
    localState.ok = true;
    return { status: response.status, body: await response.text() };
  }
  const localRelay = new Core.Cloud(localTransport);
  const checkBackend = () => Promise.all([checkLocal(), pureLocal() ? null : checkServer()]);
  const LOCAL_DOWN = '本机无法直连网易云 / QQ 音乐，本地服务也未运行';
  /* A local service known to be down is re-probed after a while: quickly when it is expected
   * (chosen when patching), rarely otherwise (it may have been installed meanwhile). */
  const localUsable = () => localState.ok !== false ||
    Date.now() - localState.checked > (pureLocal() || BAKED_REQUEST === 'service' ? 15000 : 300000);

  /* NetEase / QQ requests run on this machine. The Spotify renderer enforces CORS
   * and neither service sends CORS headers, so a direct request only works when
   * Spotify was started with --disable-web-security (request "direct"). Otherwise the
   * local service relays the request it is given (allow-listed, no logic), and only
   * when it is not running either, the lyrics server does (cloud mode). */
  const netState = { direct: null, checked: 0, directCount: 0, localCount: 0, serverCount: 0 };
  const FORBIDDEN_HEADERS = /^(referer|user-agent|cookie|origin|host|connection|content-length)$/i;
  async function directFetch(req, signal) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers || {})) if (!FORBIDDEN_HEADERS.test(name)) headers[name] = value;
    const response = await fetch(req.url, {
      method: req.method || 'GET', headers, body: req.body == null ? undefined : req.body, credentials: 'omit',
      referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: withTimeout(signal, 12000),
    });
    return { status: response.status, body: await response.text(), retryAfter: response.headers.get('retry-after') };
  }
  let relayAllowed = () => true;
  async function providerTransport(req, signal) {
    /* A blocked direct attempt is re-probed every 10 minutes (e.g. after a restart with the flag). */
    if (netState.direct !== false || Date.now() - netState.checked > 600000) {
      try {
        const response = await directFetch(req, signal);
        netState.direct = true; netState.checked = Date.now(); netState.directCount++;
        return response;
      } catch (e) {
        if (signal && signal.aborted) throw new Core.ProviderError('请求已取消', 'cancelled');
        /* Once direct requests worked, a failure is a real network error, not CORS. */
        if (netState.direct === true) { const error = new Core.ProviderError('网络错误：' + (e.message || e), 'network'); error.transient = true; throw error; }
        if (netState.direct !== false) log('direct NetEase / QQ requests are blocked (CORS); relaying through the local service or the lyrics server');
        netState.direct = false; netState.checked = Date.now();
      }
    }
    /* Local service before the lyrics server, in every mode. */
    if (localUsable()) {
      try {
        const response = await localRelay.relay(req, signal);
        netState.localCount++;
        return response;
      } catch (e) {
        if (e.kind === 'cancelled') throw e;
        /* The service answered: its error is the answer. Not running: next path. */
        if (localState.ok !== false) throw e;
      }
    }
    if (pureLocal()) throw new Core.ProviderError(LOCAL_DOWN, 'network');
    if (!relayAllowed()) throw new Core.ProviderError('本机无法直连网易云 / QQ 音乐，本地服务未运行（已关闭服务器转发）', 'network');
    if (serverState.relay === false) throw new Core.ProviderError('本机无法直连，本地服务未运行，且歌词服务器未开启转发', 'network');
    netState.serverCount++;
    return cloud.relay(req, signal);
  }

  /* ---------------------------------------------------- application ----- */
  class App {
    constructor(platform) {
      this.platform = platform;
      this.registry = platform.getRegistry();
      this.playerAPI = this.registry.resolve(Symbol.for('PlayerAPI'));
      this.store = new Store();
      serverConfig = () => ({ url: cleanServerUrl(this.store.setting('server_url') || DEFAULT_SERVER), token: this.store.setting('server_token') || '' });
      currentMode = () => { const m = this.store.get('mode', ''); return MODES.includes(m) ? m : BAKED_MODE; };
      this.state = this.playerAPI.getState();
      this.open = false; this.ignoreNav = 0;
      this.pendingTrack = undefined;
      this.colorCache = new Map();
      relayAllowed = () => this.store.setting('relay') !== false;
      this.engine = new Core.Engine({
        store: this.store, http: new Core.Http(providerTransport), cloud: pureLocal() ? null : cloud,
        settings: () => this.store.settings(),
        spotify: (track, signal) => this.spotifyLyrics(track, signal),
        onChange: () => this.onEngine(),
      });
    }
    async start() {
      await this.store.open();
      /* A mode picked in the settings lasts until Spotify is patched with another mode. */
      if (this.store.get('patch_mode', '') !== BAKED_MODE) { this.store.set('mode', undefined); this.store.set('patch_mode', BAKED_MODE); }
      this.engine.cloud = pureLocal() ? null : cloud;
      this.view = new LyricsView(this);
      this.entry = new EntryButton(this);
      this.mini = new MiniLyrics(this);
      this.playerAPI.getEvents().addListener('update', (event) => this.onState(event.data));
      this.platform.getHistory().listen(() => { if (this.open && Date.now() > this.ignoreNav) this.close(); });
      document.addEventListener('click', (event) => {
        if (this.open && event.target.closest && event.target.closest('[data-testid="lyrics-button"]')) this.close();
      }, true);
      this.onState(this.playerAPI.getState());
      checkBackend().then(() => this.onEngine());
      log(`v${VERSION} ready (${currentMode()})`);
    }
    /* Cloud <-> pure local from the settings panel; the current track is matched again. */
    setMode(mode) {
      this.store.set('mode', mode === BAKED_MODE ? undefined : mode);
      this.engine.cloud = pureLocal() ? null : cloud;
      netState.direct = null; netState.checked = 0;
      checkBackend().then(() => this.onEngine());
      const track = this.engine.track;
      if (track) { this.engine.track = null; this.engine.setTrack(track); }
    }
    token() {
      try { const t = this.registry.resolve(Symbol.for('Transport')).getLastToken(); if (t) return t; } catch (_) { /* fallthrough */ }
      try { return this.platform.getSession().accessToken; } catch (_) { return null; }
    }
    /* Playback ----------------------------------------------------- */
    track(state = this.state) {
      const item = state && state.item;
      if (!item || (item.type && item.type !== 'track' && item.type !== 'local')) return null;
      const meta = item.metadata || {};
      const images = (item.album && item.album.images) || item.images || [];
      const pick = label => (images.find(i => i.label === label) || {}).url;
      return {
        uri: item.uri || '', title: item.name || meta.title || '',
        artists: (item.artists || []).map(a => a.name).filter(Boolean),
        album: (item.album && item.album.name) || meta.album_title || '',
        duration_ms: (item.duration && item.duration.milliseconds) || state.duration || 0,
        image: pick('small') || pick('standard') || (images[0] || {}).url || '',
        imageLarge: pick('xlarge') || pick('large') || pick('standard') || '',
        has_lyrics: meta.has_lyrics === 'true' ? true : meta.has_lyrics === 'false' ? false : undefined,
      };
    }
    position() {
      const s = this.state;
      if (!s || !s.item) return 0;
      let p = s.positionAsOfTimestamp || 0;
      if (!s.isPaused && !s.isBuffering) p += (Date.now() - s.timestamp) * (s.speed || 1);
      return clamp(p, 0, s.duration || Infinity);
    }
    playing() { return !!(this.state && this.state.item && !this.state.isPaused); }
    canSeek() { return !(this.state && this.state.restrictions && this.state.restrictions.canSeek === false); }
    seek(ms) {
      this.playerAPI.seekTo(Math.max(0, Math.round(ms)));
      if (this.state && this.state.isPaused) this.playerAPI.resume({ featureIdentifier: 'lyrics' });
    }
    onState(state) {
      if (!state) return;
      this.state = state;
      const track = this.track(state);
      const engineTrack = track && { uri: track.uri, title: track.title, artists: track.artists, album: track.album, duration_ms: track.duration_ms };
      if (!Core.trackEqual(this.currentTrack, engineTrack)) {
        this.currentTrack = engineTrack; this.trackInfo = track;
        if (this.open || this.store.setting('prefetch') || this.store.setting('mini_player')) this.engine.setTrack(engineTrack);
        else this.pendingTrack = engineTrack;
        if (this.open) this.view.trackChanged();
        if (this.mini) this.mini.trackChanged();
      }
      if (this.open) this.view.reschedule();
    }
    onEngine() { if (this.open) this.view.engineChanged(); this.entry && this.entry.refresh(); this.mini && this.mini.render(); }
    /* Spotify lyrics (fallback source) -------------------------------- */
    async spotifyLyrics(track, signal) {
      const info = this.trackInfo && this.trackInfo.uri === track.uri ? this.trackInfo : null;
      if (info && info.has_lyrics === false) return undefined;
      const id = Core.spotifyId(track.uri);
      const token = this.token();
      if (!id || !token) return undefined;
      const image = info && info.imageLarge ? info.imageLarge.replace('spotify:image:', 'https://i.scdn.co/image/') : '';
      const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${id}${image ? '/image/' + encodeURIComponent(image) : ''}?format=json&vocalRemoval=false&market=from_token`;
      const response = await fetch(url, { headers: { authorization: 'Bearer ' + token, 'app-platform': 'WebPlayer', 'spotify-app-version': this.platform.version || '' }, signal });
      if (response.status === 404 || response.status === 403 || response.status === 204) return null;
      if (!response.ok) throw new Core.ProviderError(`Spotify：HTTP ${response.status}`, 'http');
      const json = await response.json();
      const argb = n => { n = Number(n) >>> 0; return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`; };
      const colors = json.colors ? { background: argb(json.colors.background), inactive: argb(json.colors.text), active: argb(json.colors.highlightText) } : null;
      return { lyrics: Core.spotifyLyrics(json), colors };
    }
    /* Page ------------------------------------------------------------ */
    toggle() { this.open ? this.close() : this.show(); }
    /* Spotify's own lyrics view is exclusive with ours: close it before opening. */
    closeOfficial() {
      const button = document.querySelector('[data-testid="lyrics-button"]');
      let path = '';
      try { path = this.platform.getHistory().location.pathname || ''; } catch (_) { /* ignore */ }
      const active = button && (button.getAttribute('data-active') === 'true' || button.getAttribute('aria-pressed') === 'true' || /(^|\s)[^\s]*active/i.test(button.className || ''));
      if (button && (active || /^\/lyrics/.test(path))) {
        this.ignoreNav = Date.now() + 1000;
        button.click();
      }
    }
    show() {
      if (this.open) return;
      this.closeOfficial();
      this.open = true;
      this.mini.refresh();
      if (this.pendingTrack !== undefined) { this.engine.setTrack(this.pendingTrack); this.pendingTrack = undefined; }
      this.view.mount();
      this.entry.refresh();
      /* Spotify's own lyrics view polls playback every 500 ms; update events can lag
       * behind resume/seek, so poll cheaply while the page is visible. */
      this.poll = setInterval(() => {
        const s = this.playerAPI.getState();
        const old = this.state;
        if (s && (!old || s.timestamp !== old.timestamp || s.isPaused !== old.isPaused || (s.item && s.item.uri) !== (old.item && old.item.uri))) this.onState(s);
      }, 1000);
      const backend = pureLocal() ? localState : serverState;
      if (Date.now() - backend.checked > 30000 || !backend.ok) checkBackend().then(() => this.open && this.view.engineChanged());
    }
    close() {
      if (!this.open) return;
      this.open = false;
      clearInterval(this.poll);
      this.view.unmount();
      this.entry.refresh();
      this.mini.refresh();
    }
    /* Theme shared by the lyrics page and the sidebar mini view: background mode + colours. */
    async theme() {
      const engine = this.engine, info = this.trackInfo;
      let mode = this.store.setting('color_mode');
      if (!BACKGROUNDS[mode] && mode !== 'cover') mode = 'cover';
      const cover = info && (info.imageLarge || info.image) ? (info.imageLarge || info.image).replace('spotify:image:', 'https://i.scdn.co/image/') : '';
      const image = cover ? `url("${cover.replace(/["\\]/g, '')}")` : 'none';
      let colors = BACKGROUNDS[mode];
      if (mode === 'cover') {
        /* Spotify's lyric colours (when available) are softened the same way. */
        let hsl = engine.colors && cssToHsl(engine.colors.background);
        if (!hsl && info) {
          hsl = await this.coverColor(info.image || info.imageLarge);
          if (this.trackInfo !== info || this.store.setting('color_mode') !== mode) return null;
        }
        colors = hsl ? softPalette(hsl) : BACKGROUNDS.neutral;
      }
      return { mode, image, colors };
    }
    /* Album colour, Spotify style ------------------------------------- */
    async coverColor(imageUri) {
      if (!imageUri) return null;
      if (this.colorCache.has(imageUri)) return this.colorCache.get(imageUri);
      const url = imageUri.replace('spotify:image:', 'https://i.scdn.co/image/');
      const color = await new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous'; img.decoding = 'async';
        img.onload = () => {
          try {
            const size = 40, canvas = document.createElement('canvas');
            canvas.width = canvas.height = size;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, size, size);
            resolve(dominantColor(ctx.getImageData(0, 0, size, size).data));
          } catch (_) { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = url;
      });
      if (this.colorCache.size > 200) this.colorCache.delete(this.colorCache.keys().next().value);
      this.colorCache.set(imageUri, color);
      return color;
    }
  }

  /* Picks the representative colour of a cover as [hue, saturation, lightness]. */
  function dominantColor(data) {
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max ? (max - min) / max : 0, light = (max + min) / 510;
      const weight = 1 + sat * 3 - Math.abs(light - 0.5) * 1.2;
      if (weight <= 0) continue;
      const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
      const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, w: 0 };
      bucket.r += r * weight; bucket.g += g * weight; bucket.b += b * weight; bucket.w += weight;
      buckets.set(key, bucket);
    }
    let best = null;
    for (const bucket of buckets.values()) if (!best || bucket.w > best.w) best = bucket;
    if (!best) return null;
    return rgbToHsl(best.r / best.w, best.g / best.w, best.b / best.w);
  }
  /* A muted, darker version of a colour: a calm backdrop for long reading. Lines use
   * light tints of the same hue instead of black / white on a saturated field. */
  function softPalette([hue, s, l]) {
    const sat = s < 0.08 ? s : clamp(s * 0.5, 0.12, 0.34);
    const light = clamp(l * 0.75, 0.17, 0.27);
    return {
      background: hslToCss(hue, sat, light),
      inactive: `hsl(${hue.toFixed(1)} ${(Math.min(sat, 0.3) * 100).toFixed(1)}% 86% / .5)`,
      active: 'rgb(255,255,255)',
    };
  }
  function cssToHsl(css) {
    const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css || '');
    return m ? rgbToHsl(+m[1], +m[2], +m[3]) : null;
  }
  const BACKGROUNDS = {
    dark: { background: '#121212', inactive: 'rgba(255,255,255,.45)', active: '#fff' },
    blur: { background: 'rgb(24,24,24)', inactive: 'rgba(255,255,255,.5)', active: '#fff' },
    neutral: { background: 'hsl(0 0% 22%)', inactive: 'rgba(255,255,255,.5)', active: '#fff' },
  };
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [hue * 60, s, l];
  }
  const hslToCss = (hue, s, l) => `hsl(${hue.toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`;
  const fmtTime = ms => { ms = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(ms / 60)}:${String(ms % 60).padStart(2, '0')}`; };
  const fmtBytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  const fmtOffset = ms => `${ms > 0 ? '+' : ms < 0 ? '−' : '±'}${(Math.abs(ms) / 1000).toFixed(1)}s`;

  /* ------------------------------------------------------- entry ------ */
  class EntryButton {
    constructor(app) {
      this.app = app;
      this.uploading = false;
      const hover = (button, text) => ({
        onmouseenter: () => this.tooltip(button(), text()), onmouseleave: () => this.tooltip(null),
        onfocus: () => this.tooltip(button(), text()), onblur: () => this.tooltip(null),
      });
      this.button = h('button', {
        type: 'button', 'data-testid': 'spot-lyric-button', 'aria-label': '第三方歌词', 'aria-pressed': 'false',
        class: 'sl-entry', onclick: () => app.toggle(), ...hover(() => this.button, () => '第三方歌词'),
      }, h('span', { class: 'sl-entry-icon', 'aria-hidden': 'true' }, svg(ICON.lyrics)));
      /* Small companion button: uploads the lyrics on screen to the lyrics server. */
      this.uploadIcon = h('span', { class: 'sl-upload-icon', 'aria-hidden': 'true' }, svg(ICON.upload, 14));
      this.uploadButton = h('button', {
        type: 'button', 'data-testid': 'spot-lyric-upload', 'aria-label': '上传当前歌词到服务器', class: 'sl-upload',
        onclick: () => this.upload(), ...hover(() => this.uploadButton, () => this.uploadHint()),
      }, this.uploadIcon);
      this.tip = h('div', { class: 'sl-tooltip', role: 'tooltip' });
      this.attach();
      /* React re-renders the now-playing bar; re-attach whenever we are dropped.
       * Checks are coalesced so heavy DOM churn costs at most one query per 250 ms. */
      this.pending = 0;
      this.observer = new MutationObserver(() => {
        if (this.pending) return;
        this.pending = setTimeout(() => { this.pending = 0; if (!this.button.isConnected || !this.inPlace()) this.attach(); }, 250);
      });
      this.observer.observe(document.body, { childList: true, subtree: true });
    }
    inPlace() {
      const official = document.querySelector('[data-testid="lyrics-button"]');
      return (!official || this.button.nextElementSibling === official) && this.uploadButton.nextElementSibling === this.button;
    }
    attach() {
      /* Insert as a direct sibling of the official lyrics button so it shares the
       * control group's spacing, and borrow its classes for identical styling. */
      const official = document.querySelector('[data-testid="lyrics-button"]');
      if (official) {
        this.button.className = 'sl-entry ' + Array.from(official.classList).filter(c => !/active|disabled/i.test(c)).join(' ');
        official.before(this.button);
      } else {
        const anchor = document.querySelector('[data-testid="control-button-queue"]') || document.querySelector('[data-testid="control-button-npv"]');
        if (!anchor) return;
        anchor.before(this.button);
      }
      this.button.before(this.uploadButton);
      this.refresh();
    }
    refresh() {
      const active = this.app.open;
      this.button.dataset.active = String(active);
      this.button.setAttribute('aria-pressed', String(active));
      const lyrics = this.app.engine.lyrics;
      this.button.dataset.has = String(Core.lyricsUsable(lyrics));
      /* Pure local mode has no server to upload to. */
      this.uploadButton.hidden = pureLocal();
      const blocked = !!this.uploadBlocked(), saved = !blocked && this.app.engine.origin === 'cloud';
      this.uploadButton.dataset.state = this.uploading ? 'busy' : blocked ? 'off' : saved ? 'saved' : 'ready';
      this.uploadButton.setAttribute('aria-disabled', String(blocked));
      if (this.uploadIconState !== saved) { this.uploadIconState = saved; this.uploadIcon.replaceChildren(svg(saved ? ICON.uploaded : ICON.upload, 14)); }
      if (this.tipOwner === this.uploadButton) this.tooltip(this.uploadButton, this.uploadHint());
    }
    uploadBlocked() {
      const engine = this.app.engine, lyrics = engine.lyrics, track = engine.track;
      if (pureLocal()) return '纯本地模式不连接歌词服务器';
      if (!track) return '没有正在播放的歌曲';
      if (!Core.lyricsUsable(lyrics)) return engine.busy ? '正在匹配歌词…' : '当前歌曲没有可上传的歌词';
      if (lyrics.source === 'spotify') return 'Spotify 官方歌词不上传到服务器';
      if (!Core.spotifyId(track.uri)) return '本地文件无法上传到服务器';
      return '';
    }
    uploadHint() {
      if (this.uploading) return '正在上传…';
      const blocked = this.uploadBlocked();
      if (blocked) return blocked;
      const engine = this.app.engine, source = NAMES[engine.lyrics.source] || engine.lyrics.source;
      return engine.origin === 'cloud' ? `当前歌词已保存在服务器（${source}），点击重新上传` : `上传当前歌词到服务器（${source}）`;
    }
    async upload() {
      if (this.uploading) return;
      const blocked = this.uploadBlocked();
      if (blocked) { toast(blocked); return; }
      this.uploading = true; this.refresh();
      try { await this.app.engine.upload(); toast('已上传当前歌词到歌词服务器'); }
      catch (e) { toast('上传失败：' + (e.message || e)); }
      finally { this.uploading = false; this.refresh(); }
    }
    tooltip(owner, text) {
      this.tipOwner = owner;
      if (!owner) { this.tip.remove(); return; }
      this.tip.textContent = text;
      document.body.append(this.tip);
      const r = owner.getBoundingClientRect(), t = this.tip.getBoundingClientRect();
      this.tip.style.left = `${Math.round(clamp(r.left + r.width / 2 - t.width / 2, 8, innerWidth - t.width - 8))}px`;
      this.tip.style.top = `${Math.round(r.top - t.height - 8)}px`;
    }
  }

  /* Opening brackets (「 『 （ …) leave half an em blank at a line start, which makes those lines look
   * indented. Lines that begin with one get `sl-hang` (see app.css) so every line aligns left. */
  const HANG_RE = /^\s*[「『【〈《〔〖（［｛]/;
  const hangClass = text => HANG_RE.test(text || '') ? ' sl-hang' : '';
  function applyTheme(el, theme) {
    el.dataset.bg = theme.mode;
    if (theme.mode === 'blur') el.style.setProperty('--sl-cover', theme.image);
    el.style.setProperty('--lyrics-color-background', theme.colors.background);
    el.style.setProperty('--lyrics-color-inactive', theme.colors.inactive);
    el.style.setProperty('--lyrics-color-active', theme.colors.active);
  }

  function scrollParent(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.clientHeight) return p;
    }
    return null;
  }

  /* ------------------------------------------ right sidebar mini lyrics - */
  /* A scaled-down lyrics view inside Spotify's "Now playing" sidebar, right below the cover,
   * title and artist, filling the rest of the visible sidebar (the cards below - related
   * videos, artist, credits, queue - follow it). Colours, background, translation and
   * font scale follow the main page. */
  class MiniLyrics {
    constructor(app) {
      this.app = app;
      this.lyricsRef = null; this.lines = []; this.els = []; this.active = -2; this.shown = null; this.timer = 0; this.pending = 0;
      this.closeBtn = h('button', {
        type: 'button', class: 'sl-mini-close', 'aria-label': '关闭迷你歌词', title: '关闭迷你歌词（可在歌词设置中重新开启）',
        onclick: () => { app.store.set('mini_player', false); this.refresh(); if (app.view.panel) app.view.panel.renderBody(); },
      }, svg(ICON.close, 12));
      this.linesBox = h('div', { class: 'sl-mini-lines' });
      this.scroller = h('div', { class: 'sl-mini-scroll' }, this.linesBox);
      this.empty = h('div', { class: 'sl-mini-empty' });
      this.el = h('section', { class: 'sl-mini', 'aria-label': '迷你歌词', 'data-testid': 'spot-lyric-mini' },
        h('div', { class: 'sl-bg' }), this.scroller, this.empty, this.closeBtn);
      this.linesBox.addEventListener('click', (event) => {
        const line = event.target.closest('.sl-line');
        const data = line && this.lines[+line.dataset.i];
        if (data && this.seekable) app.seek(data.start_time_ms - app.engine.offset());
      });
      /* React rebuilds the sidebar freely; re-attach whenever we are dropped (coalesced). */
      this.observer = new MutationObserver(() => {
        if (this.pending || !this.enabled()) return;
        this.pending = setTimeout(() => { this.pending = 0; if (this.enabled() && !this.inPlace()) this.attach(); }, 250);
      });
      this.observer.observe(document.body, { childList: true, subtree: true });
      /* Height follows the sidebar: window resizes and the cover growing / shrinking. */
      this.sizer = new ResizeObserver(() => this.resize());
      this.refresh();
    }
    /* Not shown while the full lyrics page is open: it would only repeat it. */
    enabled() { return this.app.store.setting('mini_player') !== false && !this.app.open; }
    /* Spotify's class names are hashed: the block holding the cover, title and artist is the
     * panel child that contains the track title. The mini view goes right after it, as a
     * sibling of the cards (same width, same 16px gap). */
    anchor() {
      const panel = document.querySelector('[data-testid="NPV_Panel_OpenDiv"]');
      if (!panel) return null;
      let header = panel.querySelector('[data-testid="context-item-info-title"]');
      while (header && header.parentElement !== panel) header = header.parentElement;
      if (!header) header = Array.from(panel.children).find(c => c !== this.el) || null;
      return header;
    }
    inPlace() { const a = this.anchor(); return !!a && this.el.isConnected && this.el.previousElementSibling === a; }
    attach() {
      const anchor = this.anchor();
      if (!anchor) { this.el.remove(); this.sizer.disconnect(); return; }
      anchor.after(this.el);
      this.sizer.disconnect();
      this.scrollParent = scrollParent(this.el);
      if (this.scrollParent) this.sizer.observe(this.scrollParent);
      this.sizer.observe(anchor);
      this.resize();
      this.update(true);
    }
    /* From below the title down to the bottom of the visible sidebar (when scrolled to the top). */
    resize() {
      const port = this.scrollParent;
      if (!port || !this.el.isConnected) return;
      const top = this.el.getBoundingClientRect().top - port.getBoundingClientRect().top + port.scrollTop;
      const height = Math.round(Math.max(220, port.clientHeight - top - 16));
      if (Math.abs(height - (this.height || 0)) < 2) return;
      this.height = height;
      this.el.style.setProperty('--sl-mini-h', `${height}px`);
      this.active = -2;
      this.update(true);
    }
    refresh() {
      if (!this.enabled()) { this.el.remove(); this.sizer.disconnect(); clearInterval(this.timer); this.timer = 0; return; }
      const app = this.app;
      if (app.pendingTrack !== undefined) { app.engine.setTrack(app.pendingTrack); app.pendingTrack = undefined; }
      if (!this.timer) this.timer = setInterval(() => { if (document.visibilityState === 'visible' && this.el.isConnected) this.update(false); }, 300);
      this.attach();
      this.lyricsRef = null;
      this.render();
    }
    trackChanged() { this.lyricsRef = null; this.render(); }
    render() {
      if (!this.enabled()) return;
      const app = this.app, engine = app.engine, lyrics = engine.lyrics;
      app.theme().then(theme => { if (theme) applyTheme(this.el, theme); });
      this.el.style.setProperty('--sl-scale', String(app.store.setting('font_scale') || 1));
      const usable = Core.lyricsUsable(lyrics) && !!app.currentTrack;
      this.empty.hidden = usable;
      this.scroller.hidden = !usable;
      if (!usable) {
        this.lyricsRef = null; this.lines = []; this.els = [];
        this.empty.textContent = !app.currentTrack ? '没有正在播放的歌曲' : engine.busy ? '正在加载歌词…' : engine.status === '纯音乐，没有歌词' ? '纯音乐，没有歌词' : '暂无歌词';
        return;
      }
      const showTranslation = !!app.store.setting('translation');
      if (this.lyricsRef === lyrics && this.shown === showTranslation) { this.update(false); return; }
      this.lyricsRef = lyrics; this.shown = showTranslation;
      this.lines = lyrics.lines;
      this.synced = lyrics.sync_type !== 'unsynced';
      this.seekable = this.synced && app.canSeek();
      this.linesBox.classList.toggle('sl-seekable', this.seekable);
      this.linesBox.classList.toggle('sl-static', !this.synced);
      this.els = this.lines.map((line, i) => h('div', { class: 'sl-line' + (line.text ? '' : ' sl-empty'), 'data-i': i, dir: 'auto' },
        h('div', { class: 'sl-text' + hangClass(line.text) }, line.text),
        showTranslation && line.text && line.translated_text ? h('div', { class: 'sl-trans' + hangClass(line.translated_text) }, line.translated_text) : null));
      this.linesBox.replaceChildren(...this.els);
      this.active = -2;
      this.scroller.scrollTop = 0;
      this.update(true);
    }
    update(initial) {
      if (!this.synced || !this.els.length || !this.el.isConnected || this.scroller.hidden) return;
      const index = Core.lyricsIndex(this.app.engine.lyrics, this.app.position() + this.app.engine.offset());
      if (index === this.active && !initial) return;
      this.active = index;
      this.els.forEach((el, i) => {
        el.classList.toggle('sl-past', i < index); el.classList.toggle('sl-active', i === index); el.classList.toggle('sl-future', i > index);
      });
      const el = this.els[Math.max(index, 0)], port = this.scroller.clientHeight;
      if (!el || !port) return;
      this.scroller.scrollTo({ top: el.offsetTop - (port - el.offsetHeight) / 2, behavior: initial ? 'auto' : 'smooth' });
    }
  }

  /* ------------------------------------------------------ lyrics view - */
  class LyricsView {
    constructor(app) {
      this.app = app;
      this.lines = []; this.els = []; this.active = -2; this.wordLine = -1; this.timer = 0; this.frame = 0;
      this.userScrolling = false; this.scrollEndTimer = 0; this.lyricsRef = null; this.panel = null;
      this.build();
    }
    build() {
      const app = this.app;
      this.linesBox = h('div', { class: 'sl-lines' });
      this.note = h('p', { class: 'sl-note', dir: 'auto' }, '这些歌词尚未与歌曲同步。');
      this.footer = h('div', { class: 'sl-provider' });
      this.translateBtn = h('button', { type: 'button', class: 'sl-pill sl-translate', onclick: () => { app.store.set('translation', !app.store.setting('translation')); this.render(true); } },
        h('span', { class: 'sl-pill-icon' }, svg(ICON.translate)), h('span', { class: 'sl-pill-text' }, '显示译文'));
      this.offsetLabel = h('span', { class: 'sl-pill-text sl-offset-text', title: '点击重置本曲偏移', onclick: () => app.engine.setOffset(0, false) });
      this.offsetPill = h('div', { class: 'sl-pill sl-offset' },
        h('button', { type: 'button', class: 'sl-pill-icon', title: '歌词延后 0.1 秒', onclick: () => this.nudge(-100) }, svg(ICON.minus)),
        this.offsetLabel,
        h('button', { type: 'button', class: 'sl-pill-icon', title: '歌词提前 0.1 秒', onclick: () => this.nudge(100) }, svg(ICON.plus)));
      this.sourceText = h('span', { class: 'sl-pill-text' });
      this.sourcePill = h('button', { type: 'button', class: 'sl-pill sl-source', title: '手动匹配歌词', onclick: () => this.openPanel('match') },
        h('span', { class: 'sl-pill-icon' }, svg(ICON.search)), this.sourceText);
      this.settingsBtn = h('button', { type: 'button', class: 'sl-round', title: '歌词设置', onclick: () => this.openPanel('settings') }, svg(ICON.gear));
      this.controls = h('div', { class: 'sl-controls' },
        h('div', { class: 'sl-controls-left' }, this.translateBtn),
        h('div', { class: 'sl-controls-right' }, this.offsetPill, this.sourcePill, this.settingsBtn));
      this.wrap = h('div', { class: 'sl-wrap' }, this.note, this.linesBox, this.footer);
      this.stateBox = h('div', { class: 'sl-state' });
      this.scroller = h('div', { class: 'sl-scroll' }, this.wrap, this.controls);
      this.syncBtn = h('button', { type: 'button', class: 'sl-sync', onclick: () => this.follow(true) }, svg(ICON.sync), h('span', null, '同步'));
      this.bg = h('div', { class: 'sl-bg' });
      this.page = h('div', { class: 'sl-page', 'data-testid': 'spot-lyric-page', tabindex: '-1' },
        this.bg, this.scroller, this.stateBox, this.syncBtn);

      const userScroll = () => {
        this.userScrolling = true;
        clearTimeout(this.scrollEndTimer);
        this.scrollEndTimer = setTimeout(() => { this.userScrolling = false; }, 400);
      };
      this.scroller.addEventListener('wheel', userScroll, { passive: true });
      this.scroller.addEventListener('touchmove', userScroll, { passive: true });
      this.scroller.addEventListener('pointerdown', (e) => { if (e.target === this.scroller) userScroll(); });
      this.scroller.addEventListener('keydown', userScroll);
      this.scroller.addEventListener('scrollend', () => { this.userScrolling = false; });
      this.linesBox.addEventListener('click', (event) => {
        const line = event.target.closest('.sl-line');
        if (!line || !this.seekable) return;
        const data = this.lines[+line.dataset.i];
        if (!data) return;
        line.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.app.seek(data.start_time_ms - this.app.engine.offset());
      });
      /* The "Sync" button appears once the active line has been off-screen for a
       * moment (debounced so smooth auto-scrolls never flash it). */
      this.visibility = new IntersectionObserver((entries) => {
        for (const entry of entries) this.offscreen = !entry.isIntersecting;
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => this.syncBtn.classList.toggle('sl-visible', !!this.offscreen && this.active >= 0), this.offscreen ? 450 : 0);
      }, { root: this.scroller, threshold: 0 });
      document.addEventListener('visibilitychange', () => this.reschedule());
      this.keyHandler = (event) => {
        if (event.key === 'Escape' && this.panel) { this.closePanel(); event.stopPropagation(); }
      };
    }
    mount() {
      const host = document.getElementById('main-view') || document.querySelector('.Root__main-view');
      if (!host) { this.app.open = false; return; }
      host.classList.add('sl-host');
      host.append(this.page);
      document.addEventListener('keydown', this.keyHandler, true);
      /* Detaching the page resets its scroll position: always land on the current line. */
      this.needsScroll = true;
      this.trackChanged();
    }
    unmount() {
      this.stop();
      this.closePanel();
      document.removeEventListener('keydown', this.keyHandler, true);
      const host = this.page.parentElement;
      if (host) host.classList.remove('sl-host');
      this.page.remove();
    }
    trackChanged() {
      this.applyColors();
      this.render(true);
      if (this.panel) this.panel.trackChanged();
    }
    engineChanged() {
      this.render(false);
      if (this.panel) this.panel.engineChanged();
    }
    nudge(delta) { this.app.engine.setOffset(this.app.engine.offset() - this.app.store.getInt('timing-offset-ms', 0) + delta, false); }
    /* Background modes: cover (soft cover colour), blur (blurred cover art), dark. */
    async applyColors() {
      const theme = await this.app.theme();
      if (theme) applyTheme(this.page, theme);
    }
    /* (Re)builds lines when the lyrics object changes; otherwise refreshes chrome. */
    render(force) {
      const app = this.app, engine = app.engine, lyrics = engine.lyrics;
      const usable = Core.lyricsUsable(lyrics);
      const showTranslation = !!app.store.setting('translation');
      const hasTranslation = usable && lyrics.lines.some(l => l.translated_text);
      this.page.style.setProperty('--sl-scale', String(app.store.setting('font_scale') || 1));
      /* chrome */
      this.translateBtn.hidden = !hasTranslation;
      this.translateBtn.classList.toggle('sl-on', showTranslation);
      this.translateBtn.querySelector('.sl-pill-text').textContent = showTranslation ? '隐藏译文' : '显示译文';
      const offset = app.engine.offset();
      this.offsetLabel.textContent = `偏移 ${fmtOffset(offset)}`;
      this.offsetPill.hidden = !usable || lyrics.sync_type === 'unsynced';
      this.sourceText.textContent = usable ? `${NAMES[lyrics.source] || lyrics.provider_name || lyrics.source}` : '手动匹配';
      this.applyColors();
      /* state overlay */
      const track = app.currentTrack;
      let state = null;
      if (!track) state = { title: app.state && app.state.item ? '当前内容没有歌词' : '没有正在播放的歌曲', sub: '' };
      else if (!usable && engine.busy) state = { loading: true };
      else if (!usable) {
        const failed = /^(请求失败|来源暂不可用)/.test(engine.status);
        /* Without direct access the provider requests depend on the relay (local service or lyrics server). */
        /* Every path failed: direct, the local service and (cloud mode) the lyrics server relay. */
        const serverDown = pureLocal() || serverState.ok === false || serverState.relay === false || !app.store.setting('relay');
        const blocked = failed && netState.direct === false && localState.ok === false && serverDown;
        const hint = BAKED_REQUEST === 'direct'
          ? 'Spotify 没有以直连参数（--disable-web-security）启动，本地服务也未运行，无法请求网易云音乐 / QQ 音乐。请从开始菜单 / 应用菜单中的 Spotify 启动，或重新运行 patch。'
          : BAKED_REQUEST === 'service'
            ? `本机无法直连网易云音乐 / QQ 音乐，本地服务（${LOCAL_URL}）也未运行。请重新运行 patch 并选择本地服务。`
            : `本机无法直连网易云音乐 / QQ 音乐，没有本地服务，歌词服务器 ${serverConfig().url} 的转发也不可用。可在「设置 > 使用方式与网络」中检查，或重新运行 patch 选择本地请求方式。`;
        state = {
          title: failed ? '无法加载这首歌曲的歌词。稍后再试。' : engine.status === '纯音乐，没有歌词' ? '这是一首纯音乐。' : '我们好像没有这首歌的歌词。',
          sub: blocked ? hint : engine.status,
          actions: true,
        };
      }
      this.renderState(state);
      this.scroller.hidden = !usable;
      if (!usable) { this.lyricsRef = null; this.stop(); return; }
      if (!force && !this.needsScroll && this.lyricsRef === lyrics && this.showTranslation === showTranslation && this.wordSync === app.store.setting('word_sync')) { this.reschedule(); return; }
      /* rebuild lines */
      const scrollToActive = this.lyricsRef !== lyrics || this.needsScroll;
      /* Same lyrics, new layout (translation shown / hidden, font size, word sync): the line
       * being followed stays exactly where it is on screen instead of drifting. */
      const anchor = scrollToActive ? null : this.anchor();
      this.needsScroll = false;
      this.lyricsRef = lyrics; this.showTranslation = showTranslation; this.wordSync = !!app.store.setting('word_sync');
      this.lines = lyrics.lines;
      this.synced = lyrics.sync_type !== 'unsynced';
      this.seekable = this.synced && app.canSeek();
      this.words = this.synced && lyrics.sync_type === 'word' && this.wordSync;
      this.note.hidden = this.synced;
      this.linesBox.classList.toggle('sl-seekable', this.seekable);
      this.linesBox.classList.toggle('sl-static', !this.synced);
      const fragment = document.createDocumentFragment();
      this.els = this.lines.map((line, i) => {
        const el = h('div', { class: 'sl-line' + (line.text ? '' : ' sl-empty'), 'data-i': i, dir: 'auto' },
          h('div', { class: 'sl-text' + hangClass(line.text) }, line.text),
          showTranslation && line.text && line.translated_text ? h('div', { class: 'sl-trans' + hangClass(line.translated_text) }, line.translated_text) : null);
        fragment.append(el);
        return el;
      });
      this.linesBox.replaceChildren(fragment);
      const source = NAMES[lyrics.source] || lyrics.source;
      const provider = lyrics.source === 'spotify' ? (lyrics.provider_name || lyrics.provider || 'Spotify') : source;
      this.footer.textContent = `歌词提供者：${provider}`;
      this.active = -2; this.wordLine = -1;
      this.visibility.disconnect();
      this.update(true);
      if (scrollToActive) {
        if (this.active >= 0) this.els[this.active].scrollIntoView({ block: 'center', behavior: 'auto' });
        else this.scroller.scrollTop = 0;
      } else if (anchor) this.restoreAnchor(anchor);
      this.reschedule();
    }
    /* The current line if it is on screen, otherwise the first visible line, with its offset. */
    anchor() {
      const port = this.scroller.getBoundingClientRect();
      if (!port.height || !this.els.length) return null;
      const visible = el => { const r = el.getBoundingClientRect(); return r.bottom > port.top && r.top < port.bottom; };
      let index = this.active >= 0 && this.els[this.active] && visible(this.els[this.active]) ? this.active : -1;
      if (index < 0) index = this.els.findIndex(el => el.getBoundingClientRect().bottom > port.top);
      if (index < 0) return null;
      const el = this.els[index], rect = el.getBoundingClientRect();
      /* The first line of text is the reference: a translation below it may appear or vanish. */
      const text = el.querySelector('.sl-text');
      return { index, top: (text ? text.getBoundingClientRect().top : rect.top) - port.top };
    }
    restoreAnchor(anchor) {
      const el = this.els[anchor.index];
      if (!el) return;
      const text = el.querySelector('.sl-text') || el;
      const delta = text.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) >= 1) this.scroller.scrollTop += delta;
    }
    renderState(state) {
      this.stateBox.hidden = !state;
      if (!state) return;
      if (state.loading) { this.stateBox.replaceChildren(h('div', { class: 'sl-loader', 'aria-label': '正在加载' }, h('i'), h('i'), h('i'))); return; }
      const children = [h('p', { class: 'sl-state-title' }, state.title)];
      if (state.sub) children.push(h('p', { class: 'sl-state-sub' }, state.sub));
      if (state.actions) children.push(h('div', { class: 'sl-state-actions' },
        h('button', { type: 'button', class: 'sl-btn sl-btn-light', onclick: () => this.openPanel('match') }, '手动匹配'),
        h('button', { type: 'button', class: 'sl-btn sl-btn-ghost', onclick: () => this.app.engine.setTrack(this.app.currentTrack, true) }, '重新匹配')));
      this.stateBox.replaceChildren(...children);
    }
    /* Playback sync -------------------------------------------------- */
    position() { return this.app.position() + this.app.engine.offset(); }
    update(initial) {
      if (!this.synced) {
        if (initial) this.els.forEach(el => el.classList.add('sl-static-line'));
        return;
      }
      const position = this.position();
      const index = Core.lyricsIndex(this.app.engine.lyrics, position);
      if (index !== this.active) {
        const previous = this.active;
        if (initial || previous < -1) {
          this.els.forEach((el, i) => { el.classList.toggle('sl-past', i < index); el.classList.toggle('sl-active', i === index); el.classList.toggle('sl-future', i > index); });
        } else {
          const lo = Math.max(0, Math.min(previous, index)), hi = Math.min(this.els.length - 1, Math.max(previous, index));
          for (let i = lo; i <= hi; i++) {
            const el = this.els[i];
            el.classList.toggle('sl-past', i < index); el.classList.toggle('sl-active', i === index); el.classList.toggle('sl-future', i > index);
          }
        }
        if (this.wordLine >= 0 && this.wordLine !== index) this.unwrapWords(this.wordLine);
        this.active = index;
        this.visibility.disconnect();
        if (index >= 0) this.visibility.observe(this.els[index]); else { this.offscreen = false; this.syncBtn.classList.remove('sl-visible'); }
        if (!initial) this.autoScroll(previous, index);
      }
      if (this.words && index >= 0) this.updateWords(index, position);
    }
    wrapWords(index) {
      const line = this.lines[index], el = this.els[index];
      if (!line.words || !line.words.length) return false;
      const text = el.querySelector('.sl-text');
      text.replaceChildren(...line.words.map(w => h('span', { class: 'sl-w' }, w.text)));
      this.wordEls = text.children; this.wordLine = index;
      /* The translation follows the same progress, spread over the whole line. */
      const trans = el.querySelector('.sl-trans');
      this.transEl = null;
      if (trans && line.translated_text) {
        const span = h('span', { class: 'sl-w' }, line.translated_text);
        trans.replaceChildren(span); this.transEl = span;
      }
      return true;
    }
    unwrapWords(index) {
      const el = this.els[index], line = this.lines[index];
      if (el && line) {
        el.querySelector('.sl-text').textContent = line.text;
        const trans = el.querySelector('.sl-trans');
        if (trans && line.translated_text) trans.textContent = line.translated_text;
      }
      this.wordLine = -1; this.wordEls = null; this.transEl = null;
    }
    updateWords(index, position) {
      if (this.wordLine !== index && !this.wrapWords(index)) return;
      const words = this.lines[index].words;
      for (let i = 0; i < words.length; i++) {
        const w = words[i], span = this.wordEls[i];
        const p = w.end_time_ms > w.start_time_ms ? clamp((position - w.start_time_ms) / (w.end_time_ms - w.start_time_ms), 0, 1) : position >= w.start_time_ms ? 1 : 0;
        const value = p >= 1 ? '1' : p <= 0 ? '0' : p.toFixed(3);
        /* 0..1 maps to 0..106% so the 6% soft edge never leaks before or lingers after a word. */
        if (span._p !== value) { span._p = value; span.style.setProperty('--p', `${(+value * 106).toFixed(1)}%`); }
      }
      if (this.transEl) {
        const first = words[0].start_time_ms, last = words[words.length - 1].end_time_ms;
        const p = last > first ? clamp((position - first) / (last - first), 0, 1) : position >= first ? 1 : 0;
        const value = p >= 1 ? '1' : p <= 0 ? '0' : p.toFixed(3);
        if (this.transEl._p !== value) { this.transEl._p = value; this.transEl.style.setProperty('--p', `${(+value * 106).toFixed(1)}%`); }
      }
    }
    /* Spotify's auto-scroll zone: follow only while the reader is "with" the song. */
    autoScroll(previous, index) {
      if (index < 0 || this.userScrolling) return;
      const el = this.els[index];
      const jump = previous < 0 || Math.abs(previous - index) > 4;
      const line = el.getBoundingClientRect(), port = this.scroller.getBoundingClientRect();
      const factor = 0.8 - 0.3 * clamp((port.height - 400) / 200, 0, 1);
      const zone = port.height * factor;
      const top = port.top + line.height + (port.height - zone) / 2;
      const bottom = Math.min(top + zone, port.top + port.height);
      const inZone = line.top >= top && line.top <= bottom;
      if (!inZone && !jump) return;
      const smooth = inZone && !jump && document.visibilityState === 'visible' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
    }
    follow(smooth) {
      if (this.active < 0) return;
      this.userScrolling = false;
      this.els[this.active].scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
    }
    /* Line-synced lyrics wake up exactly at the next line. Word sync ticks at
     * ~30 fps on a timer rather than rAF: high-refresh monitors (165/180 Hz)
     * would otherwise repaint the gradient-clipped line on every vsync. */
    reschedule() {
      this.stop();
      if (!this.app.open || !this.lines.length || !this.synced) return;
      this.update(false);
      if (!this.app.playing() || document.visibilityState !== 'visible') return;
      if (this.words) {
        const tick = () => { this.update(false); this.timer = setTimeout(tick, 33); };
        this.timer = setTimeout(tick, 33);
        return;
      }
      const next = this.lines[this.active + 1];
      const speed = (this.app.state && this.app.state.speed) || 1;
      const wait = next ? (next.start_time_ms - this.position()) / speed : 1000;
      this.timer = setTimeout(() => this.reschedule(), clamp(wait + 8, 16, 1000));
    }
    stop() {
      clearTimeout(this.timer); this.timer = 0;
      if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0;
    }
    /* Side panel ------------------------------------------------------ */
    openPanel(tab) {
      if (!this.panel) { this.panel = new Panel(this.app, this); this.page.append(this.panel.el); }
      this.panel.show(tab);
    }
    closePanel() {
      if (!this.panel) return;
      this.panel.el.remove(); this.panel = null;
      this.page.focus({ preventScroll: true });
    }
  }

  /* ---------------------------------------------------------- panel ---- */
  class Panel {
    constructor(app, view) {
      this.app = app; this.view = view; this.tab = 'match'; this.result = null; this.providerTab = app.store.setting('preferred_provider');
      this.selected = null; this.preview = null; this.searching = false; this.query = '';
      this.tabs = { match: h('button', { type: 'button', class: 'sl-tab', onclick: () => this.show('match') }, '匹配歌词'), settings: h('button', { type: 'button', class: 'sl-tab', onclick: () => this.show('settings') }, '设置') };
      this.body = h('div', { class: 'sl-panel-body' });
      this.el = h('aside', { class: 'sl-panel', 'aria-label': '歌词面板' },
        h('header', { class: 'sl-panel-head' }, h('div', { class: 'sl-tabs' }, this.tabs.match, this.tabs.settings),
          h('button', { type: 'button', class: 'sl-icon-btn', 'aria-label': '关闭', onclick: () => view.closePanel() }, svg(ICON.close))),
        this.body);
      this.trackChanged(true);
    }
    show(tab) { this.tab = tab; for (const [k, b] of Object.entries(this.tabs)) b.classList.toggle('sl-on', k === tab); this.renderBody(); }
    trackChanged(initial) {
      const track = this.app.currentTrack;
      this.query = track ? `${track.title} ${track.artists[0] || ''}`.trim() : '';
      this.result = null; this.selected = null; this.preview = null;
      if (!initial) this.renderBody();
      if (track && (this.tab === 'match' || initial)) this.search();
    }
    engineChanged() { if (this.tab === 'match') this.renderStatus(); else this.renderBody(); }
    renderBody() { this.body.replaceChildren(this.tab === 'match' ? this.matchTab() : this.settingsTab()); }
    /* match tab */
    matchTab() {
      const app = this.app, info = app.trackInfo;
      this.statusEl = h('div', { class: 'sl-status' });
      const cover = info && info.image ? h('img', { class: 'sl-cover', src: info.image.replace('spotify:image:', 'https://i.scdn.co/image/'), alt: '' }) : h('div', { class: 'sl-cover' });
      const now = h('div', { class: 'sl-now' }, cover, h('div', { class: 'sl-now-text' },
        h('div', { class: 'sl-now-title' }, info ? info.title : '没有正在播放的歌曲'),
        h('div', { class: 'sl-now-sub' }, info ? `${info.artists.join(', ')} · ${fmtTime(info.duration_ms)}` : ''), this.statusEl));
      this.input = h('input', {
        class: 'sl-input', type: 'search', placeholder: '歌名 歌手，或粘贴网易云 / QQ 音乐歌曲链接', value: this.query,
        oninput: (e) => { this.query = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') this.search(); },
      });
      const form = h('div', { class: 'sl-search' }, h('span', { class: 'sl-search-icon' }, svg(ICON.search)), this.input,
        h('button', { type: 'button', class: 'sl-btn sl-btn-green', onclick: () => this.search() }, '搜索'));
      this.listEl = h('div', { class: 'sl-results' });
      this.chipsEl = h('div', { class: 'sl-chips' });
      const actions = h('div', { class: 'sl-actions' },
        h('button', { type: 'button', class: 'sl-btn sl-btn-ghost', onclick: () => app.currentTrack && app.engine.setTrack(app.currentTrack, true) }, '重新自动匹配'),
        h('button', { type: 'button', class: 'sl-btn sl-btn-ghost', onclick: async () => {
          try { await app.engine.unbind(); toast('已解除绑定并重新匹配'); } catch (e) { toast('解除绑定失败：' + (e.message || e)); }
        } }, '解除绑定'),
        h('button', { type: 'button', class: 'sl-btn sl-btn-ghost', onclick: () => this.importFile() }, '导入 LRC'),
        h('button', { type: 'button', class: 'sl-btn sl-btn-ghost', onclick: () => this.exportLrc() }, '复制 LRC'));
      const box = h('div', { class: 'sl-match' }, now, form, this.chipsEl, this.listEl, actions);
      this.renderStatus(); this.renderResults();
      return box;
    }
    renderStatus() {
      if (!this.statusEl) return;
      const engine = this.app.engine, ok = Core.lyricsUsable(engine.lyrics);
      this.statusEl.className = 'sl-status ' + (engine.busy ? 'sl-busy' : ok ? 'sl-ok' : 'sl-miss');
      const note = netState.direct === false && localState.ok === false && pureLocal() ? ' · 本地服务未运行'
        : !pureLocal() && serverState.ok === false ? ' · 歌词服务器未连接' : '';
      this.statusEl.textContent = engine.status + note;
    }
    async search() {
      const query = (this.query || '').trim();
      if (!query || !this.app.currentTrack) return;
      this.searching = true; this.selected = null; this.preview = null;
      this.renderResults();
      const track = this.app.currentTrack;
      const result = await this.app.engine.search(query).catch(e => ({ candidates: [], providers: [], error: e.message }));
      if (track !== this.app.currentTrack) return;
      this.searching = false; this.result = result;
      if (result.providers.length) {
        const current = result.providers.find(p => p.provider === this.providerTab);
        if (current && !current.candidates.length) { const other = result.providers.find(p => p.candidates.length); if (other) this.providerTab = other.provider; }
      }
      this.renderResults();
    }
    renderResults() {
      if (!this.listEl) return;
      const store = this.app.store, onlyEligible = store.setting('only_eligible');
      const groups = this.result ? this.result.providers : Core.PROVIDERS.map(provider => ({ provider, candidates: [], searched: false }));
      this.chipsEl.replaceChildren(
        ...groups.map(g => h('button', { type: 'button', class: 'sl-chip' + (g.provider === this.providerTab ? ' sl-on' : ''), onclick: () => { this.providerTab = g.provider; this.selected = null; this.renderResults(); } },
          `${NAMES[g.provider]}${this.result ? ` ${g.candidates.length}` : ''}`)),
        h('button', { type: 'button', class: 'sl-chip sl-chip-filter' + (onlyEligible ? ' sl-on' : ''), onclick: () => { store.set('only_eligible', !onlyEligible); this.renderResults(); } }, '仅可自动匹配'));
      if (this.searching) { this.listEl.replaceChildren(h('div', { class: 'sl-loader sl-loader-small' }, h('i'), h('i'), h('i'))); return; }
      const group = groups.find(g => g.provider === this.providerTab) || groups[0];
      if (!this.result) { this.listEl.replaceChildren(h('p', { class: 'sl-empty-text' }, '输入关键词搜索歌词')); return; }
      if (group.error) { this.listEl.replaceChildren(h('p', { class: 'sl-empty-text sl-error' }, group.error)); return; }
      if (!group.searched) { this.listEl.replaceChildren(h('p', { class: 'sl-empty-text' }, '链接属于另一个来源，未搜索此来源')); return; }
      const list = group.candidates.filter(c => !onlyEligible || c.eligible);
      if (!list.length) { this.listEl.replaceChildren(h('p', { class: 'sl-empty-text' }, onlyEligible ? '没有可自动匹配的结果' : '没有搜索结果')); return; }
      this.listEl.replaceChildren(...list.map(c => this.row(c)));
    }
    row(c) {
      const key = `${c.provider}:${c.id}`, selected = this.selected === key;
      const level = c.eligible ? 'sl-good' : c.score >= 70 ? 'sl-mid' : 'sl-low';
      const tags = [];
      if (c.bound) tags.push(h('span', { class: 'sl-tag sl-tag-blue' }, '已绑定'));
      if (c.verified) tags.push(h('span', { class: 'sl-tag sl-tag-green' }, '歌词比对'));
      if (c.auto_selected) tags.push(h('span', { class: 'sl-tag sl-tag-green' }, '自动选择'));
      const delta = c.delta_ms >= 0 ? `${c.delta_ms <= 3000 ? '±' : 'Δ'}${(c.delta_ms / 1000).toFixed(1)}s` : '时长未知';
      const row = h('div', { class: 'sl-row' + (selected ? ' sl-selected' : ''), title: c.reason },
        h('button', { type: 'button', class: 'sl-row-main', onclick: () => this.select(c) },
          h('span', { class: `sl-score ${level}` }, Math.round(c.score)),
          h('span', { class: 'sl-row-text' },
            h('span', { class: 'sl-row-title' }, h('span', { class: 'sl-ellipsis' }, c.title), ...tags),
            h('span', { class: 'sl-row-sub' }, [c.artists.join(', '), c.album].filter(Boolean).join(' · '))),
          h('span', { class: 'sl-row-time' }, fmtTime(c.duration_ms), h('small', { class: c.delta_ms > 3000 || c.delta_ms < 0 ? 'sl-bad' : '' }, delta))));
      if (selected) row.append(this.previewBox(c));
      return row;
    }
    previewBox(c) {
      const box = h('div', { class: 'sl-preview' });
      box.append(h('p', { class: 'sl-preview-reason' + (c.eligible ? ' sl-good-text' : '') }, c.reason));
      if (!this.preview) box.append(h('div', { class: 'sl-loader sl-loader-small' }, h('i'), h('i'), h('i')));
      else if (this.preview.error) box.append(h('p', { class: 'sl-error' }, this.preview.error));
      else if (!Core.lyricsUsable(this.preview.lyrics)) box.append(h('p', { class: 'sl-empty-text' }, ({
        missing: 'QQ 音乐未收录这首歌的歌词', uncollected: '网易云音乐暂未收录这首歌的歌词',
        credits: '只有作词 / 作曲信息，没有歌词正文', instrumental: '纯音乐，没有歌词',
      })[this.preview.lyrics && this.preview.lyrics.note] || '这个结果没有歌词'));
      else {
        const lyrics = this.preview.lyrics;
        const kind = { word: '逐字同步', line: '逐行同步', unsynced: '未同步' }[lyrics.sync_type];
        const translated = lyrics.lines.some(l => l.translated_text);
        box.append(
          h('p', { class: 'sl-preview-meta' }, `${lyrics.lines.length} 行 · ${kind}${translated ? ' · 含译文' : ''}`),
          h('div', { class: 'sl-preview-lines' }, ...lyrics.lines.filter(l => l.text).slice(0, 12).map(l =>
            h('div', null, h('span', { class: 'sl-preview-time' }, lyrics.sync_type === 'unsynced' ? '' : fmtTime(l.start_time_ms)), h('span', null, l.text), l.translated_text ? h('em', null, l.translated_text) : null))),
          h('div', { class: 'sl-preview-actions' },
            h('button', { type: 'button', class: 'sl-btn sl-btn-green', onclick: async (event) => {
              const button = event.currentTarget; button.disabled = true;
              try {
                const result = await this.app.engine.bind(c, lyrics);
                toast(!result ? '保存失败' : result.offline ? '已保存匹配（纯本地模式，只保存在本机）'
                  : result.local ? '已绑定到本机（本地文件不保存到服务器）'
                  : result.error ? `已在本机绑定；上传服务器失败：${result.error}` : '已保存匹配，歌词已上传到服务器');
                this.search();
              } catch (e) { toast('保存失败：' + (e.message || e)); button.disabled = false; }
            } }, '使用此歌词'),
            h('button', { type: 'button', class: 'sl-btn sl-btn-ghost', onclick: () => { this.selected = null; this.renderResults(); } }, '取消')));
      }
      return box;
    }
    async select(c) {
      const key = `${c.provider}:${c.id}`;
      if (this.selected === key) { this.selected = null; this.renderResults(); return; }
      this.selected = key; this.preview = null; this.renderResults();
      let preview;
      try { preview = { lyrics: await this.app.engine.preview(c) }; } catch (e) { preview = { error: e.message || String(e) }; }
      if (this.selected !== key) return;
      this.preview = preview; this.renderResults();
    }
    importFile() {
      const input = h('input', { type: 'file', accept: '.lrc,.txt,text/plain', style: { display: 'none' } });
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) { toast('文件过大'); return; }
        const lyrics = Core.parseLrc(await file.text(), null, 'local');
        if (!Core.lyricsUsable(lyrics)) { toast('文件中没有可用歌词'); return; }
        await this.app.engine.importLyrics(lyrics); toast('已绑定本地歌词');
      });
      document.body.append(input); input.click();
    }
    async exportLrc() {
      const lyrics = this.app.engine.lyrics;
      if (!Core.lyricsUsable(lyrics)) { toast('当前没有歌词'); return; }
      try { await navigator.clipboard.writeText(Core.exportLrc(lyrics)); toast('LRC 已复制到剪贴板'); }
      catch (_) { toast('无法写入剪贴板'); }
    }
    /* settings tab */
    settingsTab() {
      const app = this.app, store = app.store, engine = app.engine;
      const rerender = () => { this.view.render(true); this.renderBody(); };
      const toggle = (key, label, hint, after) => h('label', { class: 'sl-setting' },
        h('span', { class: 'sl-setting-text' }, h('span', null, label), hint ? h('small', null, hint) : null),
        h('input', { type: 'checkbox', class: 'sl-switch', checked: !!store.setting(key), onchange: (e) => { store.set(key, e.target.checked); after && after(); rerender(); } }));
      const segmented = (key, label, options, after) => h('div', { class: 'sl-setting' },
        h('span', { class: 'sl-setting-text' }, h('span', null, label)),
        h('div', { class: 'sl-segmented' }, ...options.map(([value, text]) => h('button', {
          type: 'button', class: store.setting(key) === value ? 'sl-on' : '', onclick: () => { store.set(key, value); after && after(); rerender(); },
        }, text))));
      const globalOffset = store.getInt('timing-offset-ms', 0);
      const trackOffset = engine.offset() - globalOffset;
      const local = pureLocal();
      const stats = engine.http.stats, localStats = localRelay.stats, cloudStats = cloud.stats;
      const server = serverConfig();
      const serverLine = serverState.ok ? `已连接 · v${serverState.version}${serverState.storage === 'r2' ? ' · 匹配保存在 Cloudflare R2' : ''}${serverState.relay === false ? ' · 未开启转发' : ''}` : serverState.ok === false ? `未连接${serverState.error ? '：' + serverState.error : ''}` : '检测中…';
      const REQUEST_NAMES = { direct: '直连', service: '本地服务', server: '经歌词服务器转发' };
      const used = [];
      if (netState.directCount) used.push(`直连 ${netState.directCount} 次`);
      if (netState.localCount) used.push(`本地服务 ${netState.localCount} 次`);
      if (netState.serverCount) used.push(`歌词服务器 ${netState.serverCount} 次`);
      const netOrder = `安装时选择：${REQUEST_NAMES[BAKED_REQUEST]} · 始终本地优先：直连 → 本地服务${local ? '' : ' → 歌词服务器'}`;
      const netLine = `${netState.direct === false ? '直连被 Spotify 拦截（CORS）；' : ''}${used.length ? '本次：' + used.join('，') : '尚未发出请求'}`;
      const localLine = localState.ok ? `运行中 · v${localState.version} · ${LOCAL_URL}` : localState.ok === false ? `未运行（${LOCAL_URL}）` : '检测中…';
      /* The pure local variant offered here follows the patch (local service or direct). */
      const pureMode = BAKED_MODE === 'cloud' ? 'local' : BAKED_MODE;
      const modeRow = h('div', { class: 'sl-setting' },
        h('span', { class: 'sl-setting-text' }, h('span', null, '使用方式')),
        h('div', { class: 'sl-segmented' }, ...[['cloud', '云端服务器'], [pureMode, '纯本地']].map(([value, text]) => h('button', {
          type: 'button', class: (value === 'cloud') !== local ? 'sl-on' : '',
          onclick: () => { if ((value === 'cloud') === local) { app.setMode(value); this.renderBody(); } },
        }, text))));
      const localRows = [
        h('div', { class: 'sl-setting' }, h('span', { class: 'sl-setting-text' }, h('span', null, '本地服务'),
          h('small', { class: localState.ok ? 'sl-good-text' : localState.ok === false && BAKED_REQUEST === 'service' ? 'sl-error' : '' }, localLine)),
          h('button', { type: 'button', class: 'sl-btn sl-btn-ghost sl-btn-small', onclick: async () => { await checkLocal(); this.renderBody(); } }, '检测')),
      ];
      const saveServer = async () => {
        const url = cleanServerUrl(this.serverInput.value);
        if (url && !/^https?:\/\/[^\s/]+/i.test(url)) { toast('地址需以 https:// 开头'); return; }
        store.set('server_url', url === cleanServerUrl(DEFAULT_SERVER) ? '' : url);
        store.set('server_token', this.tokenInput.value.trim());
        await store.cacheClear();
        await checkServer();
        toast(serverState.ok ? '歌词服务器已连接' : '无法连接歌词服务器');
        if (engine.track) engine.setTrack(engine.track, true);
        this.renderBody();
      };
      this.serverInput = h('input', { class: 'sl-input sl-input-small', type: 'url', spellcheck: 'false', value: server.url, placeholder: cleanServerUrl(DEFAULT_SERVER), onkeydown: (e) => { if (e.key === 'Enter') saveServer(); } });
      this.tokenInput = h('input', { class: 'sl-input sl-input-small', type: 'password', value: store.setting('server_token') || '', placeholder: '令牌（服务器未设置 API_TOKEN 时留空）', onkeydown: (e) => { if (e.key === 'Enter') saveServer(); } });
      const offsetRow = (label, value, apply) => h('div', { class: 'sl-setting' },
        h('span', { class: 'sl-setting-text' }, h('span', null, label), h('small', null, '正值让歌词提前显示')),
        h('div', { class: 'sl-stepper' },
          h('button', { type: 'button', onclick: () => { apply(value - 100); rerender(); } }, svg(ICON.minus)),
          h('span', { onclick: () => { apply(0); rerender(); }, title: '点击归零' }, `${value > 0 ? '+' : ''}${value} ms`),
          h('button', { type: 'button', onclick: () => { apply(value + 100); rerender(); } }, svg(ICON.plus))));
      return h('div', { class: 'sl-settings' },
        h('h3', null, '歌词来源'),
        segmented('preferred_provider', '首选歌词源', [['netease', '网易云音乐'], ['qq', 'QQ 音乐']]),
        toggle('spotify_first', '优先使用 Spotify 歌词'),
        toggle('prefetch', '后台预加载'),
        h('h3', null, '显示'),
        toggle('translation', '显示译文'),
        toggle('word_sync', '逐字高亮'),
        toggle('mini_player', '右侧栏迷你歌词', null, () => this.app.mini.refresh()),
        segmented('font_scale', '字号', [[0.8, '小'], [1, '标准'], [1.2, '大']]),
        segmented('color_mode', '背景', [['cover', '封面取色'], ['blur', '封面模糊'], ['dark', '深色']]),
        h('h3', null, '时间校准'),
        offsetRow('全局偏移', globalOffset, v => engine.setOffset(v, true)),
        offsetRow('当前歌曲偏移', trackOffset, v => engine.setOffset(v, false)),
        h('h3', null, '使用方式与网络'),
        modeRow,
        ...(local ? [] : [h('div', { class: 'sl-setting' }, h('span', { class: 'sl-setting-text' }, h('span', null, '服务器状态'), h('small', { class: serverState.ok ? 'sl-good-text' : serverState.ok === false ? 'sl-error' : '' }, serverLine)),
          h('button', { type: 'button', class: 'sl-btn sl-btn-ghost sl-btn-small', onclick: async () => { await checkServer(); this.renderBody(); } }, '检测')),
        h('div', { class: 'sl-setting sl-setting-column' },
          h('span', { class: 'sl-setting-text' }, h('span', null, '服务器地址')),
          this.serverInput, this.tokenInput,
          h('div', { class: 'sl-setting-actions' },
            h('button', { type: 'button', class: 'sl-btn sl-btn-ghost sl-btn-small', onclick: () => { this.serverInput.value = cleanServerUrl(DEFAULT_SERVER); this.tokenInput.value = ''; saveServer(); } }, '恢复默认'),
            h('button', { type: 'button', class: 'sl-btn sl-btn-green sl-btn-small', onclick: saveServer }, '保存'))),
        ]),
        ...localRows,
        h('div', { class: 'sl-setting' }, h('span', { class: 'sl-setting-text' }, h('span', null, '网易云 / QQ 请求'),
          h('small', null, netOrder), h('small', { class: netState.direct === true || netState.localCount ? 'sl-good-text' : '' }, netLine))),
        local ? null : toggle('relay', '允许服务器转发'),
        h('div', { class: 'sl-setting' }, h('span', { class: 'sl-setting-text' }, h('span', null, '本次会话'),
          h('small', null, `音乐平台 ${stats.requests} 次请求 · 本地服务 ${localStats.requests} 次 · 歌词服务器 ${cloudStats.requests} 次 · ${fmtBytes(stats.sent_bytes + stats.received_bytes + localStats.sent_bytes + localStats.received_bytes + cloudStats.sent_bytes + cloudStats.received_bytes)} · 缓存命中 ${stats.cache_hits} 次`)),
          h('button', { type: 'button', class: 'sl-btn sl-btn-ghost sl-btn-small', onclick: async () => { await store.cacheClear(); toast(local ? '本机缓存已清理，绑定的匹配与本地歌词已保留' : '本机缓存已清理，服务器上的匹配与本地歌词已保留'); } }, '清理缓存')),
        h('p', { class: 'sl-about' }, `Spot-Lyric for Spotify v${VERSION}`));
    }
  }

  function toast(text) {
    const el = h('div', { class: 'sl-toast', role: 'status' }, text);
    document.body.append(el);
    requestAnimationFrame(() => el.classList.add('sl-visible'));
    setTimeout(() => { el.classList.remove('sl-visible'); setTimeout(() => el.remove(), 300); }, 2600);
  }

  /* ---------------------------------------------------------- boot ----- */
  /* net: the request paths, for diagnostics in the devtools console and for tests. */
  window.__spotLyric = { version: VERSION, mode: BAKED_MODE, request: BAKED_REQUEST, net: { transport: providerTransport, state: netState, local: localState, server: serverState } };
  waitFor(() => {
    const platform = findPlatform();
    return platform && platform.getRegistry().resolve(Symbol.for('PlayerAPI')) && document.getElementById('main-view') ? platform : null;
  }).then(async (platform) => {
    const app = new App(platform);
    window.__spotLyric.app = app;
    await app.start();
  }).catch(e => console.error('[spot-lyric] failed to start', e));
})();
