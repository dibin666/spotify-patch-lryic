#!/usr/bin/env bash
# Smoke test for a deployed Spot-Lyric lyrics server (needs curl + python3).
#   tools/server-smoke.sh https://spo.564616.xyz [api-token]
# Runs search -> preview -> "使用此歌词" twice (switching lyrics) -> match -> unbind
# on one track, checking that the stored object always follows the latest choice.
# The test binding is removed again at the end (set KEEP=1 to keep it).
set -uo pipefail
S="${1:?usage: server-smoke.sh <server-url> [token]}"; S="${S%/}"
TOKEN="${2:-${SPOT_LYRIC_TOKEN:-}}"
ID="${SMOKE_TRACK_ID:-0RiRZpuVRbi7oqRdSMwhQY}"
TRACK="{\"uri\":\"spotify:track:$ID\",\"title\":\"晴天\",\"artists\":[\"周杰伦\"],\"album\":\"叶惠美\",\"duration_ms\":269000}"
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
[[ $CODE == 200 ]] && ok "health $(py 'print(d.get("version"), "storage="+str(d.get("storage")))') (${MS}ms)" || { bad "health HTTP $CODE"; exit 1; }

call POST /api/search "{\"query\":\"晴天 周杰伦\",\"track\":$TRACK}"
SEARCH="$OUT"
[[ $CODE == 200 ]] && ok "search: $(py 'print(" | ".join("%s %s" % (g["provider"], g["error"] or len(g["candidates"])) for g in d["providers"]))') (${MS}ms)" || bad "search HTTP $CODE $OUT"

# Two different candidates that really have lyrics (preview), best scores first.
CANDS=()
while read -r cand && (( ${#CANDS[@]} < 2 )); do
  call POST /api/lyrics "{\"candidate\":$cand}"
  if [[ $CODE == 200 ]] && py 'sys.exit(0 if any(l["text"] for l in (d.get("lyrics") or {}).get("lines", [])) else 1)'; then
    CANDS+=("$cand")
    ok "preview $(printf '%s' "$cand" | python3 -c 'import json,sys;c=json.load(sys.stdin);print(c["provider"], c["id"], c["title"])'): $(py 'l=d["lyrics"];print(len(l["lines"]), "lines,", l["sync_type"])') (${MS}ms)"
  fi
done < <(printf '%s' "$SEARCH" | python3 -c 'import json,sys
d=json.load(sys.stdin); cs=sorted((c for g in d["providers"] for c in g["candidates"]), key=lambda c: -c["score"])
[print(json.dumps(c)) for c in cs[:8]]' 2>/dev/null)
(( ${#CANDS[@]} == 2 )) || { bad "need two candidates with lyrics, got ${#CANDS[@]}"; echo "passed $pass, failed $fail"; exit 1; }

cid() { printf '%s' "$1" | python3 -c 'import json,sys;c=json.load(sys.stdin);print(c["provider"]+":"+c["id"])'; }
stored() {  # prints provider:id of the stored match, or "none"
  call GET "/api/bindings/$ID"
  if [[ $CODE == 404 ]]; then echo none; else py 'b=d["binding"];print(b["match"]["provider"]+":"+b["match"]["id"])'; fi
}
for i in 0 1; do
  call POST /api/bind "{\"track\":$TRACK,\"candidate\":${CANDS[$i]}}"
  [[ $CODE == 200 ]] && ok "使用此歌词 #$((i + 1)) → $(py 'print(d["status"], "stored="+str(d.get("stored")))') (${MS}ms)" || bad "bind #$((i + 1)) HTTP $CODE $OUT"
  want="$(cid "${CANDS[$i]}")"; got="$(stored)"
  [[ $got == "$want" ]] && ok "stored object follows the latest choice: $got" || bad "stored $got, expected $want"
done
call GET "/api/bindings/$ID"
py 'b=d["binding"];print("     ", b["spotify_url"], "→", b["match"]["provider_name"], b["match"]["url"], "| bind_count", b["bind_count"], "|", b["lrc"].splitlines()[0][:40])'

call POST /api/match "{\"track\":$TRACK}"
[[ $CODE == 200 ]] && py 'sys.exit(0 if d.get("manual") and d.get("lyrics") else 1)' && ok "match serves the stored lyrics: $(py 'print(d["status"], len(d["lyrics"]["lines"]), "lines")') (${MS}ms)" || bad "match HTTP $CODE $(py 'print(d.get("status") or d.get("error"))')"

call POST /api/search "{\"query\":\"晴天 周杰伦\",\"track\":$TRACK}"
flag="$(py 'print(",".join(c["provider"]+":"+c["id"] for g in d["providers"] for c in g["candidates"] if c.get("bound")))')"
[[ $flag == "$(cid "${CANDS[1]}")" ]] && ok "search marks the bound result: $flag" || bad "bound flag: '$flag'"

call POST /api/match "{\"track\":{\"uri\":\"spotify:track:$ID\",\"title\":\"x\"},\"settings\":{}}"
[[ $CODE == 200 ]] && ok "binding is keyed by the Spotify track id (${MS}ms)" || bad "match by id HTTP $CODE"

if [[ -z ${KEEP:-} ]]; then
  call POST /api/unbind "{\"track\":$TRACK}"
  [[ $CODE == 200 && "$(stored)" == none ]] && ok "unbind removed the stored object" || bad "unbind HTTP $CODE"
fi
call POST /api/match '{}'
[[ $CODE == 400 ]] && ok "bad input rejected (400)" || bad "bad input HTTP $CODE"
OUT="$(curl -s -m 30 -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example' -X POST "$S/api/match" -d '{}')"
[[ $OUT == 403 ]] && ok "foreign origin rejected (403)" || bad "foreign origin HTTP $OUT"
echo "passed $pass, failed $fail"
[[ $fail == 0 ]]
