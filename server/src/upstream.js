'use strict';
/*
 * Requests to the lyric providers. Only a fixed allow-list of NetEase / QQ Music
 * hosts can be reached, redirects are not followed, bodies are capped at 2 MiB.
 */
const ALLOWED_HOSTS = new Set([
  'music.163.com', 'interface.music.163.com', 'interface3.music.163.com',
  'u.y.qq.com', 'c.y.qq.com', 'i.y.qq.com',
]);
const FORWARD_HEADERS = ['referer', 'content-type', 'accept'];
const MAX_RESPONSE = 2 << 20;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

class UpstreamError extends Error {
  constructor(message, transient) { super(message); this.transient = !!transient; this.kind = 'network'; }
}

async function readLimited(response) {
  const reader = response.body && response.body.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE) { await reader.cancel().catch(() => {}); throw new UpstreamError('响应超过 2 MiB 限制', false); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* All users of a server share one address. QQ Music throttles bursts per IP
 * (code 2001 with empty results for minutes), so requests to each provider are
 * spaced out instead of fired in parallel. */
function pacer(gapMs) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gapMs;
    if (at > now) await new Promise(resolve => setTimeout(resolve, at - now));
  };
}

/**
 * @param {{neteaseRealIp?: string, timeoutMs?: number, qqGapMs?: number, neteaseGapMs?: number}} options
 * @returns {(req: {method: string, url: string, headers?: object, body?: string|null}) => Promise<{status: number, body: string, retryAfter: string|null}>}
 */
function createTransport(options = {}) {
  const timeoutMs = options.timeoutMs || 12000;
  const pace = { qq: pacer(options.qqGapMs == null ? 400 : options.qqGapMs), netease: pacer(options.neteaseGapMs == null ? 120 : options.neteaseGapMs) };
  const retryDelays = options.qqRetryDelaysMs || [2000];
  /* QQ answers HTTP 200 + code 2001 (empty results) while it throttles this
   * address; the window passes within seconds, so back off and try again. */
  return async function transport(req) {
    let result = await once(req);
    for (const delay of retryDelays) {
      if (!/"code":\s*2001\b/.test(result.body.slice(0, 200)) || !/qq\.com$/.test(new URL(req.url).hostname)) break;
      await new Promise(resolve => setTimeout(resolve, delay));
      result = await once(req);
    }
    return result;
  };
  async function once(req) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') throw new UpstreamError('method not allowed', false);
    let url;
    try { url = new URL(req.url); } catch (_) { throw new UpstreamError('bad url', false); }
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || (url.port && url.port !== '443')) throw new UpstreamError('host not allowed', false);
    const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
    for (const [name, value] of Object.entries(req.headers || {})) {
      if (FORWARD_HEADERS.includes(name.toLowerCase()) && typeof value === 'string') headers[name] = value;
    }
    if (req.body != null && !Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    /* NetEase answers overseas / datacenter addresses with encrypted search results. */
    if (options.neteaseRealIp && url.hostname.endsWith('163.com')) { headers['X-Real-IP'] = options.neteaseRealIp; headers['X-Forwarded-For'] = options.neteaseRealIp; }
    await pace[url.hostname.endsWith('qq.com') ? 'qq' : 'netease']();
    let response;
    try {
      response = await fetch(url, { method, headers, body: req.body == null ? undefined : String(req.body), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new UpstreamError(timeout ? 'upstream timeout' : `upstream error: ${(e.cause && e.cause.code) || e.message}`, true);
    }
    const body = await readLimited(response);
    return { status: response.status, body, retryAfter: response.headers.get('retry-after') };
  }
}

module.exports = { createTransport, ALLOWED_HOSTS, UpstreamError };
