// In-memory implementation of the engine store used by the Spotify client.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../src/core.js');

export class MemoryStore {
  constructor() { this.settings = new Map(); this.cache = new Map(); this.kv = new Map(); this.matches = new Map(); }
  get(k, d) { return this.settings.has(k) ? this.settings.get(k) : d; }
  getInt(k, d) { const v = parseInt(this.get(k, ''), 10); return isFinite(v) ? v : d; }
  set(k, v) { this.settings.set(k, v); }
  async cacheGet(k) { const e = this.cache.get(k); return e && (!e.exp || e.exp > Date.now()) ? e.v : null; }
  async cachePut(k, v, ttl) { this.cache.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : 0 }); }
  async cacheRemove(k) { this.cache.delete(k); }
  async cacheClear() { this.cache.clear(); }
  async kvGet(k) { return this.kv.get(k) || null; }
  async kvSet(k, v) { this.kv.set(k, v); }
  async matchGet(t) { const m = this.matches.get(core.trackKey(t)); return m ? { candidate: core.candidateFromJson(m.c), manual: m.manual } : { candidate: null, manual: false }; }
  async matchSave(t, c, manual) { this.matches.set(core.trackKey(t), { c: core.candidateJson(c), manual }); }
  async matchRemove(t) { this.matches.delete(core.trackKey(t)); }
}
