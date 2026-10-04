#!/usr/bin/env bash
# End-to-end patcher test (spot-lyric, built from this checkout) on copies of real Spotify archives.
#   tests/patch_test.sh <dir-with-installers-unpacked>   (see README "测试")
# Expects (any subset):  linux/xpui.spa  win/Apps/xpui.spa  mac/Spotify.app/Contents/Resources/Apps/xpui.spa
# Runs in a throw-away HOME: the real user configuration is never touched.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SRC="${1:?usage: patch_test.sh <unpacked-installers-dir>}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/spot-lyric"
(cd "$ROOT" && CGO_ENABLED=0 go build -o "$BIN" ./cmd/spot-lyric)
export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" XDG_DATA_HOME="$WORK/home/.local/share" NO_COLOR=1
mkdir -p "$HOME"
pass=0; fail=0
ok()   { pass=$((pass + 1)); printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad()  { fail=$((fail + 1)); printf '  \033[31m✘\033[0m %s\n' "$*"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
marker() { unzip -p "$1" index.html | sed -n 's/.*<!-- spot-lyric:start v\([^ ]*\) sha=\([0-9a-f]*\) -->.*/\1 \2/p'; }
sha() { sha256sum "$1" | cut -c1-16; }

run_suite() {  # name platform spotify_path apps_dir original_spa
  local name="$1" platform="$2" path="$3" apps="$4" orig="$5" out m1 m2 m3
  echo "== $name ($platform)"
  local sl=(env SPOT_LYRIC_PLATFORM="$platform" "$BIN")
  out="$("${sl[@]}" apply --yes --mode cloud --no-restart --spotify-path "$path" 2>&1)"
  check "apply injects" '[[ $out == *已注入* ]]'
  m1="$(marker "$apps/xpui.spa")"
  check "marker present ($m1)" '[[ -n $m1 ]]'
  check "assets in archive" 'unzip -l "$apps/xpui.spa" | grep -q spot-lyric/spot-lyric.js && unzip -l "$apps/xpui.spa" | grep -q spot-lyric/spot-lyric.css'
  check "single injection block" '[[ $(unzip -p "$apps/xpui.spa" index.html | grep -o "spot-lyric:start" | wc -l) -eq 1 ]]'
  check "script tag before </body>" 'unzip -p "$apps/xpui.spa" index.html | grep -q "src=\"/spot-lyric/spot-lyric.js\"></script><!-- spot-lyric:end --></body>"'
  check "archive integrity" 'unzip -tqq "$apps/xpui.spa"'
  check "original entries kept" '[[ $(unzip -Z1 "$apps/xpui.spa" | grep -vc "^spot-lyric/") -eq $(unzip -Z1 "$orig" | wc -l) ]]'
  check "backup equals original" '[[ $(sha "$apps/xpui.spa.spot-lyric.bak") == $(sha "$orig") ]]'
  check "cloud mode baked in" '[[ $(unzip -p "$apps/xpui.spa" spot-lyric/spot-lyric.js | grep -c "const PATCH_MODE = '"'"'cloud'"'"'") -eq 1 ]]'
  out="$("${sl[@]}" apply --yes --mode cloud --no-restart --spotify-path "$path" 2>&1)"
  check "second apply is a no-op" '[[ $out == *无需修改* ]]'
  out="$("${sl[@]}" apply --yes --mode local --no-restart --spotify-path "$path" 2>&1)"
  m3="$(marker "$apps/xpui.spa")"
  check "pure local build differs ($m3)" '[[ $out == *已注入* && $m3 != "$m1" ]]'
  check "local mode baked in" '[[ $(unzip -p "$apps/xpui.spa" spot-lyric/spot-lyric.js | grep -c "const PATCH_MODE = '"'"'local'"'"'") -eq 1 ]]'
  check "still one block" '[[ $(unzip -p "$apps/xpui.spa" index.html | grep -o "spot-lyric:start" | wc -l) -eq 1 ]]'
  "${sl[@]}" apply --yes --mode cloud --no-restart --spotify-path "$path" >/dev/null 2>&1
  out="$("${sl[@]}" status --spotify-path "$path" 2>&1)"
  check "status reports patch" '[[ $out == *"已注入 v${m1%% *}"* ]]'
  cp "$orig" "$apps/xpui.spa"   # Spotify self-update replaces the archive
  "${sl[@]}" apply --yes --mode cloud --no-restart --spotify-path "$path" >/dev/null 2>&1
  m2="$(marker "$apps/xpui.spa")"
  check "re-patched after update" '[[ $m2 == "$m1" ]]'
  out="$("${sl[@]}" restore --no-restart --spotify-path "$path" 2>&1)"
  check "restore" '[[ $out == *已还原* ]]'
  check "restored byte-identical" '[[ $(sha "$apps/xpui.spa") == $(sha "$orig") ]]'
  check "backup removed" '[[ ! -e "$apps/xpui.spa.spot-lyric.bak" ]]'
  DIGESTS+=("$name=${m1#* }")
}

DIGESTS=()
if [[ -f "$SRC/linux/xpui.spa" ]]; then
  d="$WORK/linux"; mkdir -p "$d/Apps"; cp "$SRC/linux/xpui.spa" "$d/Apps/"
  run_suite "linux" linux "$d" "$d/Apps" "$SRC/linux/xpui.spa"
fi
if [[ -f "$SRC/mac/Spotify.app/Contents/Resources/Apps/xpui.spa" ]]; then
  app="$WORK/Applications/Spotify.app"; mkdir -p "$app/Contents/Resources/Apps"
  cp "$SRC/mac/Spotify.app/Contents/Info.plist" "$app/Contents/" 2>/dev/null || true
  cp "$SRC/mac/Spotify.app/Contents/Resources/Apps/xpui.spa" "$app/Contents/Resources/Apps/"
  run_suite "macOS" macos "$app" "$app/Contents/Resources/Apps" "$SRC/mac/Spotify.app/Contents/Resources/Apps/xpui.spa"
  out="$(env SPOT_LYRIC_PLATFORM=macos "$BIN" status --spotify-path "$app/Contents/Resources" 2>&1)"
  check "macOS: --spotify-path accepts Contents/Resources" '[[ $out == *"Spotify：$app"* ]]'
  out="$(env SPOT_LYRIC_PLATFORM=macos "$BIN" install --yes --mode direct --no-restart --spotify-path "$app" 2>&1 || true)"
  check "macOS: direct mode refused" '[[ $out == *不支持直连* ]]'
fi
if [[ -f "$SRC/win/Apps/xpui.spa" ]]; then
  d="$WORK/win/Spotify"; mkdir -p "$d/Apps"; cp "$SRC/win/Apps/xpui.spa" "$d/Apps/"
  run_suite "windows archive" linux "$d" "$d/Apps" "$SRC/win/Apps/xpui.spa"
fi
echo "== cross-platform marker"
printf '   %s\n' "${DIGESTS[@]}"
uniq_count="$(printf '%s\n' "${DIGESTS[@]}" | cut -d= -f2 | sort -u | wc -l | tr -d ' ')"
check "all platforms produce the same build digest" '[[ $uniq_count -eq 1 ]]'
echo
echo "passed $pass, failed $fail"
[[ $fail -eq 0 ]]
