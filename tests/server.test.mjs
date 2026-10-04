// Lyrics server + client (RemoteEngine) end to end, with fake NetEase / QQ and an
// in-memory bucket.   node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MemoryStore } from './memory-store.mjs';
const require = createRequire(import.meta.url);
const core = require('../src/core.js');
const { createApp } = require('../server/src/server.js');

class MemoryBucket {
  constructor() { this.objects = new Map(); this.puts = 0; }
  async put(key, body, type, metadata) { this.puts++; this.objects.set(key, { body, type, metadata }); }
  async get(key) { const o = this.objects.get(key); return o ? o.body : null; }
  async delete(key) { this.objects.delete(key); }
}

const lrc = list => list.map((t, i) => `[00:${String(10 + i * 3).padStart(2, '0')}.00]${t}`).join('\n');
const SONGS = {
  7: { id: 7, name: '晴天', duration: 269000, artists: [{ name: '周杰伦' }], album: { name: '叶惠美' } },
  8: { id: 8, name: '晴天', duration: 269300, artists: [{ name: '周杰伦' }], album: { name: '晴天 (Live)' } },
  11: { id: 11, name: '夜に駆ける', duration: 261000, artists: [{ name: 'YOASOBI' }], album: { name: '' } },
  12: { id: 12, name: 'ハルジオン', duration: 261500, artists: [{ name: 'YOASOBI' }], album: { name: '' } },
};
const YORU = ['言えないことばかり増えてくから', '後悔多めの今日の数', '数えた最後の夜の隅', 'どうか触れちゃうなら抱きしめて', '解けないことばかり知ってくから'];
const LYRICS = { 7: lrc(['故事的小黄花', '从出生那年就飘着', '童年的荡秋千']), 8: lrc(['第二个版本', '另一行', '再一行']), 11: lrc(YORU),
  12: lrc(['全然違う歌詞の一行目', '二行目も違う', '三行目も違う', '四行目も違う', '五行目']) };

function upstream(calls) {
  return async (req) => {
    calls.push(req.url);
    if (req.url.includes('u.y.qq.com')) return { status: 200, body: JSON.stringify({ code: 0, req_1: { code: 0, data: { body: { song: { list: [] } } } } }) };
    if (req.url.includes('/search/')) {
      const q = decodeURIComponent(/s=([^&]*)/.exec(req.url)[1]);
      const ids = q.includes('晴天') ? [7, 8] : q.includes('yoru') || q.includes('yoasobi') ? [12, 11] : [];
      return { status: 200, body: JSON.stringify({ code: 200, result: { songs: ids.map(id => SONGS[id]) } }) };
    }
    const id = /id=(\d+)/.exec(req.url)[1];
    return { status: 200, body: JSON.stringify({ code: 200, lrc: { lyric: LYRICS[id] || '' } }) };
  };
}

async function start(options = {}) {
  const calls = [];
  const bucket = new MemoryBucket();
  const app = createApp({ env: {}, bucket, transport: upstream(calls), config: { port: 0, host: '127.0.0.1', logRequests: false, ...options } });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  return { app, bucket, calls, base, close: () => app.close() };
}

function client(base, { spotify = null, settings = {}, store = new MemoryStore(), headers = {} } = {}) {
  const transport = async (path, body, signal) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...headers }, body, signal });
    return { status: r.status, body: await r.text() };
  };
  return new core.RemoteEngine({ store, transport, spotify, settings: () => ({ preferred_provider: 'netease', verify_lyrics: true, ...settings }) });
}

const SUNNY = { uri: 'spotify:track:0RiRZpuVRbi7oqRdSMwhQY', title: '晴天', artists: ['周杰伦'], album: '叶惠美', duration_ms: 269000 };

test('server: automatic match runs remotely; automatic results are not stored', async (t) => {
  const s = await start(); t.after(s.close);
  const store = new MemoryStore();
  const engine = client(s.base, { store });
  await engine.setTrack(SUNNY);
  assert.equal(engine.status, '已匹配歌词 · 网易云音乐');
  assert.equal(engine.lyrics.lines[0].text, '故事的小黄花');
  assert.equal(s.bucket.puts, 0, 'nothing stored without a manual choice');
  const again = client(s.base, { store });
  await again.setTrack(SUNNY);
  assert.equal(again.status, '已匹配歌词 · 网易云音乐 · 缓存', 'answers are cached on the client');
  const unique = { uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa', title: 'Nothing Here', artists: ['Nobody'], album: '', duration_ms: 100000 };
  await engine.setTrack(unique);
  assert.equal(engine.status, '未匹配，可手动选择歌词');
  // Spotify lyrics are the client-side fallback.
  const withSpotify = client(s.base, { spotify: async () => ({ lyrics: core.parseLrc(lrc(['spotify line 1', 'b', 'c']), null, 'spotify'), colors: { background: 'x' } }) });
  await withSpotify.setTrack(unique);
  assert.equal(withSpotify.status, 'Spotify 歌词');
  assert.equal(withSpotify.colors.background, 'x');
  assert.equal(s.bucket.puts, 0);
});

test('server: lyric-content check uses Spotify lyrics sent by the client', async (t) => {
  const s = await start(); t.after(s.close);
  const track = { uri: 'spotify:track:bbbbbbbbbbbbbbbbbbbbbb', title: 'Yoru ni Kakeru', artists: ['YOASOBI'], album: '', duration_ms: 261000 };
  const spotify = lines => async () => ({ lyrics: core.parseLrc(lrc(lines), null, 'spotify'), colors: { background: 'c' } });
  const ok = client(s.base, { spotify: spotify(YORU) });
  await ok.setTrack(track);
  assert.equal(ok.status, '已匹配歌词 · 网易云音乐（歌词比对 100%）');
  assert.equal(ok.lyrics.source, 'netease');
  assert.equal(ok.colors.background, 'c', 'Spotify colours are kept');
  const bad = client(s.base, { spotify: spotify(['完全に別の歌です', 'ほかの行', 'さらに別の行', 'もう一行', '最後の行']) });
  await bad.setTrack(track);
  assert.equal(bad.status, 'Spotify 歌词');
  assert.equal(s.bucket.puts, 0, 'verified automatic matches are not stored either');
});

test('server: "使用此歌词" stores match + lyrics in the bucket; latest choice wins; unbind removes it', async (t) => {
  const s = await start(); t.after(s.close);
  const engine = client(s.base);
  await engine.setTrack(SUNNY);
  const result = await engine.search('晴天 周杰伦');
  const [first, second] = result.providers[0].candidates;
  assert.equal(result.providers[0].candidates.length, 2);
  const preview = await engine.preview(first);
  assert.equal(preview.lines[0].text, '故事的小黄花');

  await engine.bind(first, preview);
  assert.equal(engine.status, '已绑定歌词 · 网易云音乐');
  const key = 'lyrics/0RiRZpuVRbi7oqRdSMwhQY.json';
  let doc = JSON.parse(s.bucket.objects.get(key).body);
  assert.equal(doc.spotify_url, 'https://open.spotify.com/track/0RiRZpuVRbi7oqRdSMwhQY');
  assert.equal(doc.match.id, first.id);
  assert.equal(doc.match.url, `https://music.163.com/#/song?id=${first.id}`);
  assert.match(doc.lrc, /故事的小黄花/);
  assert.equal(doc.lyrics.lines[0].text, '故事的小黄花');
  assert.equal(s.bucket.objects.get(key).metadata['spotify-url'], doc.spotify_url);

  // Switching lyrics overwrites the same object.
  await engine.bind(second, await engine.preview(second));
  doc = JSON.parse(s.bucket.objects.get(key).body);
  assert.equal(s.bucket.objects.size, 1);
  assert.equal(doc.match.id, second.id);
  assert.equal(doc.bind_count, 2);
  assert.equal(doc.lyrics.lines[0].text, '第二个版本');

  // Another client (empty local cache) gets the stored lyrics without any provider request.
  const before = s.calls.length;
  const other = client(s.base);
  await other.setTrack(SUNNY);
  assert.equal(other.status, '已绑定歌词 · 网易云音乐');
  assert.equal(other.lyrics.lines[0].text, '第二个版本');
  assert.equal(s.calls.length, before, 'served from the bucket');
  const marked = (await other.search('晴天 周杰伦')).providers[0].candidates.filter(c => c.bound).map(c => c.id);
  assert.deepEqual(marked, [second.id]);
  const info = await (await fetch(`${s.base}/api/bindings/0RiRZpuVRbi7oqRdSMwhQY`)).json();
  assert.equal(info.binding.match.id, second.id);
  assert.equal(info.binding.lyrics, undefined);

  await engine.unbind();
  assert.equal(s.bucket.objects.size, 0);
  assert.equal((await fetch(`${s.base}/api/bindings/0RiRZpuVRbi7oqRdSMwhQY`)).status, 404);
});

test('server: bind validates input; local files stay on the client', async (t) => {
  const s = await start(); t.after(s.close);
  const post = (path, body) => fetch(s.base + path, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post('/api/bind', { track: { title: 'x', uri: 'spotify:local:a' }, candidate: { provider: 'netease', id: '7' } })).status, 400);
  assert.equal((await post('/api/bind', { track: SUNNY, candidate: { provider: 'evil', id: '7' } })).status, 400);
  assert.equal((await post('/api/bind', { track: SUNNY, candidate: { provider: 'netease', id: '999' } })).status, 422, 'no lyrics -> nothing stored');
  assert.equal(s.bucket.puts, 0);
  const engine = client(s.base);
  const local = { uri: 'spotify:local:Artist:Album:Song:200', title: 'Song', artists: ['Artist'], album: 'Album', duration_ms: 200000 };
  await engine.setTrack(local);
  const result = await engine.bind({ provider: 'netease', id: '7' }, core.parseLrc('[00:01.00]local', null, 'netease'));
  assert.equal(result.local, true);
  assert.equal(engine.status, '已绑定本地歌词');
  assert.equal(s.bucket.puts, 0);
});

test('server: origin allow-list, optional token, unreachable server falls back to Spotify', async (t) => {
  const s = await start({ token: 'secret' }); t.after(s.close);
  const evil = await fetch(`${s.base}/api/match`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(evil.status, 403);
  const cors = await fetch(`${s.base}/health`, { headers: { Origin: 'https://xpui.app.spotify.com' } });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'https://xpui.app.spotify.com');
  assert.equal((await cors.json()).auth, true);
  const anonymous = client(s.base);
  await anonymous.setTrack(SUNNY);
  assert.match(anonymous.status, /歌词服务器不可用：需要歌词服务器令牌/);
  const authorized = client(s.base, { headers: { Authorization: 'Bearer secret' } });
  await authorized.setTrack({ ...SUNNY, uri: 'spotify:track:cccccccccccccccccccccc' });
  assert.equal(authorized.status, '已匹配歌词 · 网易云音乐');

  const down = client('http://127.0.0.1:9', { spotify: async () => ({ lyrics: core.parseLrc(lrc(['a', 'b', 'c']), null, 'spotify'), colors: null }) });
  await down.setTrack(SUNNY);
  assert.equal(down.status, 'Spotify 歌词（歌词服务器不可用）');
});
