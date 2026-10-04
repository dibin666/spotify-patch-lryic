// Request paths of the plugin (src/app.js): always local first — direct, then the local
// service, then (cloud mode only) the lyrics server relay. Runs app.js in a sandbox with a
// fake fetch: no Spotify, no network.
//   node --test tests/net.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreSource = fs.readFileSync(path.join(root, 'src/core.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const SERVER = 'https://lyrics.test', LOCAL = 'http://127.0.0.1:38917';
const REQ = { method: 'GET', url: 'https://music.163.com/api/song/lyric?id=1', headers: { Referer: 'https://music.163.com/' }, body: null };

/* paths: which of direct / local / server work. Returns the plugin's net object and the call log. */
function load({ mode, request, direct = false, local = false, server = true }) {
  const calls = [];
  const reply = (body) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) });
  const fetch = async (url, init = {}) => {
    if (url.startsWith(LOCAL)) {
      calls.push('local' + url.slice(LOCAL.length));
      if (!local) throw new TypeError('Failed to fetch');
      if (url.endsWith('/health')) return reply('{"ok":true,"version":"t","relay":true}');
      return reply(JSON.stringify({ status: 200, body: 'from-local' }));
    }
    if (url.startsWith(SERVER)) {
      calls.push('server' + url.slice(SERVER.length));
      if (!server) throw new TypeError('Failed to fetch');
      if (url.endsWith('/health')) return reply('{"ok":true,"version":"t","relay":true}');
      return reply(JSON.stringify({ status: 200, body: 'from-server' }));
    }
    calls.push('direct');
    if (!direct) throw new TypeError('Failed to fetch'); // CORS
    return reply('from-direct');
  };
  const store = new Map();
  const context = {
    console, fetch, AbortSignal, AbortController, TextDecoder, atob, URL,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    document: { getElementById: () => null, body: { children: [] }, querySelector: () => null, addEventListener() {} },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(coreSource, context);
  vm.runInContext(appSource.replace('__SPOT_LYRIC_SERVER__', SERVER).replace('__SPOT_LYRIC_MODE__', mode)
    .replace('__SPOT_LYRIC_REQUEST__', request).replace('__SPOT_LYRIC_LOCAL__', LOCAL), context);
  return { net: context.__spotLyric.net, calls, spot: context.__spotLyric };
}
const body = r => r.body;

test('direct works: nothing is relayed', async () => {
  const { net, calls } = load({ mode: 'cloud', request: 'direct', direct: true, local: true });
  assert.equal(body(await net.transport(REQ)), 'from-direct');
  assert.deepEqual(calls, ['direct']);
});

test('cloud mode: the local service comes before the lyrics server', async () => {
  const { net, calls } = load({ mode: 'cloud', request: 'service', local: true });
  assert.equal(body(await net.transport(REQ)), 'from-local');
  assert.deepEqual(calls, ['direct', 'local/api/relay']);
  // A blocked direct path is not retried for every request.
  assert.equal(body(await net.transport(REQ)), 'from-local');
  assert.deepEqual(calls.slice(2), ['local/api/relay']);
  assert.equal(net.state.localCount, 2);
  assert.equal(net.state.serverCount, 0);
});

test('cloud mode, even when "server" was chosen: a running local service is still preferred', async () => {
  const { net, calls } = load({ mode: 'cloud', request: 'server', local: true });
  assert.equal(body(await net.transport(REQ)), 'from-local');
  assert.ok(!calls.some(c => c.startsWith('server')));
});

test('cloud mode without local paths: the lyrics server relays; a down service is not probed every time', async () => {
  const { net, calls } = load({ mode: 'cloud', request: 'server' });
  assert.equal(body(await net.transport(REQ)), 'from-server');
  assert.deepEqual(calls, ['direct', 'local/api/relay', 'server/api/relay']);
  assert.equal(body(await net.transport(REQ)), 'from-server');
  assert.deepEqual(calls.slice(3), ['server/api/relay']);
  assert.equal(net.state.serverCount, 2);
});

test('pure local: never the lyrics server, a clear error when nothing local works', async () => {
  for (const mode of ['local', 'direct']) {
    const { net, calls } = load({ mode, request: mode === 'local' ? 'service' : 'direct' });
    await assert.rejects(net.transport(REQ), /本地服务也未运行/);
    assert.ok(!calls.some(c => c.startsWith('server')), mode);
  }
  const { net } = load({ mode: 'local', request: 'service', local: true });
  assert.equal(body(await net.transport(REQ)), 'from-local');
});

test('the request method falls back to the mode for older builds', () => {
  assert.equal(load({ mode: 'direct', request: '__SPOT_LYRIC_REQUEST__' }).spot.request, 'direct');
  assert.equal(load({ mode: 'local', request: 'x' }).spot.request, 'service');
  assert.equal(load({ mode: 'cloud', request: '' }).spot.request, 'server');
});
