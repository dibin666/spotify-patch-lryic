// Run: node --test tests/   (set SPOT_LYRIC_OFFLINE=1 to skip live provider tests)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../src/core.js');
import { MemoryStore } from './memory-store.mjs';


test('normalize and similarity', () => {
  assert.equal(core.normalize('  Hello,  World!! (Live) '), 'hello world live');
  assert.equal(core.normalize('Ｆｕｌｌ－ｗｉｄｔｈ'), 'full width');
  assert.equal(core.textSimilarity('晴天', '晴天'), 1);
  assert.ok(core.textSimilarity('kitten', 'sitting') > 0.5);
  assert.equal(core.textSimilarity('', 'x'), 0);
  assert.equal(core.titleBase('Song (feat. Someone)'), 'Song');
  assert.equal(core.titleBase('Song - 2011 Remaster'), 'Song');
  assert.equal(core.titleSimilarity('告白气球 / Love Confession', 'Love Confession'), 1);
  assert.notEqual(core.versionFlags('Song (Live)'), core.versionFlags('Song'));
  assert.equal(core.versionFlags('Oliver'), 0, 'substring "live" inside a word is not a version flag');
});

test('match scoring and selection mirrors spot-lyric rules', () => {
  const track = { title: '晴天', artists: ['周杰伦'], album: '叶惠美', duration_ms: 269000 };
  const good = core.matchScore(track, { provider: 'qq', id: '1', title: '晴天', artists: ['周杰伦'], album: '叶惠美', duration_ms: 269500 });
  assert.ok(good.eligible, good.reason);
  const long = core.matchScore(track, { provider: 'qq', id: '2', title: '晴天', artists: ['周杰伦'], album: '叶惠美', duration_ms: 275000 });
  assert.equal(long.eligible, false); assert.equal(long.reason, '总时长相差超过 3 秒');
  const live = core.matchScore(track, { provider: 'netease', id: '3', title: '晴天 (Live)', artists: ['周杰伦'], album: '叶惠美', duration_ms: 269000 });
  assert.equal(live.reason, '歌曲版本不一致');
  const cover = core.matchScore(track, { provider: 'netease', id: '4', title: '晴天', artists: ['Lucky小爱'], album: '', duration_ms: 269000 });
  assert.equal(cover.reason, '主艺术家不匹配');
  assert.ok(live.score < 70, 'a different version never looks like a near-perfect result');
  const list = core.matchSort([cover, long, good, live], 'netease');
  assert.equal(list[0], good);
  assert.equal(core.matchSelect(list), good);
  // Every eligible candidate is the same song: the best one is taken (LDDC / Lyricify), no refusal on near-ties.
  const other = core.matchScore(track, { provider: 'netease', id: '5', title: '晴天', artists: ['周杰伦'], album: '叶惠美', duration_ms: 271000 });
  assert.ok(other.eligible && other.score < good.score);
  assert.equal(core.matchSelect([other, good]), good);
  // The preferred source wins when it is within 10 points of the best.
  assert.equal(core.matchSelect([other, good], 'netease'), other);
  const weak = core.matchScore(track, { provider: 'netease', id: '6', title: '晴天', artists: ['周杰伦'], album: '最佳精选', duration_ms: 271900 });
  assert.ok(weak.eligible && good.score - weak.score > 10, `${good.score} vs ${weak.score}`);
  assert.equal(core.matchSelect([weak, good], 'netease'), good);
  assert.equal(core.matchSelect([cover, long, live]), null);
});

test('matching: traditional / simplified, artist order, CV aliases, featured + remaster notes, QQ seconds', () => {
  const ok = (track, candidate) => core.matchScore({ album: '', ...track }, { provider: 'netease', id: '1', album: '', ...candidate });
  // Spotify often ships Taiwanese metadata.
  assert.equal(core.normalize('說好的幸福呢'), '说好的幸福呢');
  const t2s = ok({ title: '說好的幸福呢', artists: ['周杰倫'], album: '魔杰座', duration_ms: 255000 }, { title: '说好的幸福呢', artists: ['周杰伦'], album: '魔杰座', duration_ms: 255300 });
  assert.ok(t2s.eligible && t2s.score > 95, t2s.reason);
  // Artist order does not matter; the main artist must be present.
  assert.equal(core.artistSimilarity(['A', 'B'], ['B', 'A']), 1);
  assert.ok(core.artistSimilarity(['A'], ['A', 'Guest']) > 0.9);
  assert.ok(core.artistSimilarity(['A', 'Guest'], ['Guest']) < 0.75, 'a guest cannot replace the main artist');
  // "角色 (CV: 声优)" and combined "A/B" entries.
  assert.equal(core.artistSimilarity(['青山吉能'], ['後藤ひとり (CV:青山吉能)']), 1);
  assert.ok(core.artistSimilarity(['Ado'], ['Ado/初音ミク']) > 0.9);
  // Neutral notes are ignored, version notes are not.
  const feat = ok({ title: 'Song (feat. B) - 2011 Remaster', artists: ['A', 'B'], album: 'X (Deluxe Edition)', duration_ms: 200000 }, { title: 'Song', artists: ['A'], album: 'X', duration_ms: 200400 });
  assert.ok(feat.eligible, feat.reason);
  assert.equal(core.titleCore('勇者 (TV动画《葬送的芙莉莲》片头曲)'), '勇者');
  assert.equal(core.titleCore('Song - From "The Movie"'), 'Song');
  assert.equal(ok({ title: 'Song - Original Mix', artists: ['A'], duration_ms: 1000 }, { title: 'Song', artists: ['A'], duration_ms: 1000 }).eligible, true);
  assert.equal(ok({ title: 'Song', artists: ['A'], duration_ms: 1000 }, { title: 'Song (Piano Ver.)', artists: ['A'], duration_ms: 1000 }).reason, '歌曲版本不一致');
  assert.equal(ok({ title: 'Song', artists: ['A'], duration_ms: 1000 }, { title: 'Song (Off Vocal)', artists: ['A'], duration_ms: 1000 }).reason, '歌曲版本不一致');
  // Provider aliases (NetEase transNames / alias, QQ subtitle).
  const alias = ok({ title: 'Racing Into The Night', artists: ['YOASOBI'], duration_ms: 261000 }, { title: '夜に駆ける', aliases: ['Racing Into The Night'], artists: ['YOASOBI'], duration_ms: 261013 });
  assert.ok(alias.eligible, alias.reason);
  // QQ only reports whole seconds.
  assert.equal(core.durationDelta(269765, { provider: 'qq', duration_ms: 269000 }), 0);
  assert.equal(core.durationDelta(269765, { provider: 'netease', duration_ms: 269000 }), 765);
  assert.deepEqual([0, 200, 600, 1200, 3000, 4000].map(core.durationScore), [1, 0.95, 0.9, 0.8, 0.55, 0]);
  // Names in different scripts are reported as such (lyric check / manual choice).
  assert.match(ok({ title: '十年', artists: ['Eason Chan'], duration_ms: 205000 }, { title: '十年', artists: ['陈奕迅'], duration_ms: 205423 }).reason, /语言不同/);
  // Widening query cascade.
  assert.deepEqual(core.searchQueries({ title: 'Song (feat. B)', artists: ['A', 'B'] }).map(q => [q.text, q.titleOnly]),
    [['Song (feat. B) A', false], ['Song A', false], ['Song', true]]);
});

test('sanitizeLyrics keeps the known shape only', () => {
  const clean = core.sanitizeLyrics({ source: 'evil', sync_type: 'word', x: 1, lines: [
    { text: 'b', start_time_ms: 2000, end_time_ms: 1, words: [{ text: 'b', start_time_ms: 2000, end_time_ms: 2500, y: 2 }] },
    { text: 'a\u0000', start_time_ms: 1000, end_time_ms: 2000, translated_text: '甲', words: 'nope' }, null] });
  assert.equal(clean.source, 'local');
  assert.equal(clean.x, undefined);
  assert.deepEqual(clean.lines.map(l => [l.text, l.start_time_ms, l.end_time_ms, l.translated_text]), [['a', 1000, 2000, '甲'], ['b', 2000, 2000, undefined]]);
  assert.deepEqual(clean.lines[1].words, [{ text: 'b', start_time_ms: 2000, end_time_ms: 2500 }]);
  assert.equal(core.sanitizeLyrics({ lines: [{ text: '' }] }), null);
});

test('LRC parsing: multi stamps, offset, enhanced words, translation', () => {
  const lrc = '[offset:500]\n[00:01.00][00:05.00]repeat\n[00:03.000]<00:03.000>he<00:03.500>llo<00:04.000>\n[ar:x]';
  const tr = '[00:01.10]重复\n[00:03.00]你好';
  const ly = core.parseLrc(lrc, tr, 'netease');
  assert.equal(ly.sync_type, 'word');
  assert.deepEqual(ly.lines.map(l => [l.text, l.start_time_ms]), [['repeat', 500], ['hello', 2500], ['repeat', 4500]]);
  assert.equal(ly.lines[0].translated_text, '重复');
  assert.equal(ly.lines[1].translated_text, '你好');
  assert.deepEqual(ly.lines[1].words.map(w => [w.text, w.start_time_ms, w.end_time_ms]), [['he', 2500, 3000], ['llo', 3000, 3500]]);
  assert.equal(ly.lines[2].end_time_ms, 14500);
  assert.equal(core.lyricsIndex(ly, 0), -1);
  assert.equal(core.lyricsIndex(ly, 2600), 1);
  const plain = core.parseLrc('first line\n\nsecond line', null, 'local');
  assert.equal(plain.sync_type, 'unsynced'); assert.equal(plain.lines.length, 2);
  assert.ok(core.exportLrc(ly).startsWith('[00:00.500]repeat\n[00:02.500]<00:02.500>he<00:03.000>llo<00:03.500>\n'));
  assert.equal(core.lyricsUsable(core.parseLrc('', null, 'x')), false);
});

test('Spotify color-lyrics conversion', () => {
  const ly = core.spotifyLyrics({ lyrics: { syncType: 'LINE_SYNCED', provider: 'MusixMatch', providerDisplayName: 'Musixmatch', lines: [
    { startTimeMs: '1000', words: 'a', endTimeMs: '0', syllables: [] }, { startTimeMs: '2500', words: 'b', endTimeMs: '0', syllables: [] }] } });
  assert.equal(ly.sync_type, 'line');
  assert.deepEqual(ly.lines.map(l => [l.text, l.start_time_ms, l.end_time_ms]), [['a', 1000, 2500], ['b', 2500, 12500]]);
  assert.equal(ly.provider_name, 'Musixmatch');
});

test('provider candidates and requests', () => {
  const ne = core.providerCandidates('netease', { code: 200, result: { songs: [{ id: 1, name: 'A', duration: 1000, artists: [{ name: 'X' }], album: { name: 'Al' } }, { id: 1, name: 'dup' }] } });
  assert.deepEqual(ne, [{ provider: 'netease', id: '1', mid: '', title: 'A', album: 'Al', duration_ms: 1000, artists: ['X'], aliases: [] }]);
  const aliased = core.providerCandidates('netease', { result: { songs: [{ id: 2, name: '夜に駆ける', alias: [], transNames: ['向夜晚奔去'], duration: 1, artists: [] }] } });
  assert.deepEqual(aliased[0].aliases, ['向夜晚奔去']);
  assert.deepEqual(core.candidateFromJson(core.candidateJson(aliased[0])).aliases, ['向夜晚奔去']);
  const qq = core.providerCandidates('qq', { req_1: { data: { body: { song: { list: [{ id: 9, mid: 'm9', title: 'B', interval: 200, singer: [{ name: 'Y' }], album: { title: 'Bl' }, group: [{ id: 10, mid: 'm10', title: 'B', interval: 201, singer: [{ name: 'Y' }], album: { name: 'Bl2' } }] }] } } } } });
  assert.equal(qq.length, 2); assert.equal(qq[1].album, 'Bl2'); assert.equal(qq[0].duration_ms, 200000);
  assert.match(core.searchRequest('netease', 'https://music.163.com/#/song?id=186001').url, /song\/detail\/\?id=186001/);
  assert.match(core.searchRequest('qq', 'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV').body, /songmid=0039MnYb0qxYhV/);
  assert.throws(() => core.parseProviderBody('qq', '{"code":0,"req_1":{"code":500}}'), /错误码 500/);
  assert.equal(core.parseProviderBody('qq', 'cb({"code":0,"data":[]})').code, 0);
  assert.equal(core.decodeLyric(Buffer.from('[00:01.00]你好').toString('base64')), '[00:01.00]你好');
});

test('provider lyric responses: yrc, placeholders, QQ "no lyric" codes', () => {
  // NetEase v1: JSON credit lines are dropped, yrc gives word timing, ytlrc the translation.
  const v1 = { code: 200,
    lrc: { lyric: '{"t":0,"c":[{"tx":"作词: "},{"tx":"X"}]}\n[00:20.570]初めてのルーブルは\n' },
    yrc: { lyric: '{"t":0,"c":[{"tx":"作词: "},{"tx":"X"}]}\n[20570,1900](20570,360,0)初(20930,150,0)め(21080,120,0)て(21200,170,0)の(21370,700,0)(ルーブル)\n[22760,2130](22760,210,0)な(22970,160,0)ん\n' },
    ytlrc: { lyric: '[00:20.570]第一次去卢浮宫时\n[00:22.760]//\n' } };
  const ly = core.lyricsFromResponse('netease', v1);
  assert.equal(ly.sync_type, 'word');
  assert.deepEqual(ly.lines.map(l => [l.text, l.start_time_ms, l.end_time_ms]), [['初めての(ルーブル)', 20570, 22470], ['なん', 22760, 24890]]);
  assert.deepEqual(ly.lines[0].words.at(-1), { text: '(ルーブル)', start_time_ms: 21370, end_time_ms: 22070 });
  assert.equal(ly.lines[0].translated_text, '第一次去卢浮宫时');
  assert.equal(ly.lines[1].translated_text, undefined, '"//" placeholder translations are ignored');
  // Without yrc the LRC (minus JSON lines) is used.
  const lineOnly = core.lyricsFromResponse('netease', { code: 200, lrc: v1.lrc });
  assert.deepEqual(lineOnly.lines.map(l => l.text), ['初めてのルーブルは']);
  // Placeholders are not lyrics.
  assert.equal(core.lyricsFromResponse('netease', { code: 200, uncollected: true, lrc: { lyric: '' } }).note, 'uncollected');
  const credits = core.lyricsFromResponse('netease', { code: 200, lrc: { lyric: '[00:00.00] 作词 : TRUE\n[00:01.00] 作曲 : 新田目 翔\n' } });
  assert.equal(credits.note, 'credits'); assert.equal(core.lyricsUsable(credits), false);
  assert.equal(core.lyricsFromResponse('netease', { code: 200, lrc: { lyric: '{"t":-1,"c":[{"tx":"作词: "},{"tx":"TRUE"}]}\n' } }).note, 'credits');
  assert.equal(core.lyricsFromResponse('netease', { code: 200, lrc: { lyric: '[99:00.00]纯音乐，请欣赏\n' } }).note, 'instrumental');
  // QQ: 24001 (GetPlayLyricInfo) and -1901 (legacy endpoint) mean "no lyric", not a service error.
  const none = core.parseProviderBody('qq', '{"code":0,"req_1":{"code":24001,"data":{"lyric":""}}}');
  assert.equal(core.lyricsFromResponse('qq', none).note, 'missing');
  assert.equal(core.lyricsFromResponse('qq', core.parseProviderBody('qq', '{"retcode":-1901,"code":-1901,"subcode":-1901}')).note, 'missing');
  const legacy = core.parseProviderBody('qq', JSON.stringify({ retcode: 0, code: 0, lyric: Buffer.from('[00:01.00]你好').toString('base64'), trans: '' }));
  assert.equal(core.lyricsFromResponse('qq', legacy).lines[0].text, '你好');
  assert.equal(core.fetchRequests({ provider: 'qq', id: '1', mid: 'm' }).length, 2);
  assert.match(core.fetchRequests({ provider: 'netease', id: '9' })[0].url, /\/api\/song\/lyric\/v1\?id=9/);
});

test('kana titles match their romaji spelling; QQ translated-title notes are ignored', () => {
  assert.equal(core.romanize('ぎゅって'), 'gyutte');
  assert.equal(core.romanize('シャルル'), 'sharuru');
  assert.equal(core.romanize('ファンファーレ'), 'fanfaare');
  assert.equal(core.romanize('ちょっと'), 'chotto');
  assert.equal(core.textSimilarity('ヨルシカ', 'Yorushika'), 1);
  const track = { title: 'gyutte', artists: ['MIMI'], album: 'gyutte', duration_ms: 122000 };
  const kana = core.matchScore(track, { provider: 'netease', id: '1', title: 'ぎゅって', artists: ['MIMI', '初音ミク'], album: 'ぎゅって', duration_ms: 122100 });
  const qq = core.matchScore(track, { provider: 'qq', id: '2', title: 'ぎゅって (紧紧拥住)', artists: ['MIMI'], album: 'ぎゅって', duration_ms: 122000 });
  const other = core.matchScore(track, { provider: 'netease', id: '3', title: "Athena's Paragraph", artists: ['MIMI'], album: '', duration_ms: 122200 });
  assert.ok(kana.eligible, kana.reason); assert.ok(qq.eligible, qq.reason);
  assert.equal(other.eligible, false, 'same artist + same length alone is not enough');
  assert.equal(core.matchScore(track, { provider: 'qq', id: '4', title: 'ぎゅって (Live)', artists: ['MIMI'], album: '', duration_ms: 122000 }).reason, '歌曲版本不一致');
});

test('engine: lyric-content check against Spotify lyrics (offline)', async () => {
  const words = ['言えないことばかり増えてくから', '後悔多めの今日の数', '数えた最後の夜の隅', 'どうか触れちゃうなら抱きしめて', '解けないことばかり知ってくから'];
  const lrc = list => list.map((t, i) => `[00:${String(10 + i * 3).padStart(2, '0')}.00]${t}`).join('\n');
  const songs = { 11: { id: 11, name: '夜に駆ける', duration: 261000, artists: [{ name: 'YOASOBI' }], album: { name: '' } },
                  12: { id: 12, name: 'ハルジオン', duration: 261500, artists: [{ name: 'YOASOBI' }], album: { name: '' } } };
  const lyricsFor = { 11: lrc(words), 12: lrc(['全然違う歌詞の一行目', '二行目も違う', '三行目も違う', '四行目も違う', '五行目']) };
  const make = (spotifyLines) => {
    const store = new MemoryStore();
    const calls = [];
    const http = new core.Http(async (req) => {
      calls.push(req.url);
      if (req.url.includes('/search/')) return { status: 200, body: JSON.stringify({ code: 200, result: { songs: [songs[12], songs[11]] } }) };
      if (req.url.includes('u.y.qq.com')) return { status: 200, body: JSON.stringify({ code: 0, req_1: { code: 0, data: { body: { song: { list: [] } } } } }) };
      const id = /id=(\d+)/.exec(req.url)[1];
      return { status: 200, body: JSON.stringify({ code: 200, lrc: { lyric: lyricsFor[id] } }) };
    });
    const spotify = async () => ({ lyrics: core.parseLrc(lrc(spotifyLines), null, 'spotify'), colors: { background: 'x' } });
    return { calls, store, engine: new core.Engine({ store, http, spotify, settings: () => ({ preferred_provider: 'netease', verify_lyrics: true }) }) };
  };
  const track = { uri: 'spotify:track:bbbbbbbbbbbbbbbbbbbbbb', title: 'Yoru ni Kakeru', artists: ['YOASOBI'], album: '', duration_ms: 261000 };
  const ok = make(words);
  await ok.engine.setTrack(track);
  assert.equal(ok.engine.status, '已匹配歌词 · 网易云音乐（歌词比对 100%）');
  assert.equal(ok.engine.lyrics.source, 'netease');
  assert.equal(ok.engine.colors.background, 'x', 'Spotify colours are kept');
  // The verified binding survives re-scoring and is served from cache next time.
  const again = new core.Engine({ store: ok.store, http: new core.Http(async () => { throw new Error('no network'); }), settings: () => ({ preferred_provider: 'netease', verify_lyrics: true }) });
  await again.setTrack(track);
  assert.equal(again.status, '歌词缓存');
  // Different lyric text: never auto-bound, Spotify lyrics are shown instead.
  const bad = make(['完全に別の歌です', 'ほかの行', 'さらに別の行', 'もう一行', '最後の行']);
  await bad.engine.setTrack(track);
  assert.equal(bad.engine.status, 'Spotify 歌词');
});

function fakeEngine(responder, settings = {}) {
  const store = new MemoryStore();
  const calls = [];
  const http = new core.Http(async (req) => { calls.push(req); return responder(req); });
  const engine = new core.Engine({ store, http, settings: () => ({ preferred_provider: 'netease', spotify_first: false, ...settings }), spotify: null });
  return { store, http, engine, calls };
}

test('engine: automatic match, caching and negative cache (offline)', async () => {
  const song = { id: 7, name: '晴天', duration: 269000, artists: [{ name: '周杰伦' }], album: { name: '叶惠美' } };
  const { engine, calls, store } = fakeEngine((req) => {
    if (req.url.includes('/search/')) return { status: 200, body: JSON.stringify({ code: 200, result: { songs: [song] } }) };
    if (req.url.includes('/song/lyric')) return { status: 200, body: JSON.stringify({ code: 200, lrc: { lyric: '[00:01.00]故事的小黄花' }, tlyric: { lyric: '' } }) };
    if (req.url.includes('u.y.qq.com')) return { status: 200, body: JSON.stringify({ code: 0, req_1: { code: 0, data: { body: { song: { list: [] } } } } }) };
    return { status: 404, body: '' };
  });
  const track = { uri: 'spotify:track:0123456789abcdefghijkl', title: '晴天', artists: ['周杰伦'], album: '叶惠美', duration_ms: 269000 };
  await engine.setTrack(track);
  assert.equal(engine.status, '已匹配歌词 · 网易云音乐');
  assert.equal(engine.lyrics.lines[0].text, '故事的小黄花');
  assert.equal(calls.length, 3, 'both sources searched together, one lyric download');
  assert.equal(engine.match.id, '7');
  // Same track again from a fresh engine with the same store: served from cache.
  const again = new core.Engine({ store, http: new core.Http(async () => { throw new Error('no network expected'); }), settings: () => ({ preferred_provider: 'netease' }) });
  await again.setTrack(track);
  assert.equal(again.status, '歌词缓存');
  // Unknown track: both providers searched, nothing eligible -> negative cache.
  const unknown = { uri: 'spotify:track:zzzzzzzzzzzzzzzzzzzzzz', title: 'Nope', artists: ['Nobody'], album: '', duration_ms: 1000 };
  await engine.setTrack(unknown);
  assert.equal(engine.status, '未匹配，可手动选择歌词');
  const before = calls.length;
  await engine.setTrack(track); await engine.setTrack(unknown);
  assert.equal(calls.length, before, 'negative cache prevents new requests');
  // Offsets are clamped and stored per track.
  engine.setOffset(9000, false); assert.equal(engine.offset(), 5000);
});

test('engine: manual search, bind and unbind (offline)', async () => {
  const { engine } = fakeEngine((req) => {
    if (req.url.includes('/search/')) return { status: 200, body: JSON.stringify({ code: 200, result: { songs: [{ id: 1, name: 'Other', duration: 5000, artists: [{ name: 'Z' }], album: { name: '' } }] } }) };
    if (req.url.includes('u.y.qq.com')) return { status: 500, body: 'oops' };
    if (req.url.includes('/song/lyric')) return { status: 200, body: JSON.stringify({ code: 200, lrc: { lyric: '[00:01.00]bound line' } }) };
    return { status: 404, body: '' };
  });
  const track = { uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa', title: 'Mine', artists: ['Me'], album: '', duration_ms: 5000 };
  await engine.setTrack(track);
  const result = await engine.search('Other Z');
  assert.equal(result.providers[0].candidates.length, 1);
  assert.ok(result.providers[1].error, 'qq failure is reported per provider');
  const candidate = result.providers[0].candidates[0];
  const preview = await engine.preview(candidate);
  const bound = await engine.bind(candidate, preview);
  assert.equal(engine.status, '已绑定歌词 · 网易云音乐');
  assert.match(bound.error, /未配置歌词服务器/, 'no lyrics server: bound on this machine only');
  await engine.setTrack({ ...track, title: 'x' }); await engine.setTrack(track);
  assert.equal(engine.status, '已绑定歌词 · 缓存');
  assert.equal((await engine.search('Other Z')).providers[0].candidates[0].bound, true);
});

test('engine: cross-script artists are confirmed by lyric text; instrumental is a final answer (offline)', async () => {
  const lrc = list => list.map((t, i) => `[00:${String(10 + i * 3).padStart(2, '0')}.00]${t}`).join('\n');
  const LINES = ['如果那两个字没有颤抖', '我不会发现我难受', '怎么说出口', '也不过是分手', '如果对于明天没有要求'];
  const queries = [];
  const { engine } = fakeEngine((req) => {
    if (req.url.includes('/search/')) {
      queries.push(decodeURIComponent(/s=([^&]*)/.exec(req.url)[1]));
      return { status: 200, body: JSON.stringify({ code: 200, result: { songs: [
        { id: 66842, name: '十年', duration: 205423, artists: [{ name: '陈奕迅' }], album: { name: '黑白灰' } },
        { id: 9, name: 'Ten Years', duration: 130000, artists: [{ name: 'Someone' }], album: { name: '' } }] } }) };
    }
    if (req.url.includes('u.y.qq.com')) return { status: 200, body: JSON.stringify({ code: 0, req_1: { code: 0, data: { body: { song: { list: [] } } } } }) };
    return { status: 200, body: JSON.stringify({ code: 200, lrc: { lyric: lrc(LINES) } }) };
  });
  engine.deps.spotify = async () => ({ lyrics: core.parseLrc(lrc(LINES), null, 'spotify'), colors: null });
  engine.deps.settings = () => ({ preferred_provider: 'netease', verify_lyrics: true });
  await engine.setTrack({ uri: 'spotify:track:cccccccccccccccccccccc', title: 'Ten Years', artists: ['Eason Chan'], album: 'Black, White & Grey', duration_ms: 205000 });
  assert.equal(engine.status, '已匹配歌词 · 网易云音乐（歌词比对 100%）');
  assert.equal(engine.match.id, '66842');
  assert.ok(queries.includes('ten years'), 'title-only query runs when nothing was eligible');

  const inst = fakeEngine((req) => {
    if (req.url.includes('/search/')) return { status: 200, body: JSON.stringify({ code: 200, result: { songs: [{ id: 5, name: 'Interlude', duration: 90000, artists: [{ name: 'A' }], album: { name: '' } }] } }) };
    if (req.url.includes('u.y.qq.com')) return { status: 200, body: JSON.stringify({ code: 0, req_1: { code: 0, data: { body: { song: { list: [] } } } } }) };
    return { status: 200, body: JSON.stringify({ code: 200, nolyric: true }) };
  });
  await inst.engine.setTrack({ uri: 'spotify:track:dddddddddddddddddddddd', title: 'Interlude', artists: ['A'], album: '', duration_ms: 90000 });
  assert.equal(inst.engine.status, '纯音乐，没有歌词');
  assert.equal(inst.calls.filter(r => r.url.includes('/song/lyric')).length, 1, 'no further candidates are tried');
});

const live = process.env.SPOT_LYRIC_OFFLINE ? test.skip : test;
live('live: NetEase + QQ search, scoring, lyrics and automatic matching through real APIs', async () => {
  /* The lyrics server's own upstream transport (allow-list, NetEase X-Real-IP, pacing). */
  const { createTransport } = require('../server/src/upstream.js');
  const transport = createTransport({ neteaseRealIp: '211.161.244.70' });
  const engine = new core.Engine({ store: new MemoryStore(), http: new core.Http(transport), settings: () => ({ preferred_provider: 'qq' }) });
  const track = { uri: 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh', title: '晴天', artists: ['周杰伦'], album: '叶惠美', duration_ms: 269000 };
  await engine.setTrack(track);
  const terminal = ['已匹配歌词 · QQ 音乐', '已匹配歌词 · 网易云音乐', '未匹配，可手动选择歌词', '请求失败，可手动重试', '来源暂不可用，60 秒后可重试'];
  assert.ok(terminal.includes(engine.status), engine.status);
  console.log(`  automatic: ${engine.status}${engine.lyrics ? `, ${engine.lyrics.lines.length} lines` : ''}`);
  const manual = await engine.search('晴天 周杰伦');
  for (const group of manual.providers) console.log(`  ${group.provider}: ${group.error || group.candidates.length + ' candidates, ' + group.candidates.filter(c => c.eligible).length + ' eligible'}`);
  const best = manual.candidates.find(c => c.eligible);
  assert.ok(best, 'at least one eligible candidate across providers');
  const lyrics = await engine.preview(best);
  assert.ok(core.lyricsUsable(lyrics) && lyrics.sync_type !== 'unsynced', 'synced lyrics for the best candidate');
  console.log(`  preview ${best.provider}:${best.id} -> ${lyrics.lines.length} lines (${lyrics.sync_type})`);
});
