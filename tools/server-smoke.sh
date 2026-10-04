#!/usr/bin/env bash
# Smoke test for a deployed Spot-Lyric lyrics server (needs curl + python3).
#   tools/server-smoke.sh https://spo.564616.xyz [api-token]
# The server only stores shared matches and relays provider requests. This runs:
# relay a NetEase search + lyric download -> upload ("使用此歌词") twice (the stored
# object must follow the latest upload) -> read back -> unbind, plus input checks.
# The test binding is removed again at the end (set KEEP=1 to keep it).
set -uo pipefail
S="${1:?usage: server-smoke.sh <server-url> [token]}"; S="${S%/}"
TOKEN="${2:-${SPOT_LYRIC_TOKEN:-}}"
ID="${SMOKE_TRACK_ID:-0RiRZpuVRbi7oqRdSMwhQY}"
TRACK="{\"uri\":\"spotify:track:$ID\",\"title\":\"十年\",\"artists\":[\"陈奕迅\"],\"album\":\"黑白灰\",\"duration_ms\":205000}"
HDR=(-H 'Origin: https://xpui.app.spotify.com' -H 'Content-Type: text/plain')
[[ -n $TOKEN ]] && HDR+=(-H "Authorization: Bearer $TOKEN")
pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad() { fail=$((fail + 1)); printf '  \033[31m✘\033[0m %s\n' "$*"; }
# call METHOD PATH [BODY] -> sets OUT (body) CODE (http status) MS (milliseconds)
call() {
  local t0 t1 res
  t0=$(date +%s%N)
  if [[ $1 == GET ]]; then res="$(curl -s -m 60 -w '\n%{http_code}' "${HDR[@]}" "$S$2")"
  else res="$(curl -s -m 60 -w '\n%{http_code}' "${HDR[@]}" -X POST "$S$2" --data-binary "$3")"; fi
  t1=$(date +%s%N)
  CODE="${res##*$'\n'}"; OUT="${res%$'\n'*}"; MS=$(( (t1 - t0) / 1000000 ))
}
py() { printf '%s' "$OUT" | python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
$1" 2>/dev/null; }

echo "== $S"
call GET /health
[[ $CODE == 200 ]] && ok "health $(py 'print(d.get("version"), "storage="+str(d.get("storage")), "relay="+str(d.get("relay")))') (${MS}ms)" || { bad "health HTTP $CODE"; exit 1; }

# Relay: the client builds the provider request, the server only forwards it.
call POST /api/relay '{"method":"GET","url":"https://music.163.com/api/search/get/web?s=%E5%8D%81%E5%B9%B4%20%E9%99%88%E5%A5%95%E8%BF%85&type=1&offset=0&total=false&limit=5","headers":{"Referer":"https://music.163.com/"}}'
SONG="$(py 'b=json.loads(d["body"]); print(b["result"]["songs"][0]["id"])')"
[[ $CODE == 200 && -n $SONG ]] && ok "relay: NetEase search → song $SONG (${MS}ms)" || bad "relay search HTTP $CODE $(py 'print(d.get("error") or d.get("status"))')"
call POST /api/relay "{\"method\":\"GET\",\"url\":\"https://music.163.com/api/song/lyric?id=${SONG:-0}&lv=-1&kv=-1&tv=-1\",\"headers\":{\"Referer\":\"https://music.163.com/\"}}"
LRC="$(py 'b=json.loads(d["body"]); print(json.dumps((b.get("lrc") or {}).get("lyric","")))')"
[[ $CODE == 200 && ${#LRC} -gt 20 ]] && ok "relay: lyric download ${#LRC} bytes (${MS}ms)" || bad "relay lyric HTTP $CODE"
call POST /api/relay '{"method":"GET","url":"https://example.com/api/search/get/web"}'
[[ $CODE == 400 ]] && ok "relay rejects hosts outside the allow-list (400)" || bad "relay allow-list HTTP $CODE"

# Upload twice: the stored object follows the latest upload.
lyrics() {  # lyrics <first line> -> sanitized-lyrics JSON as the client sends it
  printf '{"source":"netease","sync_type":"line","parser":2,"lines":[{"text":"%s","start_time_ms":1000,"end_time_ms":4000,"words":[]},{"text":"smoke test","start_time_ms":4000,"end_time_ms":8000,"words":[]}]}' "$1"
}
for i in 1 2; do
  call POST /api/bind "{\"track\":$TRACK,\"candidate\":{\"provider\":\"netease\",\"id\":\"${SONG:-1}\",\"title\":\"十年\",\"artists\":[\"陈奕迅\"]},\"lyrics\":$(lyrics "upload #$i")}"
  [[ $CODE == 200 ]] && ok "upload #$i → stored=$(py 'print(d.get("stored"))') (${MS}ms)" || bad "upload #$i HTTP $CODE $OUT"
  call GET "/api/bindings/$ID"
  got="$(py 'print(d["binding"]["lyrics"]["lines"][0]["text"])')"
  [[ $got == "upload #$i" ]] && ok "stored object follows the latest upload: $got" || bad "stored '$got', expected 'upload #$i'"
done
py 'b=d["binding"];print("     ", b["spotify_url"], "→", b["match"]["provider_name"], b["match"]["url"], "| bind_count", b["bind_count"], "| lrc hidden:", "lrc" not in b)'

call POST /api/bind "{\"track\":$TRACK,\"lyrics\":{\"source\":\"spotify\",\"lines\":[{\"text\":\"x\"}]}}"
[[ $CODE == 422 ]] && ok "Spotify lyrics are refused (422)" || bad "spotify upload HTTP $CODE"
if [[ -z ${KEEP:-} ]]; then
  call POST /api/unbind "{\"track\":$TRACK}"
  [[ $CODE == 200 ]] && { call GET "/api/bindings/$ID"; [[ $CODE == 404 ]]; } && ok "unbind removed the stored object" || bad "unbind HTTP $CODE"
fi
call POST /api/bind '{}'
[[ $CODE == 400 ]] && ok "bad input rejected (400)" || bad "bad input HTTP $CODE"
call POST /api/match '{}'
[[ $CODE == 410 ]] && ok "retired v1.1 endpoint answers 410" || bad "retired endpoint HTTP $CODE"
OUT="$(curl -s -m 30 -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example' -X POST "$S/api/bind" -d '{}')"
[[ $OUT == 403 ]] && ok "foreign origin rejected (403)" || bad "foreign origin HTTP $OUT"
echo "passed $pass, failed $fail"
[[ $fail == 0 ]]
