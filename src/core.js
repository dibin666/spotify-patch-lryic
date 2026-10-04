/*
 * Spot-Lyric core — JavaScript port of spot-lyric (src/match.c, src/model.c,
 * src/providers.c, src/http.c, src/engine.c).  Pure logic: no DOM access.
 * Network, storage and Spotify access are injected so the same engine runs
 * inside the Spotify renderer and under the Node test-suite.
 */
(function (root) {
  'use strict';

  const DURATION_TOLERANCE = 3000;
  /* Bumped when the stored lyrics format changes (v3: translation merge skips blank lines). */
  const LYRICS_CACHE = 'lyrics4', TRACK_CACHE = 'tracklyrics3:';
  const MAX_RESPONSE = 2 * 1024 * 1024;
  const PROVIDERS = ['netease', 'qq'];
  const PROVIDER_NAMES = { netease: '网易云音乐', qq: 'QQ 音乐', spotify: 'Spotify', local: '本地文件' };

  /* ------------------------------------------------------------ text ---- */
  const WORD_RUN = /[\p{L}\p{N}\p{M}]+/gu;
  function normalize(text) {
    if (typeof text !== 'string' || !text) return '';
    const runs = text.normalize('NFKC').toLowerCase().match(WORD_RUN);
    return runs ? runs.join(' ') : '';
  }
  /* Kana -> Hepburn-style romaji so 「ぎゅって」 meets "gyutte" and 「ヨルシカ」 "Yorushika". */
  const KANA = {
    あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o', か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko', が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
    さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo', た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
    だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do', な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no', は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
    ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo', ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po', ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
    や: 'ya', ゆ: 'yu', よ: 'yo', ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro', わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n', ゔ: 'vu', ゎ: 'wa',
  };
  const SMALL_Y = { ゃ: 'ya', ゅ: 'yu', ょ: 'yo' }, SMALL_V = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o' };
  const HAS_KANA = /[\u3041-\u30ff]/;
  function romanize(text) {
    let out = '', double = false;
    for (let ch of String(text)) {
      const code = ch.charCodeAt(0);
      if (code >= 0x30a1 && code <= 0x30f6) ch = String.fromCharCode(code - 0x60); // katakana -> hiragana
      if (ch === 'っ') { double = true; continue; }
      if (ch === 'ー') { const v = /[aeiou]$/.exec(out); if (v) out += v[0]; continue; }
      if (SMALL_Y[ch] && /[a-z]i$/.test(out)) { out = /(sh|ch|j)i$/.test(out) ? out.slice(0, -1) + SMALL_Y[ch].slice(1) : out.slice(0, -1) + SMALL_Y[ch]; continue; }
      if (SMALL_V[ch] && /[a-z][aeiou]$/.test(out)) { out = out.slice(0, -1) + SMALL_V[ch]; continue; }
      let roman = KANA[ch] || SMALL_Y[ch] || SMALL_V[ch];
      if (roman === undefined) { out += ch; double = false; continue; }
      if (double) { out += roman.startsWith('ch') ? 't' : roman[0]; double = false; }
      out += roman;
    }
    return out;
  }
  /* Romaji spellings vary (ō/ou/o, wo/o): compare without diacritics and doubled vowels. */
  const latinKey = text => normalize(text).normalize('NFD').replace(/\p{M}+/gu, '').replace(/([aeiou])\1+/g, '$1').replace(/ou/g, 'o').replace(/ /g, '');
  function textSimilarity(left, right) {
    const base = editSimilarity(normalize(left), normalize(right));
    if (base === 1 || !(HAS_KANA.test(left || '') || HAS_KANA.test(right || ''))) return base;
    return Math.max(base, editSimilarity(latinKey(romanize(normalize(left))), latinKey(romanize(normalize(right)))));
  }
  function editSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const ac = Array.from(a), bc = Array.from(b);
    /* Bound malicious provider metadata and the quadratic edit-distance work. */
    if (ac.length > 512 || bc.length > 512) return 0;
    const row = new Uint32Array(bc.length + 1);
    for (let j = 0; j <= bc.length; j++) row[j] = j;
    for (let i = 1; i <= ac.length; i++) {
      let previous = row[0]; row[0] = i;
      for (let j = 1; j <= bc.length; j++) {
        const old = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (ac[i - 1] !== bc[j - 1] ? 1 : 0));
        previous = old;
      }
    }
    return 1 - row[bc.length] / Math.max(ac.length, bc.length);
  }
  const VERSION_PATTERNS = [
    /(^|[^a-z])(live|concert)([^a-z]|$)|现场|現場|演唱会|演唱會/,
    /(^|[^a-z])(cover)([^a-z]|$)|翻唱/,
    /(^|[^a-z])(instrumental|karaoke)([^a-z]|$)|伴奏|纯音乐|純音樂/,
    /(^|[^a-z])(remix|mix)([^a-z]|$)|混音/,
    /sped[ -]?up|slowed|加速|慢速/,
    /radio[ -]?edit|tv[ -]?(size|edit)|short[ -]?version|剪辑|剪輯/,
    /(^|[^a-z])acoustic([^a-z]|$)|不插电|不插電/,
  ];
  function versionFlags(title) {
    const lower = String(title || '').toLowerCase();
    let result = 0;
    VERSION_PATTERNS.forEach((pattern, i) => { if (pattern.test(lower)) result |= 1 << i; });
    return result;
  }
  const FEATURED_TAIL = /\s*(?:[（(]\s*(?:feat\.?|ft\.?|featuring)\s+.*[）)]|[-–—]\s*(?:feat\.?|ft\.?)\s+.*)$/i;
  const REMASTER_TAIL = /\s*(?:[-–—]\s*|[（(])(?:[0-9]{4}\s+)?remaster(?:ed)?(?:\s+[0-9]{4})?[）)]?\s*$/i;
  const FEATURED_PAREN = /\s*[（(](?:feat\.?|ft\.?|featuring)\s+.*[）)]/gi;
  function titleBase(title) {
    if (!title) return '';
    return String(title).replace(FEATURED_TAIL, '').replace(REMASTER_TAIL, '');
  }
  /* Trailing bracketed notes such as QQ's translated titles 「ぎゅって (紧紧拥住)」.
   * Version markers (Live/Remix/…) are still compared on the full title. */
  const TRAILING_NOTE = /\s*[（(【\[][^（()）【】\[\]]*[）)】\]]\s*$/;
  function titleSimilarity(left, right) {
    const a = titleBase(left), b = titleBase(right);
    let best = textSimilarity(a, b);
    const at = a.replace(TRAILING_NOTE, ''), bt = b.replace(TRAILING_NOTE, '');
    if ((at !== a || bt !== b) && at && bt) best = Math.max(best, textSimilarity(at, bt));
    /* Dual-language aliases are accepted only when explicitly delimited. */
    const av = a.split(' / '), bv = b.split(' / ');
    if (av.length > 1 || bv.length > 1) for (const x of av) for (const y of bv) best = Math.max(best, textSimilarity(x, y));
    return best;
  }
  function artistSimilarity(left, right) {
    if (!left || !left.length || !right || !right.length) return 0;
    const principal = textSimilarity(left[0], right[0]);
    /* A shared guest performer cannot substitute for the main artist. */
    if (principal < 0.75) return principal;
    let sum = 0;
    for (const l of left) { let best = 0; for (const r of right) best = Math.max(best, textSimilarity(l, r)); sum += best; }
    return 0.85 * principal + 0.15 * sum / left.length;
  }

  /* ----------------------------------------------------------- match ---- */
  function matchScore(track, candidate) {
    const c = candidate;
    c.eligible = false; c.score = 0;
    c.delta_ms = track.duration_ms > 0 && c.duration_ms > 0 ? Math.abs(track.duration_ms - c.duration_ms) : -1;
    c.title_score = titleSimilarity(track.title, c.title);
    c.artist_score = artistSimilarity(track.artists, c.artists);
    c.album_score = textSimilarity(track.album, c.album);
    c.duration_score = c.delta_ms < 0 ? 0 : Math.max(0, 1 - c.delta_ms / 3000);
    const album = !!(track.album && c.album);
    c.score = (45 * c.title_score + 30 * c.artist_score + (album ? 15 * c.album_score : 0) + 10 * c.duration_score) / (album ? 1 : 0.85);
    let reason;
    if (c.delta_ms < 0) reason = '总时长未知';
    else if (c.delta_ms > DURATION_TOLERANCE) reason = '总时长相差超过 3 秒';
    else if (versionFlags(track.title) !== versionFlags(c.title)) reason = '歌曲版本不一致';
    else if (c.title_score < 0.8) reason = '歌名相似度不足';
    else if (c.artist_score < 0.75) reason = '主艺术家不匹配';
    else if (c.score < 85) reason = '综合匹配分数不足';
    else { c.eligible = true; reason = '通过歌名、艺术家、专辑和时长检查'; }
    c.reason = reason;
    return c;
  }
  const strcmp = (a, b) => (a || '') < (b || '') ? -1 : (a || '') > (b || '') ? 1 : 0;
  function matchSort(candidates, preferred) {
    return candidates.sort((l, r) => {
      if (l.eligible !== r.eligible) return l.eligible ? -1 : 1;
      if (Math.abs(l.score - r.score) > 0.0001) return l.score > r.score ? -1 : 1;
      const lp = l.provider === preferred, rp = r.provider === preferred;
      if (lp !== rp) return lp ? -1 : 1;
      return strcmp(l.id, r.id);
    });
  }
  /* loose (opt-in, not in spot-lyric): a missing album is "unknown", not "different". */
  function sameRecording(l, r, loose) {
    if (Math.abs(l.duration_ms - r.duration_ms) > 1000 || versionFlags(l.title) !== versionFlags(r.title)) return false;
    return titleSimilarity(l.title, r.title) === 1 && artistSimilarity(l.artists, r.artists) === 1 &&
      ((!l.album && !r.album) || (loose && (!l.album || !r.album)) || textSimilarity(l.album, r.album) === 1);
  }
  function matchSelect(candidates, loose) {
    if (!candidates.length) return null;
    const best = candidates[0];
    if (!best.eligible) return null;
    for (let i = 1; i < candidates.length; i++) {
      const other = candidates[i];
      if (other.eligible && best.score - other.score < 8 && !sameRecording(best, other, loose)) return null;
    }
    return best;
  }

  /* ----------------------------------------------------------- model ---- */
  function at(node, path) {
    if (!path) return node;
    for (const part of path.split('/')) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return node;
  }
  const str = (node, path) => { const v = at(node, path); return typeof v === 'string' ? v : ''; };
  const int = (node, path) => {
    const v = at(node, path);
    if (typeof v === 'number' && isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string') { const n = parseInt(v, 10); return isFinite(n) ? n : 0; }
    return 0;
  };
  function cyrb53(text) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }
  function trackKey(track) {
    if (track.uri && !track.uri.endsWith('/NoTrack')) return track.uri;
    const raw = [normalize(track.title), normalize((track.artists || []).join('|')), normalize(track.album), track.duration_ms || 0].join('\n');
    return 'metadata:' + cyrb53(raw);
  }
  function spotifyId(uri) {
    if (!uri) return null;
    let id = null;
    if (uri.startsWith('spotify:track:')) id = uri.slice(14);
    else if (uri.startsWith('https://open.spotify.com/track/')) id = uri.slice(31);
    if (!id || !/^[A-Za-z0-9]{22}(\?.*)?$/.test(id)) return null;
    return id.slice(0, 22);
  }
  function trackEqual(l, r) {
    return !!l && !!r && l.uri === r.uri && l.title === r.title && l.album === r.album && l.duration_ms === r.duration_ms &&
      (l.artists || []).join('\n') === (r.artists || []).join('\n');
  }
  function candidateFromJson(node) {
    if (!node || typeof node !== 'object' || !str(node, 'provider') || !str(node, 'id')) return null;
    const provider = str(node, 'provider');
    if (!PROVIDERS.includes(provider)) return null;
    return {
      provider, id: str(node, 'id'), mid: str(node, 'mid'), title: str(node, 'title'), album: str(node, 'album'),
      duration_ms: int(node, 'duration_ms'), verified: node.verified === true,
      artists: Array.isArray(node.artists) ? node.artists.filter(a => typeof a === 'string') : [],
    };
  }
  function candidateJson(c) {
    const json = { id: c.id, mid: c.mid || '', provider: c.provider, title: c.title || '', album: c.album || '', duration_ms: c.duration_ms || 0, artists: (c.artists || []).slice() };
    if (c.verified) json.verified = true;
    return json;
  }

  /* ---------------------------------------------------------- lyrics ---- */
  const STAMP = /^(\d+):(\d+(?:\.\d*)?)/;
  function timestamp(text, from) {
    const m = STAMP.exec(text.slice(from, from + 24));
    if (!m) return null;
    const minutes = parseInt(m[1], 10), seconds = parseFloat(m[2]);
    if (minutes > 10000 || !(seconds >= 0 && seconds < 60)) return null;
    return { time: minutes * 60000 + Math.round(seconds * 1000), end: from + m[0].length };
  }
  function enhancedWords(raw) {
    const words = []; let text = ''; let cursor = 0;
    while (cursor < raw.length) {
      if (raw[cursor] !== '<') { text += raw[cursor++]; continue; }
      const stamp = timestamp(raw, cursor + 1);
      if (!stamp || raw[stamp.end] !== '>') { text += raw[cursor++]; continue; }
      const next = raw.indexOf('<', stamp.end + 1);
      const part = next >= 0 ? raw.slice(stamp.end + 1, next) : raw.slice(stamp.end + 1);
      if (words.length) words[words.length - 1].end_time_ms = stamp.time;
      if (part) { words.push({ text: part, start_time_ms: stamp.time, end_time_ms: stamp.time }); text += part; }
      cursor = next >= 0 ? next : raw.length;
    }
    return { text, words };
  }
  /* Bumped whenever parsing changes, so lyrics stored by an older parser get re-fetched. */
  const PARSER_VERSION = 2;
  function emptyLyrics(source) { return { source, provider: source, sync_type: 'line', lines: [], parser: PARSER_VERSION }; }
  function parseLrc(lrc, translation, source) {
    const result = emptyLyrics(source);
    if (typeof lrc !== 'string' || lrc.length > MAX_RESPONSE) return result;
    const rawLines = lrc.split('\n');
    let lines = [], offset = 0, hasWords = false;
    for (let i = 0; i < rawLines.length && lines.length < 10000; i++) {
      let p = rawLines[i].trim();
      if (p.charCodeAt(0) === 0xfeff) p = p.slice(1);
      if (p.startsWith('[offset:')) { offset = Math.max(-3600000, Math.min(3600000, parseInt(p.slice(8), 10) || 0)); continue; }
      const times = []; let pos = 0;
      while (p[pos] === '[') {
        const stamp = timestamp(p, pos + 1);
        if (!stamp || p[stamp.end] !== ']') break;
        times.push(stamp.time); pos = stamp.end + 1;
      }
      const body = p.slice(pos);
      for (const time of times) {
        const parsed = enhancedWords(body);
        hasWords = hasWords || parsed.words.length > 0;
        lines.push({ text: parsed.text, start_time_ms: time, end_time_ms: time, words: parsed.words });
      }
    }
    if (!lines.length) {
      result.sync_type = 'unsynced';
      for (const raw of rawLines) {
        const text = raw.trim();
        if (text && text[0] !== '[' && lines.length < 10000) lines.push({ text, start_time_ms: 0, end_time_ms: 0, words: [] });
      }
    } else if (hasWords) result.sync_type = 'word';
    lines.sort((a, b) => a.start_time_ms - b.start_time_ms);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const start = line.start_time_ms - offset;
      const end = i + 1 < lines.length ? lines[i + 1].start_time_ms - offset : start + 10000;
      line.start_time_ms = start; line.end_time_ms = Math.max(start, end);
      for (const word of line.words) {
        const ws = word.start_time_ms - offset, we = word.end_time_ms - offset;
        word.start_time_ms = ws; word.end_time_ms = we > ws ? we : Math.max(ws, line.end_time_ms);
      }
    }
    result.lines = lines;
    if (translation) mergeTranslation(lines, translation, source);
    return result;
  }
  function mergeTranslation(lines, translation, source) {
    const translated = parseLrc(translation, null, source).lines.filter(l => l.text.trim() && l.text.trim() !== '//');
    /* Blank/interlude lines must not swallow a translation meant for a real line. */
    const targets = [];
    lines.forEach((line, i) => { if (line.text.trim()) targets.push(i); });
    if (!translated.length || !targets.length) return;
    /* NetEase normally stamps a translation with exactly the same time as its original line:
     * take those pairs first, strictly. */
    const rest = [];
    const byTime = new Map();
    for (const i of targets) { const k = lines[i].start_time_ms; if (!byTime.has(k)) byTime.set(k, i); }
    for (const t of translated) {
      const i = byTime.get(t.start_time_ms);
      if (i !== undefined && !lines[i].translated_text) lines[i].translated_text = t.text; else rest.push(t);
    }
    /* Word-timed (yrc) timestamps can drift from the translation's: align what is left
     * monotonically to the nearest original line that still has no translation. */
    const TOLERANCE = 3000;
    const free = targets.filter(i => !lines[i].translated_text);
    let from = 0;
    for (const t of rest) {
      let best = -1, bestDiff = Infinity;
      for (let k = from; k < free.length; k++) {
        const diff = Math.abs(lines[free[k]].start_time_ms - t.start_time_ms);
        if (diff < bestDiff) { best = k; bestDiff = diff; }
        else if (lines[free[k]].start_time_ms > t.start_time_ms) break;
      }
      if (best < 0 || bestDiff > TOLERANCE) continue;
      lines[free[best]].translated_text = t.text; from = best + 1;
    }
  }
  function spotifyLyrics(response) {
    const result = emptyLyrics('spotify');
    const root = at(response, 'lyrics');
    const source = at(root, 'lines');
    if (!Array.isArray(source)) return result;
    const sync = str(root, 'syncType');
    result.sync_type = sync === 'SYLLABLE_SYNCED' ? 'word' : sync === 'LINE_SYNCED' ? 'line' : 'unsynced';
    result.language = str(root, 'language');
    result.provider = str(root, 'provider');
    result.provider_name = str(root, 'providerDisplayName');
    for (let i = 0; i < source.length; i++) {
      const input = source[i];
      let text = str(input, 'text') || str(input, 'words');
      const start = int(input, 'startTimeMs');
      let end = int(input, 'endTimeMs');
      if (end <= start) end = i + 1 < source.length ? int(source[i + 1], 'startTimeMs') : start + 10000;
      const line = { text, start_time_ms: start, end_time_ms: end, words: [] };
      const syllables = Array.isArray(input.syllables) ? input.syllables : Array.isArray(input.words) ? input.words : null;
      if (syllables && syllables.length) {
        let joined = '';
        syllables.forEach((part, j) => {
          const partText = str(part, 'string') || str(part, 'text');
          const ws = int(part, 'startTimeMs');
          let we = int(part, 'endTimeMs');
          if (we <= ws) we = j + 1 < syllables.length ? int(syllables[j + 1], 'startTimeMs') : end;
          line.words.push({ text: partText, start_time_ms: ws, end_time_ms: we }); joined += partText;
        });
        if (!text) line.text = joined;
      }
      result.lines.push(line);
    }
    if (result.sync_type !== 'word') for (const line of result.lines) line.words = [];
    return result;
  }
  function lyricsUsable(lyrics) {
    return !!(lyrics && Array.isArray(lyrics.lines) && lyrics.lines.some(line => line && line.text));
  }
  function lyricsIndex(lyrics, position) {
    const lines = lyrics && lyrics.lines;
    if (!Array.isArray(lines)) return -1;
    let low = 0, high = lines.length - 1, found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (lines[middle].start_time_ms <= position) { found = middle; low = middle + 1; } else high = middle - 1;
    }
    return found;
  }
  /* Share of the reference's distinct lines (first 40) found in the candidate;
   * kana lines are also compared in romaji. Used to confirm a match by content. */
  function lyricsSimilarity(reference, candidate) {
    const keys = lyrics => {
      const seen = new Map();
      for (const line of (lyrics && lyrics.lines) || []) {
        if (!line.text || CREDIT_LINE.test(line.text)) continue;
        const n = normalize(line.text);
        if (n && !seen.has(n)) seen.set(n, HAS_KANA.test(n) ? latinKey(romanize(n)) : latinKey(n));
      }
      return [...seen];
    };
    const ref = keys(reference).slice(0, 40), cand = keys(candidate);
    if (ref.length < 4 || cand.length < 4) return 0;
    const exact = new Set(cand.flatMap(([n, k]) => [n, k]));
    let hit = 0;
    for (const [n, k] of ref) {
      if (exact.has(n) || exact.has(k) || cand.some(([cn, ck]) => editSimilarity(cn, n) >= 0.8 || editSimilarity(ck, k) >= 0.8)) hit++;
    }
    return hit / ref.length;
  }
  function stamp(time, left, right) {
    time = Math.max(0, Math.round(time));
    const pad = (n, w) => String(n).padStart(w, '0');
    return left + pad(Math.floor(time / 60000), 2) + ':' + pad(Math.floor(time / 1000) % 60, 2) + '.' + pad(time % 1000, 3) + right;
  }
  function exportLrc(lyrics) {
    let text = '';
    for (const line of (lyrics && lyrics.lines) || []) {
      if (lyrics.sync_type !== 'unsynced') text += stamp(line.start_time_ms, '[', ']');
      if (line.words && line.words.length) {
        line.words.forEach((word, j) => {
          text += stamp(word.start_time_ms, '<', '>') + word.text;
          if (j + 1 === line.words.length) text += stamp(word.end_time_ms, '<', '>');
        });
      } else text += line.text;
      text += '\n';
    }
    return text;
  }

  /* ------------------------------------------------------- providers ---- */
  function addSong(array, provider, song) {
    if (!song || typeof song !== 'object' || Array.isArray(song) || array.length >= 100) return;
    const qq = provider === 'qq';
    const title = str(song, qq ? 'title' : 'name');
    const id = int(song, 'id');
    if (!id || !title) return;
    let album = str(song, qq ? 'album/title' : 'album/name');
    if (!album) album = str(song, qq ? 'album/name' : 'al/name');
    let duration = qq ? Math.max(0, Math.min(86400, int(song, 'interval'))) * 1000 : (int(song, 'duration') || int(song, 'dt'));
    if (duration < 0 || duration > 86400000) duration = 0;
    let artists = at(song, qq ? 'singer' : 'artists');
    if (!artists) artists = at(song, 'ar');
    artists = Array.isArray(artists) ? artists.slice(0, 50).map(a => str(a, 'name')) : [];
    const candidate = { provider, id: String(id), mid: str(song, 'mid'), title, album, duration_ms: duration, artists };
    if (array.some(o => o.id === candidate.id && o.provider === provider)) return;
    array.push(candidate);
  }
  function providerCandidates(provider, response) {
    const result = [];
    for (const path of ['result/songs', 'songs', 'req_1/data/body/song/list', 'data']) {
      const node = at(response, path);
      if (!Array.isArray(node)) continue;
      for (const song of node) {
        if (result.length >= 100) break;
        addSong(result, provider, song);
        const group = at(song, 'group');
        if (Array.isArray(group)) for (const item of group) { if (result.length >= 100) break; addSong(result, provider, item); }
      }
      break;
    }
    return result;
  }
  const NETEASE = 'https://music.163.com';
  const QQ = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
  /* Builds the HTTP request for a provider search, including direct song links. */
  function searchRequest(provider, query) {
    const normalized = normalize(query);
    if (provider === 'qq') {
      const request = {
        method: 'POST', url: QQ, headers: { Referer: 'https://c.y.qq.com/', 'Content-Type': 'application/json' },
        body: JSON.stringify({ req_1: { method: 'DoSearchForQQMusicDesktop', module: 'music.search.SearchCgiService', param: { num_per_page: 20, page_num: 1, search_type: 0, query: normalized } } }),
      };
      if (query.includes('y.qq.com/')) {
        const m = /(?:songDetail|song)\/([A-Za-z0-9]{1,64})/.exec(query);
        if (m) {
          request.url = 'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg';
          request.body = `songmid=${m[1]}&format=jsonp&callback=getOneSongInfoCallback&g_tk=5381&platform=yqq&outCharset=utf8`;
          request.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      }
      return request;
    }
    let url = `${NETEASE}/api/search/get/web?s=${encodeURIComponent(normalized)}&type=1&offset=0&total=false&limit=20`;
    if (query.includes('music.163.com/')) {
      const m = /(?:[?&]id=|song\/)(\d+)/.exec(query);
      if (m) url = `${NETEASE}/api/song/detail/?id=${m[1]}&ids=%5B${m[1]}%5D`;
    }
    return { method: 'GET', url, headers: { Referer: 'https://music.163.com/' }, body: null };
  }
  /* Ordered list of lyric requests; later entries are fallbacks tried on errors. */
  function fetchRequests(candidate) {
    if (candidate.provider === 'qq') {
      const requests = [fetchRequest(candidate)];
      /* Legacy web endpoint as a fallback (base64 lyric/trans, -1901 = none). */
      if (candidate.mid) requests.push({
        method: 'POST', url: 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
        headers: { Referer: 'https://y.qq.com/', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `songmid=${encodeURIComponent(candidate.mid)}&g_tk=5381&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`,
      });
      return requests;
    }
    const id = encodeURIComponent(candidate.id), headers = { Referer: 'https://music.163.com/' };
    return [
      /* Current endpoint: also returns word-timed yrc + its translation ytlrc. */
      { method: 'GET', url: `${NETEASE}/api/song/lyric/v1?id=${id}&cp=false&lv=0&kv=0&tv=0&rv=0&yv=0&ytv=0&yrv=0`, headers, body: null },
      { method: 'GET', url: `${NETEASE}/api/song/lyric?id=${id}&lv=-1&kv=-1&tv=-1`, headers, body: null },
    ];
  }
  function fetchRequest(candidate) {
    if (candidate.provider === 'qq') {
      return {
        method: 'POST', url: QQ, headers: { Referer: 'https://c.y.qq.com/', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comm: { ct: 24, cv: 4747474, format: 'json', g_tk: '5381', g_tk_new_20200303: '5381', inCharset: 'utf-8', outCharset: 'utf-8', platform: 'yqq.json', uin: 0 },
          req_1: { module: 'music.musichallSong.PlayLyricInfo', method: 'GetPlayLyricInfo', param: { qrc: 0, qrc_t: 0, roma: 0, trans: 1, songID: parseInt(candidate.id, 10) || 0, songMID: candidate.mid || '' } },
        }),
      };
    }
    return { method: 'GET', url: `${NETEASE}/api/song/lyric?id=${encodeURIComponent(candidate.id)}&lv=-1&kv=-1&tv=-1`, headers: { Referer: 'https://music.163.com/' }, body: null };
  }
  function decodeLyric(text) {
    if (!text) return '';
    if (text.includes('[')) return text;
    try {
      const binary = atob(text);
      const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) { return ''; }
  }
  class ProviderError extends Error {
    constructor(message, kind) { super(message); this.kind = kind || 'failed'; }
  }
  /* Parses a provider response body; throws ProviderError on service errors. */
  function parseProviderBody(provider, body) {
    let raw;
    try { raw = JSON.parse(body); } catch (_) {
      const start = body ? body.indexOf('(') : -1, end = body ? body.lastIndexOf(')') : -1;
      if (start >= 0 && end > start) { try { raw = JSON.parse(body.slice(start + 1, end)); } catch (_) { /* fallthrough */ } }
    }
    if (raw === undefined) throw new ProviderError(`${PROVIDER_NAMES[provider]} 返回了无法解析的数据`);
    const code = int(raw, 'code'), inner = int(raw, 'req_1/code');
    /* GetPlayLyricInfo answers 24001 when QQ has no lyric for the song. */
    if (provider === 'qq' && code === 0 && inner === 24001) return raw;
    if (provider === 'qq' && code === -1901) return raw;
    /* QQ answers 2001 intermittently (anti-spam); callers retry it once. */
    if ((code !== 0 && code !== 200) || inner !== 0) {
      const value = inner || code;
      if (value === 2001) throw new ProviderError(`${PROVIDER_NAMES[provider]} 暂时限流（2001），请稍后重试`, 'transient');
      throw new ProviderError(`${PROVIDER_NAMES[provider]} 服务返回错误码 ${value}`, 'failed');
    }
    return raw;
  }
  /* NetEase v1 lyrics carry credits as JSON lines ({"t":0,"c":[...]}); drop them. */
  const dropJsonLines = text => (text || '').split('\n').filter(line => !line.trim().startsWith('{')).join('\n');
  const CREDIT_LINE = /^\s*(?:作词|作詞|作曲|编曲|編曲|词|詞|曲|制作人|製作人|监制|監製|制作|製作|混音|母带|母帶|和声|和聲|录音|錄音|吉他|贝斯|鼓|弦乐|配唱|原唱|翻唱|演唱|歌手|出品|发行|發行|OP|SP|Lyrics?(?: by)?|Lyricist|Written by|Composer|Composed by|Music(?: by)?|Arrange(?:r|d by)|Producer|Produced by|Vocal(?:s| by)?)\s*[:：]/i;
  const INSTRUMENTAL = /纯音乐[，,]?\s*请欣赏|純音樂[，,]?\s*請欣賞|此歌曲为没有填词的纯音乐|instrumental/i;
  /* Word-timed NetEase lyrics: [lineStart,lineDur](wordStart,wordDur,0)text… */
  function parseYrc(yrc, translation, source) {
    const result = emptyLyrics(source);
    if (typeof yrc !== 'string' || yrc.length > MAX_RESPONSE) return result;
    const TOKEN = /\((\d+),(\d+),-?\d+\)/g;
    for (const raw of yrc.split('\n')) {
      const m = /^\[(\d+),(\d+)\](.*)$/.exec(raw.trim());
      if (!m || result.lines.length >= 10000) continue;
      const start = +m[1], body = m[3], tokens = [];
      let t; TOKEN.lastIndex = 0;
      while ((t = TOKEN.exec(body))) tokens.push({ index: t.index, end: TOKEN.lastIndex, start: +t[1], dur: +t[2] });
      const words = tokens.map((tk, i) => ({ text: body.slice(tk.end, i + 1 < tokens.length ? tokens[i + 1].index : body.length), start_time_ms: tk.start, end_time_ms: tk.start + tk.dur }))
        .filter(w => w.text);
      const text = words.length ? words.map(w => w.text).join('') : body.replace(TOKEN, '');
      result.lines.push({ text, start_time_ms: start, end_time_ms: start + Math.max(0, +m[2]), words });
    }
    result.lines.sort((a, b) => a.start_time_ms - b.start_time_ms);
    result.sync_type = result.lines.some(l => l.words.length) ? 'word' : 'line';
    if (translation) mergeTranslation(result.lines, translation, source);
    return result;
  }
  /* Placeholder lyrics (credits only, "纯音乐，请欣赏") are not lyrics. */
  function finalizeLyrics(lyrics, note) {
    const texts = lyrics.lines.map(l => l.text.trim()).filter(Boolean);
    if (!note && texts.length && texts.every(t => CREDIT_LINE.test(t))) note = 'credits';
    if (!note && texts.length && texts.length <= 3 && texts.some(t => INSTRUMENTAL.test(t))) note = 'instrumental';
    if (note) { lyrics.lines = []; lyrics.note = note; }
    return lyrics;
  }
  function lyricsFromResponse(provider, raw) {
    if (provider === 'qq') {
      if (int(raw, 'req_1/code') === 24001 || int(raw, 'code') === -1901) return finalizeLyrics(emptyLyrics('qq'), 'missing');
      if (!at(raw, 'req_1') && typeof at(raw, 'lyric') === 'string') return finalizeLyrics(parseLrc(decodeLyric(str(raw, 'lyric')), decodeLyric(str(raw, 'trans')), 'qq'));
      return finalizeLyrics(parseLrc(decodeLyric(str(raw, 'req_1/data/lyric')), decodeLyric(str(raw, 'req_1/data/trans')), 'qq'));
    }
    if (at(raw, 'uncollected') === true) return finalizeLyrics(emptyLyrics('netease'), 'uncollected');
    if (at(raw, 'nolyric') === true) return finalizeLyrics(emptyLyrics('netease'), 'instrumental');
    const lrc = dropJsonLines(str(raw, 'lrc/lyric')), tlyric = dropJsonLines(str(raw, 'tlyric/lyric'));
    const yrc = dropJsonLines(str(raw, 'yrc/lyric'));
    let lyrics = yrc.trim() ? parseYrc(yrc, dropJsonLines(str(raw, 'ytlrc/lyric')) || tlyric, 'netease') : null;
    if (!lyricsUsable(lyrics)) lyrics = parseLrc(lrc, tlyric, 'netease');
    /* v1 sends credits as JSON lines; if nothing else remains it is a credits-only placeholder. */
    const creditsOnly = !lyricsUsable(lyrics) && /^\s*\{/m.test(str(raw, 'lrc/lyric') + str(raw, 'yrc/lyric'));
    return finalizeLyrics(lyrics, creditsOnly ? 'credits' : undefined);
  }

  /* -------------------------------------------------------- requests ---- */
  /* Mirrors sl_http_request: budget, cooldown after 429, transient retries. */
  class Http {
    constructor(transport) {
      this.transport = transport; this.cooldown = new Map(); this.inflight = new Map();
      this.stats = { requests: 0, sent_bytes: 0, received_bytes: 0, cache_hits: 0 };
    }
    cacheHit() { this.stats.cache_hits++; }
    async request(provider, req, { signal, budget, retries = 0 } = {}) {
      retries = Math.min(retries, 2);
      /* Identical concurrent requests share one network round-trip. */
      const key = `${req.method} ${req.url} ${req.body || ''}`;
      if (this.inflight.has(key)) return this.inflight.get(key);
      const promise = this._request(provider, req, signal, budget, retries).finally(() => this.inflight.delete(key));
      this.inflight.set(key, promise);
      return promise;
    }
    async _request(provider, req, signal, budget, retries) {
      for (let attempt = 1; ; attempt++) {
        if (signal && signal.aborted) throw new ProviderError('请求已取消', 'cancelled');
        const until = this.cooldown.get(provider);
        if (until && until > Date.now()) throw new ProviderError('来源正在限流冷却，请稍后重试', 'blocked');
        if (budget && budget.remaining <= 0) throw new ProviderError('本次请求预算已用完', 'blocked');
        if (budget) budget.remaining--;
        this.stats.requests++;
        this.stats.sent_bytes += req.url.length + (req.body ? req.body.length : 0) + 200;
        let response, error = null;
        try { response = await this.transport(req, signal); } catch (e) { error = e; }
        if (signal && signal.aborted) throw new ProviderError('请求已取消', 'cancelled');
        const status = response ? response.status : 0;
        if (response) this.stats.received_bytes += (response.body || '').length + 200;
        if (status === 429) {
          const header = response.retryAfter;
          let delay = 60;
          if (header && /^\d/.test(header)) delay = parseInt(header, 10);
          else if (header) { const date = Date.parse(header); if (!isNaN(date)) delay = (date - Date.now()) / 1000; }
          this.cooldown.set(provider, Date.now() + Math.max(delay, 1) * 1000);
          throw new ProviderError(`${PROVIDER_NAMES[provider] || provider}：请求过多，已进入冷却`, 'http');
        }
        const transient = status === 502 || status === 503 || status === 504 || (error && error.transient);
        if (transient && attempt <= retries && !(budget && budget.remaining <= 0)) {
          await new Promise(r => setTimeout(r, 500 << Math.min(attempt, 3)));
          continue;
        }
        if (error) throw error instanceof ProviderError ? error : new ProviderError(String(error.message || error), error.kind || 'network');
        if (response.body && response.body.length > MAX_RESPONSE) throw new ProviderError('响应超过 2 MiB 限制');
        return response;
      }
    }
  }

  /* --------------------------------------------------------- engine ----- */
  const CANCELLED = Symbol('cancelled');
  /* Returned by deps.spotify on the lyrics server: Spotify lyrics can only be read
   * by the client (user token), so matching stops and asks the client for them. */
  const DEFER = Symbol('defer');
  /* State shared by the matching engine and the client of the lyrics server. */
  class EngineBase {
    constructor(deps) {
      this.deps = deps; this.store = deps.store;
      this.track = null; this.lyrics = null; this.colors = null; this.status = '等待播放器';
      this.generation = 0; this.controller = null; this.busy = false;
    }
    _changed() { try { this.deps.onChange && this.deps.onChange(); } catch (e) { console.error('[spot-lyric]', e); } }
    _setStatus(text) { this.status = text; this._changed(); }
    _install(lyrics, colors) {
      this.lyrics = lyrics ? JSON.parse(JSON.stringify(lyrics)) : null;
      this.colors = colors || null;
      if (this.lyrics && this.track) { this.lyrics.track_uri = this.track.uri; this.lyrics.track_id = spotifyId(this.track.uri) || ''; }
    }
    _preferred() {
      const p = this.deps.settings().preferred_provider;
      return PROVIDERS.includes(p) ? p : 'netease';
    }
    offset() {
      if (!this.track) return 0;
      return (this.store.getInt('timing-offset-ms', 0)) + this.store.getInt('offset:' + trackKey(this.track), 0);
    }
    setOffset(value, global) {
      if (!global && !this.track) return;
      const key = global ? 'timing-offset-ms' : 'offset:' + trackKey(this.track);
      this.store.set(key, String(Math.max(-5000, Math.min(5000, Math.round(value)))));
      this._changed();
    }
    async importLyrics(lyrics) {
      if (!lyricsUsable(lyrics) || !this.track) return;
      if (this.controller) this.controller.abort();
      this.generation++; this.busy = false;
      await this.store.kvSet('local-lyrics:' + trackKey(this.track), JSON.stringify(lyrics));
      this._install(lyrics); this._setStatus('已绑定本地歌词');
    }
  }

  class Engine extends EngineBase {
    /**
     * deps: { store, http, settings(): {preferred_provider, spotify_first},
     *         spotify(track, signal) -> Promise<{lyrics, colors}|null|undefined|DEFER>, onChange() }
     */
    constructor(deps) {
      super(deps);
      this.http = deps.http; this.deferred = null;
    }

    /* Provider search with cache, negative cooldown and budget (providers.c). */
    async providerSearch(provider, query, signal, budget) {
      const key = `search:${provider}:${normalize(query)}`;
      const cached = await this._cached(key, provider);
      if (cached !== undefined) return cached.map(c => candidateFromJson(c)).filter(Boolean);
      try {
        const raw = await this._exchange(provider, searchRequest(provider, query), signal, budget, 2);
        const candidates = providerCandidates(provider, raw);
        await this.store.cachePut(key, JSON.stringify(candidates.map(candidateJson)), 86400);
        return candidates;
      } catch (e) { await this._failure(provider, e); throw e; }
    }
    async providerFetch(candidate, signal, budget) {
      const key = `${LYRICS_CACHE}:${candidate.provider}:${candidate.id}`;
      const cached = await this._cached(key, candidate.provider);
      if (cached !== undefined) return cached;
      try {
        const requests = fetchRequests(candidate);
        let raw;
        for (let i = 0; ; i++) {
          try { raw = await this._exchange(candidate.provider, requests[i], signal, budget, 1); break; }
          catch (e) { if (i + 1 >= requests.length || e.kind === 'cancelled' || e.kind === 'blocked') throw e; }
        }
        let lyrics;
        if (raw === null) {
          lyrics = parseLrc('', null, candidate.provider);
          await this.store.cachePut(key, JSON.stringify(lyrics), 21600);
          return lyrics;
        }
        lyrics = lyricsFromResponse(candidate.provider, raw);
        await this.store.cachePut(key, JSON.stringify(lyrics), lyricsUsable(lyrics) ? 0 : 21600);
        return lyrics;
      } catch (e) { await this._failure(candidate.provider, e); throw e; }
    }
    /* One request + parse; a transient service code is retried once. null = HTTP 404. */
    async _exchange(provider, request, signal, budget, retries) {
      for (let attempt = 0; ; attempt++) {
        const response = await this.http.request(provider, request, { signal, budget, retries });
        if (response.status === 404) return null;
        if (response.status >= 400) throw new ProviderError(`${PROVIDER_NAMES[provider]}：HTTP ${response.status}`, 'http');
        try { return parseProviderBody(provider, response.body); }
        catch (e) {
          if (e.kind !== 'transient' || attempt > 0 || (budget && budget.remaining <= 0)) throw e;
          await new Promise(r => setTimeout(r, 1200));
          if (signal && signal.aborted) throw new ProviderError('请求已取消', 'cancelled');
        }
      }
    }
    async _cached(key, provider) {
      const cached = await this.store.cacheGet(key);
      if (cached != null) { this.http.cacheHit(); return JSON.parse(cached); }
      if (await this.store.cacheGet('failure:' + provider) != null) throw new ProviderError('来源暂不可用，稍后自动重试', 'blocked');
      return undefined;
    }
    async _failure(provider, error) {
      if (error && (error.kind === 'cancelled' || error.kind === 'blocked')) return;
      await this.store.cachePut('failure:' + provider, '1', 60);
    }

    /* Automatic matching for the playing track (engine.c: sl_engine_track). */
    async setTrack(track, force = false) {
      if (!force && trackEqual(this.track, track)) return;
      if (this.controller) this.controller.abort();
      const generation = ++this.generation;
      this.track = track ? JSON.parse(JSON.stringify(track)) : null;
      this._install(null); this.deferred = null;
      if (!track || !track.title) { this._setStatus('等待播放器'); return; }
      const controller = this.controller = new AbortController();
      const current = () => generation === this.generation && !controller.signal.aborted;
      this.busy = true;
      try { await this._match(track, force, controller.signal, current); }
      catch (e) { if (e !== CANCELLED && current()) { console.error('[spot-lyric]', e); this._setStatus('匹配出错：' + (e.message || e)); } }
      finally { if (current()) { this.busy = false; this._changed(); } }
    }
    async _match(track, force, signal, current) {
      const check = () => { if (!current()) throw CANCELLED; };
      const key = trackKey(track);
      const local = await this.store.kvGet('local-lyrics:' + key); check();
      if (local && !force) {
        const lyrics = JSON.parse(local);
        if (lyricsUsable(lyrics)) { this._install(lyrics); this.http.cacheHit(); this._setStatus('本地歌词'); return; }
      }
      let { candidate: saved, manual } = await this.store.matchGet(track); check();
      if (saved && !manual) { const verified = saved.verified; matchScore(track, saved); if (!saved.eligible && !verified) saved = null; }
      const lyricsKey = TRACK_CACHE + key, negativeKey = 'negative:' + key;
      if (!force) {
        const cached = await this.store.cacheGet(lyricsKey); check();
        if (cached) {
          const entry = JSON.parse(cached);
          const lyrics = entry.lyrics || entry;
          if (lyricsUsable(lyrics) && (saved || lyrics.source === 'spotify')) {
            this._install(lyrics, entry.colors); this.http.cacheHit();
            this._setStatus(manual ? '已绑定歌词 · 缓存' : '歌词缓存'); return;
          }
        }
        const negative = await this.store.cacheGet(negativeKey); check();
        if (negative) { this.http.cacheHit(); this._setStatus(negative); return; }
      } else {
        await this.store.cacheRemove(lyricsKey); await this.store.cacheRemove(negativeKey);
        if (saved) await this.store.cacheRemove(`${LYRICS_CACHE}:${saved.provider}:${saved.id}`);
        check();
      }
      const job = {
        track, key, preferred: this._preferred(), candidates: [], fetched: new Set(), failed: false,
        searches: { remaining: 4 }, lyricsBudget: { remaining: 2 }, signal, check,
      };
      const artist = (track.artists && track.artists[0]) || '';
      /* Original metadata first; a second query removes only explicit featured credits. */
      job.queries = [`${track.title} ${artist}`, `${track.title.replace(FEATURED_PAREN, '')} ${artist}`];
      this._setStatus('正在匹配歌词');
      const settings = this.deps.settings();
      if (settings.spotify_first && !saved) {
        const result = await this._spotify(job);
        if (result && lyricsUsable(result.lyrics)) return this._complete(job, result.lyrics, 'Spotify 歌词', result.colors);
        job.spotifyTried = result !== undefined;
      }
      if (saved) {
        job.candidates.push(saved); job.fetched.add(`${saved.provider}:${saved.id}`);
        if (await this._tryCandidate(job, saved, manual)) return;
      }
      for (let index = 0; index < 4 && job.searches.remaining > 0; index++) {
        const query = job.queries[index % 2];
        if (!query.trim() || (index % 2 && job.queries[0] === query)) continue;
        const provider = index < 2 ? job.preferred : job.preferred === 'qq' ? 'netease' : 'qq';
        let result = [];
        try { result = await this.providerSearch(provider, query, signal, job.searches); }
        catch (e) { if (e.kind === 'cancelled') throw CANCELLED; job.failed = true; }
        check();
        for (const candidate of result) {
          if (job.candidates.some(o => o.provider === candidate.provider && o.id === candidate.id)) continue;
          job.candidates.push(matchScore(track, candidate));
        }
        /* Like engine.c, one fetch per search round; a miss moves on to the next query. */
        await this._fetchBest(job);
        if (job.done) return;
      }
      while (await this._fetchBest(job)) { /* remaining lyric budget */ }
      if (job.done) return;
      /* Spotify's own lyrics are the fallback after both external sources. */
      if (!job.spotifyTried) {
        const result = await this._spotify(job);
        if (result !== undefined) {
          if (result && lyricsUsable(result.lyrics)) {
            if (this.deps.settings().verify_lyrics !== false && await this._verifyByLyrics(job, result)) return;
            return this._complete(job, result.lyrics, 'Spotify 歌词', result.colors);
          }
          return this._complete(job, null, job.failed ? '请求失败，可手动重试' : '未匹配，可手动选择歌词');
        }
      }
      if (job.deferred) {
        /* Server mode: the client has to supply Spotify's lyrics; nothing is cached. */
        job.check(); job.done = true;
        this.deferred = { verifiable: this._verifyPool(job).length > 0, failed: job.failed };
        this._install(null); this._setStatus('需要 Spotify 歌词');
        return;
      }
      return this._complete(job, null, job.failed ? '来源暂不可用，60 秒后可重试' : '未匹配，可手动选择歌词');
    }
    /* undefined: Spotify lyrics not applicable (no id / no lyrics flag); null: miss. */
    async _spotify(job) {
      if (!this.deps.spotify || !spotifyId(job.track.uri)) return undefined;
      try {
        const r = await this.deps.spotify(job.track, job.signal); job.check();
        if (r === DEFER) { job.deferred = true; return undefined; }
        return r;
      }
      catch (e) { if (e === CANCELLED || job.signal.aborted) throw CANCELLED; if (e.kind !== 'denied') job.failed = true; return null; }
    }
    _verifyPool(job) {
      const flags = versionFlags(job.track.title);
      const pool = job.candidates.filter(c => !job.fetched.has(`${c.provider}:${c.id}`) && c.delta_ms >= 0 &&
        c.delta_ms <= DURATION_TOLERANCE && c.artist_score >= 0.75 && versionFlags(c.title) === flags);
      return matchSort(pool, job.preferred);
    }
    /* Metadata could not decide (e.g. romaji vs kanji titles). If Spotify has the
     * lyrics, accept a same-artist, same-length (±3 s), same-version candidate only
     * when its lyric text matches Spotify's. Keeps translations / word timing. */
    async _verifyByLyrics(job, spotify) {
      const pool = this._verifyPool(job);
      const budget = { remaining: 3 };
      for (const candidate of pool.slice(0, 3)) {
        job.fetched.add(`${candidate.provider}:${candidate.id}`);
        let lyrics = null;
        try { lyrics = await this.providerFetch(candidate, job.signal, budget); }
        catch (e) { if (e.kind === 'cancelled') throw CANCELLED; continue; }
        job.check();
        if (!lyricsUsable(lyrics)) continue;
        const similarity = lyricsSimilarity(spotify.lyrics, lyrics);
        if (similarity < 0.6) continue;
        candidate.verified = true;
        await this.store.matchSave(job.track, candidate, false);
        await this._complete(job, lyrics, `已匹配歌词 · ${PROVIDER_NAMES[candidate.provider]}（歌词比对 ${Math.round(similarity * 100)}%）`, spotify.colors);
        return true;
      }
      return false;
    }
    async _fetchBest(job) {
      if (job.done || job.lyricsBudget.remaining <= 0) return false;
      const available = job.candidates.filter(c => !job.fetched.has(`${c.provider}:${c.id}`));
      matchSort(available, job.preferred);
      const best = matchSelect(available, !!this.deps.settings().loose_match);
      if (!best) return false;
      job.fetched.add(`${best.provider}:${best.id}`);
      return !(await this._tryCandidate(job, best, false)) && !job.done;
    }
    async _tryCandidate(job, candidate, manual) {
      let lyrics = null;
      try { lyrics = await this.providerFetch(candidate, job.signal, job.lyricsBudget); }
      catch (e) { if (e.kind === 'cancelled') throw CANCELLED; job.failed = true; }
      job.check();
      if (!lyricsUsable(lyrics)) return false;
      await this.store.matchSave(job.track, candidate, manual);
      await this._complete(job, lyrics, `${manual ? '已绑定' : '已匹配'}歌词 · ${PROVIDER_NAMES[candidate.provider]}`);
      return true;
    }
    async _complete(job, lyrics, status, colors) {
      job.check(); job.done = true;
      this._install(lyrics, colors);
      if (lyricsUsable(lyrics)) {
        await this.store.cachePut(TRACK_CACHE + job.key, JSON.stringify({ lyrics, colors: colors || null }), 0);
        await this.store.cacheRemove('negative:' + job.key);
      } else {
        await this.store.cachePut('negative:' + job.key, status, job.failed ? 60 : 21600);
      }
      job.check();
      this._setStatus(status);
    }

    /* Manual search always queries both providers so the panel can show one
     * page per source, including the ones that failed or returned nothing. */
    async search(query) {
      const groups = PROVIDERS.map(provider => ({ provider, searched: false, error: null, candidates: [] }));
      const all = [];
      const track = this.track || { title: '', artists: [], album: '', duration_ms: 0 };
      const budget = { remaining: 6 };
      if (query && query.length <= 2048) {
        await Promise.all(PROVIDERS.map(async (provider, stage) => {
          if ((query.includes('y.qq.com/') && stage === 0) || (query.includes('music.163.com/') && stage === 1)) return;
          groups[stage].searched = true;
          try {
            for (const candidate of await this.providerSearch(provider, query, null, budget)) all.push(matchScore(track, candidate));
          } catch (e) { groups[stage].error = e.message || String(e); }
        }));
      }
      matchSort(all, this._preferred());
      const automatic = matchSelect(all, !!this.deps.settings().loose_match);
      const { candidate: bound, manual } = this.track ? await this.store.matchGet(this.track) : { candidate: null };
      for (const candidate of all) {
        candidate.auto_selected = candidate === automatic;
        candidate.ambiguous = !automatic && candidate.eligible;
        const same = !!(bound && bound.provider === candidate.provider && bound.id === candidate.id);
        candidate.bound = same && manual;
        candidate.verified = same && !manual && !!bound.verified;
        groups[PROVIDERS.indexOf(candidate.provider)].candidates.push(candidate);
      }
      return { candidates: all, providers: groups };
    }
    preview(candidate) { return this.providerFetch(candidate, null, { remaining: 1 }); }
    async bind(candidate, lyrics) {
      if (!lyricsUsable(lyrics) || !this.track) return;
      if (this.controller) this.controller.abort();
      this.generation++; this.busy = false;
      const key = trackKey(this.track);
      await this.store.matchSave(this.track, candidate, true);
      await this.store.kvSet('local-lyrics:' + key, '');
      await this.store.cacheRemove('negative:' + key);
      await this.store.cachePut(TRACK_CACHE + key, JSON.stringify({ lyrics, colors: null }), 0);
      this._install(lyrics); this._setStatus('已保存人工匹配');
    }
    /* Drops bindings, local lyrics and caches for this track, then rematches. */
    async unbind() {
      if (!this.track) return;
      await this.store.matchRemove(this.track);
      await this.store.kvSet('local-lyrics:' + trackKey(this.track), '');
      return this.setTrack(this.track, true);
    }
  }

  /* ---------------------------------------------------- remote engine ---- */
  /* Spotify-side client of the lyrics server (server/): searching, matching and
   * lyric downloads run remotely with the Engine above. The client keeps what only
   * it can do (Spotify's own lyrics with the user's token, local LRC imports,
   * timing offsets) plus a short-lived cache of server answers. */
  const REMOTE_CACHE = 'remote2:', REMOTE_TTL = 6 * 3600, NEGATIVE_TTL = 1800;
  /* The server only needs line text: lyrics-content check and usability. */
  function compactLyrics(lyrics) {
    return {
      sync_type: lyrics.sync_type,
      lines: ((lyrics && lyrics.lines) || []).slice(0, 400).map(l => ({ text: String(l.text || '').slice(0, 300), start_time_ms: Math.trunc(l.start_time_ms) || 0 })),
    };
  }
  const trackPayload = t => ({ uri: t.uri || '', title: t.title || '', artists: (t.artists || []).slice(0, 20), album: t.album || '', duration_ms: t.duration_ms || 0 });
  class RemoteEngine extends EngineBase {
    /**
     * deps: { store, transport(path, body: string|null, signal) -> Promise<{status, body: string}>,
     *         settings(), spotify(track, signal) -> Promise<{lyrics, colors}|null|undefined>, onChange() }
     */
    constructor(deps) {
      super(deps);
      this.stats = { requests: 0, sent_bytes: 0, received_bytes: 0, cache_hits: 0 };
    }
    _settings() {
      const s = this.deps.settings();
      return { preferred_provider: PROVIDERS.includes(s.preferred_provider) ? s.preferred_provider : 'netease', spotify_first: !!s.spotify_first, loose_match: !!s.loose_match, verify_lyrics: s.verify_lyrics !== false };
    }
    /* POST to the lyrics server; non-200 answers become ProviderErrors. */
    async api(path, payload, signal) {
      const body = payload == null ? null : JSON.stringify(payload);
      this.stats.requests++;
      this.stats.sent_bytes += path.length + (body ? body.length : 0) + 200;
      let response;
      try { response = await this.deps.transport(path, body, signal); }
      catch (e) {
        if (signal && signal.aborted) throw new ProviderError('请求已取消', 'cancelled');
        throw e instanceof ProviderError ? e : new ProviderError('无法连接歌词服务器', 'network');
      }
      this.stats.received_bytes += (response.body || '').length + 200;
      let data = null;
      try { data = JSON.parse(response.body); } catch (_) { /* below */ }
      if (response.status !== 200 || !data || typeof data !== 'object') {
        const message = data && data.error ? data.error : `歌词服务器错误 ${response.status}`;
        throw new ProviderError(message, response.status === 429 ? 'blocked' : response.status >= 500 || !response.status ? 'network' : 'failed');
      }
      return data;
    }
    async setTrack(track, force = false) {
      if (!force && trackEqual(this.track, track)) return;
      if (this.controller) this.controller.abort();
      const generation = ++this.generation;
      this.track = track ? JSON.parse(JSON.stringify(track)) : null;
      this._install(null);
      if (!track || !track.title) { this._setStatus('等待播放器'); return; }
      const controller = this.controller = new AbortController();
      const current = () => generation === this.generation && !controller.signal.aborted;
      this.busy = true;
      try { await this._match(track, force, controller.signal, current); }
      catch (e) { if (e !== CANCELLED && current()) { console.error('[spot-lyric]', e); this._setStatus('匹配出错：' + (e.message || e)); } }
      finally { if (current()) { this.busy = false; this._changed(); } }
    }
    /* undefined: not applicable (no Spotify id / token / lyrics flag); null: miss or error. */
    async _spotify(job) {
      if (!this.deps.spotify || !spotifyId(job.track.uri)) return undefined;
      try { const r = await this.deps.spotify(job.track, job.signal); job.check(); return r; }
      catch (e) { if (e === CANCELLED || job.signal.aborted) throw CANCELLED; if (e.kind !== 'denied') job.failed = true; return null; }
    }
    async _match(track, force, signal, current) {
      const check = () => { if (!current()) throw CANCELLED; };
      const key = trackKey(track);
      const job = { track, key, signal, check, failed: false };
      const local = await this.store.kvGet('local-lyrics:' + key); check();
      if (local && !force) {
        const lyrics = JSON.parse(local);
        if (lyricsUsable(lyrics)) { this._install(lyrics); this.stats.cache_hits++; this._setStatus('本地歌词'); return; }
      }
      const cacheKey = REMOTE_CACHE + key, negativeKey = 'negative:' + key;
      if (!force) {
        const cached = await this.store.cacheGet(cacheKey); check();
        if (cached) {
          const entry = JSON.parse(cached);
          if (lyricsUsable(entry.lyrics)) { this._install(entry.lyrics, entry.colors); this.stats.cache_hits++; this._setStatus(`${entry.status} · 缓存`); return; }
        }
        const negative = await this.store.cacheGet(negativeKey); check();
        if (negative) { this.stats.cache_hits++; this._setStatus(negative); return; }
      } else {
        await this.store.cacheRemove(cacheKey); await this.store.cacheRemove(negativeKey); check();
      }
      this._setStatus('正在匹配歌词');
      const settings = this._settings();
      const request = { track: trackPayload(track), settings, force: !!force };
      let spotify;
      if (settings.spotify_first) {
        spotify = await this._spotify(job);
        request.spotify = spotify && lyricsUsable(spotify.lyrics) ? compactLyrics(spotify.lyrics) : 'none';
      }
      let answer;
      try { answer = await this.api('/api/match', request, signal); }
      catch (e) {
        if (e.kind === 'cancelled') throw CANCELLED;
        /* Server unreachable: Spotify's own lyrics still work. */
        if (spotify === undefined && !settings.spotify_first) spotify = await this._spotify(job);
        check();
        if (spotify && lyricsUsable(spotify.lyrics)) { this._install(spotify.lyrics, spotify.colors); this._setStatus('Spotify 歌词（歌词服务器不可用）'); return; }
        return this._complete(job, null, `歌词服务器不可用：${e.message}`, null, true);
      }
      check();
      if (answer.use_spotify && spotify && lyricsUsable(spotify.lyrics)) return this._complete(job, spotify.lyrics, 'Spotify 歌词', spotify.colors);
      if (lyricsUsable(answer.lyrics)) return this._complete(job, answer.lyrics, answer.status, answer.colors);
      if (!answer.need_spotify) return this._complete(job, null, answer.status || '未匹配，可手动选择歌词', null, answer.failed);
      /* Nothing from NetEase / QQ: Spotify's lyrics are the fallback, and the server
       * can use them to confirm a candidate whose metadata alone was not enough. */
      job.failed = !!answer.failed;
      spotify = await this._spotify(job);
      if (spotify === undefined) return this._complete(job, null, job.failed ? '来源暂不可用，60 秒后可重试' : '未匹配，可手动选择歌词', null, job.failed);
      if (!spotify || !lyricsUsable(spotify.lyrics)) return this._complete(job, null, job.failed ? '请求失败，可手动重试' : '未匹配，可手动选择歌词', null, job.failed);
      if (settings.verify_lyrics && answer.verifiable) {
        let verified = null;
        try { verified = await this.api('/api/match', { ...request, spotify: compactLyrics(spotify.lyrics) }, signal); }
        catch (e) { if (e.kind === 'cancelled') throw CANCELLED; }
        check();
        if (verified && !verified.use_spotify && lyricsUsable(verified.lyrics)) return this._complete(job, verified.lyrics, verified.status, spotify.colors);
      }
      return this._complete(job, spotify.lyrics, 'Spotify 歌词', spotify.colors);
    }
    async _complete(job, lyrics, status, colors, failed) {
      job.check();
      this._install(lyrics, colors);
      if (lyricsUsable(lyrics)) {
        await this.store.cachePut(REMOTE_CACHE + job.key, JSON.stringify({ lyrics, colors: colors || null, status }), REMOTE_TTL);
        await this.store.cacheRemove('negative:' + job.key);
      } else {
        await this.store.cachePut('negative:' + job.key, status, failed ? 60 : NEGATIVE_TTL);
      }
      job.check();
      this._setStatus(status);
    }
    async search(query) {
      const track = this.track || { uri: '', title: '', artists: [], album: '', duration_ms: 0 };
      let answer;
      try { answer = await this.api('/api/search', { query: String(query || '').slice(0, 2048), track: trackPayload(track), settings: this._settings() }); }
      catch (e) {
        return { candidates: [], providers: PROVIDERS.map(provider => ({ provider, searched: true, error: e.message || String(e), candidates: [] })) };
      }
      const providers = Array.isArray(answer.providers) ? answer.providers : [];
      return { candidates: providers.flatMap(group => group.candidates || []), providers };
    }
    async preview(candidate) {
      const answer = await this.api('/api/lyrics', { candidate: candidateJson(candidate) });
      return answer.lyrics || emptyLyrics(candidate.provider);
    }
    /* "使用此歌词": the server stores the match (and the lyrics in R2). Tracks
     * without a Spotify id (local files) are bound on this machine only. */
    async bind(candidate, lyrics) {
      if (!this.track) return null;
      const track = this.track, key = trackKey(track);
      if (!spotifyId(track.uri)) { await this.importLyrics(lyrics); return { status: '已绑定本地歌词', local: true }; }
      if (this.controller) this.controller.abort();
      this.generation++; this.busy = false;
      const answer = await this.api('/api/bind', { track: trackPayload(track), candidate: candidateJson(candidate) });
      if (!lyricsUsable(answer.lyrics) || this.track !== track) return answer;
      await this.store.kvSet('local-lyrics:' + key, '');
      await this.store.cacheRemove('negative:' + key);
      await this.store.cachePut(REMOTE_CACHE + key, JSON.stringify({ lyrics: answer.lyrics, colors: null, status: answer.status }), REMOTE_TTL);
      this._install(answer.lyrics); this._setStatus(answer.status || '已保存人工匹配');
      return answer;
    }
    /* Removes the server binding (and its R2 copy) and local lyrics, then rematches. */
    async unbind() {
      if (!this.track) return;
      const track = this.track;
      if (spotifyId(track.uri)) await this.api('/api/unbind', { track: trackPayload(track) });
      await this.store.kvSet('local-lyrics:' + trackKey(track), '');
      return this.setTrack(track, true);
    }
  }

  const api = {
    DURATION_TOLERANCE, PROVIDERS, PROVIDER_NAMES, normalize, textSimilarity, versionFlags, titleBase, titleSimilarity,
    artistSimilarity, matchScore, matchSort, matchSelect, sameRecording, trackKey, spotifyId, trackEqual, romanize, lyricsSimilarity,
    candidateFromJson, candidateJson, parseLrc, spotifyLyrics, lyricsUsable, lyricsIndex, exportLrc,
    providerCandidates, searchRequest, fetchRequest, fetchRequests, parseProviderBody, lyricsFromResponse, decodeLyric,
    parseYrc, finalizeLyrics, compactLyrics, emptyLyrics, PARSER_VERSION,
    ProviderError, Http, Engine, RemoteEngine, DEFER,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SpotLyricCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
