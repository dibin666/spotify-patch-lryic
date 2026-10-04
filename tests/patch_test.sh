#!/usr/bin/env bash
# End-to-end patcher test on copies of real Spotify archives.
#   tests/patch_test.sh <dir-with-installers-unpacked>   (see README "测试")
# Expects (any subset):  linux/xpui.spa  win/Apps/xpui.spa  mac/Spotify.app/Contents/Resources/Apps/xpui.spa
# Env: BASH_BIN (default bash), PWSH (path to pwsh for the Windows patcher)
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SRC="${1:?usage: patch_test.sh <unpacked-installers-dir>}"
BASH_BIN="${BASH_BIN:-bash}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
pass=0; fail=0
ok()   { pass=$((pass + 1)); printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad()  { fail=$((fail + 1)); printf '  \033[31m✘\033[0m %s\n' "$*"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
marker() { unzip -p "$1" index.html | sed -n 's/.*<!-- spot-lyric:start v\([^ ]*\) sha=\([0-9a-f]*\) -->.*/\1 \2/p'; }
sha() { sha256sum "$1" | cut -c1-16; }

run_unix_suite() {  # name platform patcher spotify_path apps_dir original_spa
  local name="$1" platform="$2" patcher="$3" path="$4" apps="$5" orig="$6" out m1 m2
  echo "== $name ($platform, $patcher patcher, bash $("$BASH_BIN" -c 'echo $BASH_VERSION'))"
  local env=(env SPOT_LYRIC_PLATFORM="$platform" SPOT_LYRIC_PATCHER="$patcher")
  out="$("${env[@]}" "$BASH_BIN" "$ROOT/patch.sh" apply --no-restart --spotify-path "$path" 2>&1)"
  check "apply injects" '[[ $out == *已注入* ]]'
  m1="$(marker "$apps/xpui.spa")"
  check "marker present ($m1)" '[[ -n $m1 ]]'
  check "assets in archive" 'unzip -l "$apps/xpui.spa" | grep -q spot-lyric/spot-lyric.js && unzip -l "$apps/xpui.spa" | grep -q spot-lyric/spot-lyric.css'
  check "single injection block" '[[ $(unzip -p "$apps/xpui.spa" index.html | grep -o "spot-lyric:start" | wc -l) -eq 1 ]]'
  check "script tag before </body>" 'unzip -p "$apps/xpui.spa" index.html | grep -q "src=\"/spot-lyric/spot-lyric.js\"></script><!-- spot-lyric:end --></body>"'
  check "archive integrity" 'unzip -tqq "$apps/xpui.spa"'
  check "original entries kept" '[[ $(unzip -Z1 "$apps/xpui.spa" | grep -vc "^spot-lyric/") -eq $(unzip -Z1 "$orig" | wc -l) ]]'
  check "backup equals original" '[[ $(sha "$apps/xpui.spa.spot-lyric.bak") == $(sha "$orig") ]]'
  out="$("${env[@]}" "$BASH_BIN" "$ROOT/patch.sh" apply --no-restart --spotify-path "$path" 2>&1)"
  check "second apply is a no-op" '[[ $out == *无需修改* ]]'
  out="$("${env[@]}" "$BASH_BIN" "$ROOT/patch.sh" status --spotify-path "$path" 2>&1)"
  check "status reports patch" '[[ $out == *"spa patched v$m1"* ]]'
  cp "$orig" "$apps/xpui.spa"   # Spotify self-update replaces the archive
  "${env[@]}" "$BASH_BIN" "$ROOT/patch.sh" apply --no-restart --spotify-path "$path" >/dev/null 2>&1
  m2="$(marker "$apps/xpui.spa")"
  check "re-patched after update" '[[ $m2 == "$m1" ]]'
  out="$("${env[@]}" "$BASH_BIN" "$ROOT/patch.sh" restore --no-restart --spotify-path "$path" 2>&1)"
  check "restore" '[[ $out == *已还原* ]]'
  check "restored byte-identical" '[[ $(sha "$apps/xpui.spa") == $(sha "$orig") ]]'
  check "backup removed" '[[ ! -e "$apps/xpui.spa.spot-lyric.bak" ]]'
  DIGESTS+=("$name=${m1#* }")
}

DIGESTS=()
if [[ -f "$SRC/linux/xpui.spa" ]]; then
  for p in python zip; do
    d="$WORK/linux-$p"; mkdir -p "$d/Apps"; cp "$SRC/linux/xpui.spa" "$d/Apps/"
    run_unix_suite "linux 1.2.x" linux "$p" "$d" "$d/Apps" "$SRC/linux/xpui.spa"
  done
fi
if [[ -f "$SRC/mac/Spotify.app/Contents/Resources/Apps/xpui.spa" ]]; then
  app="$WORK/Applications/Spotify.app"; mkdir -p "$app/Contents/Resources/Apps"
  cp "$SRC/mac/Spotify.app/Contents/Info.plist" "$app/Contents/" 2>/dev/null || true
  cp "$SRC/mac/Spotify.app/Contents/Resources/Apps/xpui.spa" "$app/Contents/Resources/Apps/"
  run_unix_suite "macOS 1.3.x" macos zip "$app" "$app/Contents/Resources/Apps" "$SRC/mac/Spotify.app/Contents/Resources/Apps/xpui.spa"
  # Also accept the .../Contents/Resources form of --spotify-path
  out="$(env SPOT_LYRIC_PLATFORM=macos "$BASH_BIN" "$ROOT/patch.sh" status --spotify-path "$app/Contents/Resources" 2>&1)"
  check "macOS: --spotify-path accepts Contents/Resources" '[[ $out == *"Spotify：$app"* ]]'
fi
if [[ -f "$SRC/win/Apps/xpui.spa" ]]; then
  d="$WORK/win/Spotify"; mkdir -p "$d/Apps"; cp "$SRC/win/Apps/xpui.spa" "$d/Apps/"
  run_unix_suite "windows archive via unix patcher" linux zip "$d" "$d/Apps" "$SRC/win/Apps/xpui.spa"
  if [[ -n "${PWSH:-}" ]]; then
    d="$WORK/win-ps/Spotify"; mkdir -p "$d/Apps"; cp "$SRC/win/Apps/xpui.spa" "$d/Apps/"
    echo "== windows 1.3.x (patch.ps1 via $("$PWSH" -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'))"
    out="$("$PWSH" -NoProfile -File "$ROOT/patch.ps1" apply -SpotifyPath "$d" 2>&1)"
    check "ps1 apply injects" '[[ $out == *已注入* ]]'
    m1="$(marker "$d/Apps/xpui.spa")"
    check "ps1 archive integrity" 'unzip -tqq "$d/Apps/xpui.spa"'
    out="$("$PWSH" -NoProfile -File "$ROOT/patch.ps1" apply -SpotifyPath "$d" 2>&1)"
    check "ps1 second apply is a no-op" '[[ $out == *无需修改* ]]'
    "$PWSH" -NoProfile -File "$ROOT/patch.ps1" restore -SpotifyPath "$d" >/dev/null 2>&1
    check "ps1 restored byte-identical" '[[ $(sha "$d/Apps/xpui.spa") == $(sha "$SRC/win/Apps/xpui.spa") ]]'
    DIGESTS+=("patch.ps1=${m1#* }")
  fi
fi
echo "== cross-platform marker"
printf '   %s\n' "${DIGESTS[@]}"
uniq_count="$(printf '%s\n' "${DIGESTS[@]}" | cut -d= -f2 | sort -u | wc -l | tr -d ' ')"
check "all patchers produce the same build digest" '[[ $uniq_count -eq 1 ]]'
echo
echo "passed $pass, failed $fail"
[[ $fail -eq 0 ]]
