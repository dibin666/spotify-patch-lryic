// Lyrics server (storage + relay: `spot-lyric-server serve`, Go code in server/) and the client engine
// that uses it, end to end, with fake NetEase / QQ on the client side and the server's
// local-directory storage. Also covers pure local mode (no lyrics server).
//   node --test tests/server.test.mjs   (needs Go; builds cmd/spot-lyric-server once)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from './memory-store.mjs';
const require = createRequire(import.meta.url);
const core = require('../src/core.js');

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spot-lyric-bin-')), 'spot-lyric-server');
execFileSync('go', ['build', '-o', binary, './cmd/spot-lyric-server'], { cwd: repoDir, env: { ...process.env, CGO_ENABLED: '0' } });

const lrc = list => list.map((t, i) => `[00:${String(10 + i * 3).padStart(2, '0')}.00]${t}`).join('\n');
const SONGS = {
  7: { id: 7, name: '晴天', duration: 269000, artists: [{ name: '周杰伦' }], album: { name: '叶惠美' } },
  8: { id: 8, name: '晴天', duration: 269300, artists: [{ name: '周杰伦' }], album: { name: '晴天 (Live)' } },
};
const LYRICS = { 7: lrc(['故事的小黄花', '从出生那年就飘着', '童年的荡秋千']), 8: lrc(['第二个版本', '另一行', '再一行']) };

/* Fake NetEase / QQ: used by the client directly or by the server relay. */
function providers(calls) {
  return async (req) => {
    calls.push(req.url);
    if (req.url.includes('u.y.qq.com')) return { status: 200, body: JSON.stringify({ code: 0, req_1: { code: 0, data: { body: { song: { list: [] } } } } }) };
    if (req.url.includes('/search/')) {
      const q = decodeURIComponent(/s=([^&]*)/.exec(req.url)[1]);
      const ids = q.includes('晴天') ? [7, 8] : [];
      return { status: 200, body: JSON.stringify({ code: 200, result: { songs: ids.map(id => SONGS[id]) } }) };
    }
    const id = /id=(\d+)/.exec(req.url)[1];
    return { status: 200, body: JSON.stringify({ code: 200, lrc: { lyric: LYRICS[id] || '' } }) };
  };
}

const freePort = () => new Promise(resolve => { const srv = createServer(); srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });

async function start(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spot-lyric-data-'));
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir, LOG_REQUESTS: '0' };
  if (options.token) env.API_TOKEN = options.token;
  if (options.relay === false) env.RELAY = '0';
  const child = spawn(binary, ['serve'], { env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch (_) { /* not up yet */ }
    if (i > 100) throw new Error('server did not start');
    await new Promise(r => setTimeout(r, 50));
  }
  const objects = path.join(dataDir, 'objects');
  const files = () => { try { return fs.readdirSync(path.join(objects, 'lyrics')).filter(f => f.endsWith('.json')); } catch (_) { return []; } };
  const bucket = {
    objects: {
      get: key => { try { return { body: fs.readFileSync(path.join(objects, key), 'utf8') }; } catch (_) { return undefined; } },
      get size() { return files().length; },
    },
    get puts() { return files().length; },
  };
  return { bucket, base, close: async () => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

function serverTransport(base, headers = {}) {
  return async (method, path, body, signal) => {
    const r = await fetch(base + path, { method, headers: { ...(body != null ? { 'Content-Type': 'text/plain' } : {}), ...headers }, body: body == null ? undefined : body, signal });
    return { status: r.status, body: await r.text() };
  };
}
/* relay: provider requests go through the server (the renderer cannot reach them). */
function client(base, { relay = false, local = [], spotify = null, store = new MemoryStore(), headers = {} } = {}) {
  const cloud = new core.Cloud(serverTransport(base, headers));
  const http = new core.Http(relay ? (req, signal) => cloud.relay(req, signal) : providers(local));
  return new core.Engine({ store, http, cloud, spotify, settings: () => ({ preferred_provider: 'netease', verify_lyrics: true }) });
}

const SUNNY = { uri: 'spotify:track:0RiRZpuVRbi7oqRdSMwhQY', title: '晴天', artists: ['周杰伦'], album: '叶惠美', duration_ms: 269000 };
const KEY = 'lyrics/0RiRZpuVRbi7oqRdSMwhQY.json';

test('client: matching runs locally, the server only stores; automatic results are not uploaded', async (t) => {
  const s = await start(); t.after(s.close);
  const local = [];
  const engine = client(s.base, { local });
  await engine.setTrack(SUNNY);
  assert.equal(engine.status, '已匹配歌词 · 网易云音乐');
  assert.equal(engine.lyrics.lines[0].text, '故事的小黄花');
  assert.equal(engine.match.id, '7');
  assert.ok(local.length >= 2, 'NetEase / QQ were requested by the client');
  assert.equal(s.bucket.puts, 0, 'nothing stored without a manual choice');
});

test('relay: only the allow-list is forwarded; RELAY=0 turns it off', async (t) => {
  const s = await start(); t.after(s.close);
  // Only the allow-list is forwarded.
  const post = body => fetch(`${s.base}/api/relay`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post({ method: 'GET', url: 'https://evil.example/api/search/get/web' })).status, 400);
  assert.equal((await post({ method: 'GET', url: 'https://music.163.com/weapi/user/account' })).status, 400);
  assert.equal((await post({ method: 'DELETE', url: 'https://music.163.com/api/song/lyric?id=1' })).status, 400);
  // RELAY=0 turns forwarding off.
  const off = await start({ relay: false }); t.after(off.close);
  assert.equal((await fetch(`${off.base}/api/relay`, { method: 'POST', body: JSON.stringify({ method: 'GET', url: 'https://music.163.com/api/song/lyric?id=7' }) })).status, 403);
  assert.equal((await (await fetch(`${off.base}/health`)).json()).relay, false);
});

test('"使用此歌词" uploads match + lyrics; the latest choice wins; other clients get it; unbind removes it', async (t) => {
  const s = await start(); t.after(s.close);
  const engine = client(s.base);
  await engine.setTrack(SUNNY);
  const result = await engine.search('晴天 周杰伦');
  const [first, second] = result.providers[0].candidates;
  assert.equal(result.providers[0].candidates.length, 2);
  const preview = await engine.preview(first);
  assert.equal(preview.lines[0].text, '故事的小黄花');

  assert.equal((await engine.bind(first, preview)).stored, 'local');
  assert.equal(engine.origin, 'cloud');
  let doc = JSON.parse(s.bucket.objects.get(KEY).body);
  assert.equal(doc.spotify_url, 'https://open.spotify.com/track/0RiRZpuVRbi7oqRdSMwhQY');
  assert.equal(doc.match.id, first.id);
  assert.equal(doc.match.url, `https://music.163.com/#/song?id=${first.id}`);
  assert.match(doc.lrc, /故事的小黄花/);
  assert.equal(doc.lyrics.lines[0].text, '故事的小黄花');

  // Switching lyrics overwrites the same object.
  await engine.bind(second, await engine.preview(second));
  doc = JSON.parse(s.bucket.objects.get(KEY).body);
  assert.equal(s.bucket.objects.size, 1);
  assert.equal(doc.match.id, second.id);
  assert.equal(doc.bind_count, 2);
  assert.equal(doc.lyrics.lines[0].text, '第二个版本');

  // Another client (empty local cache) gets the stored lyrics without any provider request.
  const local = [];
  const other = client(s.base, { local });
  await other.setTrack(SUNNY);
  assert.equal(other.status, '云端歌词 · 网易云音乐');
  assert.equal(other.lyrics.lines[0].text, '第二个版本');
  assert.equal(local.length, 0, 'served from the server');
  const marked = (await other.search('晴天 周杰伦')).providers[0].candidates.filter(c => c.bound).map(c => c.id);
  assert.deepEqual(marked, [second.id]);
  const info = await (await fetch(`${s.base}/api/bindings/0RiRZpuVRbi7oqRdSMwhQY`)).json();
  assert.equal(info.binding.match.id, second.id);
  assert.equal(info.binding.lrc, undefined, 'the LRC copy stays in the bucket');

  await engine.unbind();
  assert.equal(s.bucket.objects.size, 0);
  assert.equal((await fetch(`${s.base}/api/bindings/0RiRZpuVRbi7oqRdSMwhQY`)).status, 404);
  assert.equal(engine.status, '已匹配歌词 · 网易云音乐', 'unbind rematches automatically');
});

test('upload button: current lyrics (automatic match or local LRC) go to the server; Spotify lyrics never do', async (t) => {
  const s = await start(); t.after(s.close);
  const engine = client(s.base);
  await engine.setTrack(SUNNY);
  await engine.upload();
  let doc = JSON.parse(s.bucket.objects.get(KEY).body);
  assert.equal(doc.match.id, '7');
  assert.equal(doc.source, 'netease');
  assert.equal(engine.origin, 'cloud');

  await engine.importLyrics(core.parseLrc('[00:01.00]自己的歌词\n[00:02.00]第二行', null, 'local'));
  await engine.upload();
  doc = JSON.parse(s.bucket.objects.get(KEY).body);
  assert.equal(doc.match, null);
  assert.equal(doc.source, 'local');
  assert.equal(doc.lyrics.lines[0].text, '自己的歌词');

  const spotifyOnly = client(s.base, { spotify: async () => ({ lyrics: core.parseLrc(lrc(['a', 'b', 'c']), null, 'spotify'), colors: null }) });
  await spotifyOnly.setTrack({ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa', title: 'Nothing Here', artists: ['Nobody'], album: '', duration_ms: 100000 });
  assert.equal(spotifyOnly.status, 'Spotify 歌词');
  await assert.rejects(spotifyOnly.upload(), /Spotify 官方歌词/);
  const post = (path, body) => fetch(s.base + path, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post('/api/bind', { track: SUNNY, lyrics: core.parseLrc('[00:01.00]x', null, 'spotify') })).status, 422);
});

test('server: bind validates input', async (t) => {
  const s = await start(); t.after(s.close);
  const post = (path, body) => fetch(s.base + path, { method: 'POST', body: JSON.stringify(body) });
  const lyrics = core.parseLrc('[00:01.00]line', null, 'netease');
  assert.equal((await post('/api/bind', { track: { title: 'x', uri: 'spotify:local:a' }, lyrics })).status, 400);
  assert.equal((await post('/api/bind', { track: SUNNY, candidate: { provider: 'evil', id: '7' }, lyrics })).status, 400);
  assert.equal((await post('/api/bind', { track: SUNNY, candidate: { provider: 'qq', id: '7' }, lyrics })).status, 400, 'source must match the candidate');
  assert.equal((await post('/api/bind', { track: SUNNY, lyrics: { lines: [{ text: '' }] } })).status, 422);
  assert.equal(s.bucket.puts, 0);
  // Unknown fields are dropped and sizes bounded.
  const r = await post('/api/bind', { track: SUNNY, lyrics: { source: 'local', sync_type: 'line', evil: 1, lines: [{ text: 'a'.repeat(900), start_time_ms: 5, html: '<b>' }] } });
  assert.equal(r.status, 200);
  const doc = JSON.parse(s.bucket.objects.get(KEY).body);
  assert.equal(doc.lyrics.evil, undefined);
  assert.equal(doc.lyrics.lines[0].text.length, 500);
  assert.equal(doc.lyrics.lines[0].html, undefined);
  // Old clients are told to update.
  assert.equal((await post('/api/match', { track: SUNNY })).status, 410);
});

test('local files stay on the client; origin allow-list and optional token', async (t) => {
  const s = await start({ token: 'secret' }); t.after(s.close);
  const engine = client(s.base, { headers: { Authorization: 'Bearer secret' } });
  const local = { uri: 'spotify:local:Artist:Album:Song:200', title: 'Song', artists: ['Artist'], album: 'Album', duration_ms: 200000 };
  await engine.setTrack(local);
  const result = await engine.bind({ provider: 'netease', id: '7' }, core.parseLrc('[00:01.00]local', null, 'netease'));
  assert.equal(result.local, true);
  assert.equal(s.bucket.puts, 0);

  const evil = await fetch(`${s.base}/api/bind`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(evil.status, 403);
  const cors = await fetch(`${s.base}/health`, { headers: { Origin: 'https://xpui.app.spotify.com' } });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'https://xpui.app.spotify.com');
  assert.equal((await cors.json()).auth, true);
  // Without the token the server is unusable, but local matching still works.
  const anonymous = client(s.base);
  await anonymous.setTrack(SUNNY);
  assert.equal(anonymous.status, '已匹配歌词 · 网易云音乐');
  assert.match(anonymous.cloudError, /需要歌词服务器令牌/);
  const r = await anonymous.bind(anonymous.match, anonymous.lyrics);
  assert.match(r.error, /需要歌词服务器令牌/);
  assert.equal(anonymous.status, '已绑定歌词 · 网易云音乐', 'still bound on this machine');
  const authorized = client(s.base, { headers: { Authorization: 'Bearer secret' } });
  await authorized.setTrack(SUNNY);
  await authorized.upload();
  assert.equal(s.bucket.puts, 1);
});

test('pure local mode: no lyrics server is contacted; bindings stay on this machine', async (t) => {
  const s = await start(); t.after(s.close);
  const local = [];
  const engine = new core.Engine({ store: new MemoryStore(), http: new core.Http(providers(local)), cloud: null, settings: () => ({ preferred_provider: 'netease' }) });
  await engine.setTrack(SUNNY);
  assert.equal(engine.status, '已匹配歌词 · 网易云音乐');
  const [first, second] = (await engine.search('晴天 周杰伦')).providers[0].candidates;
  const result = await engine.bind(second, await engine.preview(second));
  assert.equal(result.offline, true);
  assert.equal(engine.origin, 'manual');
  assert.equal(engine.lyrics.lines[0].text, '第二个版本');
  await assert.rejects(engine.upload(), /纯本地/);
  // The binding survives a track change on this machine.
  await engine.setTrack(null);
  await engine.setTrack(SUNNY);
  assert.equal(engine.match.id, second.id);
  await engine.unbind();
  assert.equal(engine.match.id, first.id, 'unbind rematches automatically');
  assert.equal(s.bucket.puts, 0, 'nothing reached a server');
});
