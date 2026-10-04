#!/usr/bin/env bash
# End-to-end patcher test: patch.sh (pure sh: no python / zip / unzip) and patch.ps1 on
# copies of Spotify archives, in a throw-away HOME (the real user configuration is never touched).
# The test itself uses zip / unzip to build and check archives.
#   tests/patch_test.sh [dir-with-installers-unpacked]
# Expects (any subset):  linux/xpui.spa  win/Apps/xpui.spa  mac/Spotify.app/Contents/Resources/Apps/xpui.spa
# Without a directory a small synthetic xpui.spa is used for all three layouts (CI).
# Env: BASH_BIN (default bash), PWSH (pwsh for the Windows patcher; found on PATH if unset)
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
BASH_BIN="${BASH_BIN:-bash}"
PWSH="${PWSH:-$(command -v pwsh || true)}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" XDG_DATA_HOME="$WORK/home/.local/share" SPOT_LYRIC_DATA="$WORK/data" NO_COLOR=1
mkdir -p "$HOME"
SRC="${1:-}"
if [[ -z $SRC ]]; then
  SRC="$WORK/src"; mkdir -p "$SRC/linux" "$SRC/win/Apps" "$SRC/mac/Spotify.app/Contents/Resources/Apps"
  ( mkdir -p "$WORK/gen/images" && cd "$WORK/gen" &&
    printf '<!doctype html><html><head></head><body><div id="main"></div></body></html>' > index.html &&
    for i in $(seq 1 500); do echo "console.log('spotify');"; done > xpui.js && printf '<svg/>' > images/a.svg &&
    zip -q -X "$SRC/linux/xpui.spa" index.html xpui.js images/a.svg )
  cp "$SRC/linux/xpui.spa" "$SRC/win/Apps/"; cp "$SRC/linux/xpui.spa" "$SRC/mac/Spotify.app/Contents/Resources/Apps/"
fi
pass=0; fail=0
ok()   { pass=$((pass + 1)); printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad()  { fail=$((fail + 1)); printf '  \033[31m✘\033[0m %s\n' "$*"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
# run CMD...: output in $out; a failing command shows its output instead of ending the test.
run() { out="$("$@" 2>&1)" && return 0; printf '    | %s\n' "command failed: $*" "$(printf '%s' "$out" | tail -n 15)"; return 0; }
marker() { unzip -p "$1" index.html | sed -n 's/.*<!-- spot-lyric:start v\([^ ]*\) sha=\([0-9a-f]*\) -->.*/\1 \2/p'; }
baked() { unzip -p "$1" spot-lyric/spot-lyric.js | grep -c "const PATCH_MODE = '$2'" || true; }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -c1-16; }

# patch.sh must not need python / zip / unzip: shadow them with tools that fail loudly.
mkdir -p "$WORK/shim"
for t in python python3 zip unzip; do printf '#!/bin/sh\necho "patch.sh used %s" >&2\nexit 99\n' "$t" > "$WORK/shim/$t"; chmod +x "$WORK/shim/$t"; done
run_unix_suite() {  # name platform spotify_path apps_dir original_spa
  local name="$1" platform="$2" path="$3" apps="$4" orig="$5" out m1 m2 m3
  echo "== $name ($platform, bash $("$BASH_BIN" -c 'echo $BASH_VERSION'))"
  local sh=(env PATH="$WORK/shim:$PATH" SPOT_LYRIC_PLATFORM="$platform" "$BASH_BIN" "$ROOT/patch.sh")
  run "${sh[@]}" apply --yes --mode cloud --no-restart --spotify-path "$path"
  check "apply injects" '[[ $out == *已注入* && $out != *"patch.sh used"* ]]'
  m1="$(marker "$apps/xpui.spa")"
  check "marker present ($m1)" '[[ -n $m1 ]]'
  check "assets in archive" 'unzip -l "$apps/xpui.spa" | grep -q spot-lyric/spot-lyric.js && unzip -l "$apps/xpui.spa" | grep -q spot-lyric/spot-lyric.css'
  check "single injection block" '[[ $(unzip -p "$apps/xpui.spa" index.html | grep -o "spot-lyric:start" | wc -l) -eq 1 ]]'
  check "script tag before </body>" 'unzip -p "$apps/xpui.spa" index.html | grep -q "src=\"/spot-lyric/spot-lyric.js\"></script><!-- spot-lyric:end --></body>"'
  check "archive integrity" 'unzip -tqq "$apps/xpui.spa"'
  check "original entries kept" '[[ $(unzip -Z1 "$apps/xpui.spa" | grep -vc "^spot-lyric/") -eq $(unzip -Z1 "$orig" | wc -l) ]]'
  check "original entries unchanged" '(for f in $(unzip -Z1 "$orig" | grep -v "^index.html$" | head -n 20); do [[ $(unzip -p "$orig" "$f" | cksum) == $(unzip -p "$apps/xpui.spa" "$f" | cksum) ]] || exit 1; done)'
  check "backup equals original" '[[ $(sha "$apps/xpui.spa.spot-lyric.bak") == $(sha "$orig") ]]'
  check "cloud mode baked in" '[[ $(baked "$apps/xpui.spa" cloud) -eq 1 ]]'
  run "${sh[@]}" apply --yes --mode cloud --no-restart --spotify-path "$path"
  check "second apply is a no-op" '[[ $out == *无需修改* ]]'
  run "${sh[@]}" apply --yes --mode local --no-restart --spotify-path "$path"
  m3="$(marker "$apps/xpui.spa")"
  check "pure local build differs" '[[ $out == *已注入* && $m3 != "$m1" && $(baked "$apps/xpui.spa" local) -eq 1 ]]'
  check "apply never fetches the local service" '[[ $out != *下载本地服务* && $out != *编译本地服务* && ! -e $SPOT_LYRIC_DATA/spot-lyric-server ]]'
  "${sh[@]}" apply --yes --mode cloud --no-restart --spotify-path "$path" >/dev/null 2>&1 || true
  run "${sh[@]}" status --spotify-path "$path"
  check "status reports patch" '[[ $out == *"已注入 v${m1%% *}"* ]]'
  cp "$orig" "$apps/xpui.spa"   # Spotify self-update replaces the archive
  "${sh[@]}" apply --yes --mode cloud --no-restart --spotify-path "$path" >/dev/null 2>&1 || true
  m2="$(marker "$apps/xpui.spa")"
  check "re-patched after update" '[[ $m2 == "$m1" ]]'
  run "${sh[@]}" restore --no-restart --spotify-path "$path"
  check "restore" '[[ $out == *已还原* ]]'
  check "restored byte-identical" '[[ $(sha "$apps/xpui.spa") == $(sha "$orig") ]]'
  check "backup removed" '[[ ! -e "$apps/xpui.spa.spot-lyric.bak" ]]'
  "${sh[@]}" apply --yes --mode cloud --no-restart --spotify-path "$path" >/dev/null 2>&1 || true
  rm -f "$apps/xpui.spa.spot-lyric.bak"
  run "${sh[@]}" restore --no-restart --spotify-path "$path"
  check "restore without backup strips the plugin" '[[ $out == *已还原* ]] && unzip -tqq "$apps/xpui.spa" && [[ $(unzip -Z1 "$apps/xpui.spa" | grep -c "^spot-lyric/") -eq 0 && -z $(marker "$apps/xpui.spa") ]]'
  DIGESTS+=("$name=${m1#* }")
}

DIGESTS=()
if [[ -f "$SRC/linux/xpui.spa" ]]; then
  d="$WORK/linux"; mkdir -p "$d/Apps"; cp "$SRC/linux/xpui.spa" "$d/Apps/"
  run_unix_suite "linux" linux "$d" "$d/Apps" "$SRC/linux/xpui.spa"
fi
if [[ -f "$SRC/mac/Spotify.app/Contents/Resources/Apps/xpui.spa" ]]; then
  app="$WORK/Applications/Spotify.app"; mkdir -p "$app/Contents/Resources/Apps"
  cp "$SRC/mac/Spotify.app/Contents/Info.plist" "$app/Contents/" 2>/dev/null || true
  cp "$SRC/mac/Spotify.app/Contents/Resources/Apps/xpui.spa" "$app/Contents/Resources/Apps/"
  run_unix_suite "macOS" macos "$app" "$app/Contents/Resources/Apps" "$SRC/mac/Spotify.app/Contents/Resources/Apps/xpui.spa"
  out="$(env SPOT_LYRIC_PLATFORM=macos "$BASH_BIN" "$ROOT/patch.sh" status --spotify-path "$app/Contents/Resources" 2>&1 || true)"
  check "macOS: --spotify-path accepts Contents/Resources" '[[ $out == *"Spotify：$app"* ]]'
  out="$(env SPOT_LYRIC_PLATFORM=macos "$BASH_BIN" "$ROOT/patch.sh" install --yes --mode direct --no-restart --spotify-path "$app" 2>&1 || true)"
  check "macOS: direct mode refused" '[[ $out == *不支持直连* ]]'
fi
if [[ -f "$SRC/win/Apps/xpui.spa" ]]; then
  d="$WORK/win/Spotify"; mkdir -p "$d/Apps"; cp "$SRC/win/Apps/xpui.spa" "$d/Apps/"
  run_unix_suite "windows archive" linux "$d" "$d/Apps" "$SRC/win/Apps/xpui.spa"
  if [[ -n $PWSH ]]; then
    d="$WORK/win-ps/Spotify"; mkdir -p "$d/Apps"; cp "$SRC/win/Apps/xpui.spa" "$d/Apps/"
    echo "== windows (patch.ps1 via pwsh $("$PWSH" -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'))"
    ps=("$PWSH" -NoProfile -File "$ROOT/patch.ps1")
    run "${ps[@]}" apply --yes --mode cloud --spotify-path "$d"
    check "ps1 apply injects" '[[ $out == *已注入* ]]'
    m1="$(marker "$d/Apps/xpui.spa")"
    check "ps1 archive integrity" 'unzip -tqq "$d/Apps/xpui.spa"'
    check "ps1 cloud mode baked in" '[[ $(baked "$d/Apps/xpui.spa" cloud) -eq 1 ]]'
    run "${ps[@]}" apply --yes --mode cloud --spotify-path "$d"
    check "ps1 second apply is a no-op" '[[ $out == *无需修改* ]]'
    run "${ps[@]}" -Server https://lyrics.example.com -NoRestart -SpotifyPath "$d" apply -y
    check "ps1 accepts the old -Server / -SpotifyPath style" '[[ $out == *已注入* ]] && unzip -p "$d/Apps/xpui.spa" spot-lyric/spot-lyric.js | grep -c "https://lyrics.example.com" >/dev/null'
    run "${ps[@]}" apply --yes --mode local --spotify-path "$d"
    check "ps1 pure local build" '[[ $(baked "$d/Apps/xpui.spa" local) -eq 1 ]]'
    run "${ps[@]}" status --spotify-path "$d"
    check "ps1 status" '[[ $out == *已注入* ]]'
    out="$("${ps[@]}" --mode nope 2>&1 || true)"
    check "ps1 rejects unknown modes" '[[ $out == *未知的使用方式* ]]'
    "${ps[@]}" apply --yes --mode cloud --spotify-path "$d" >/dev/null 2>&1 || true
    "${ps[@]}" restore --spotify-path "$d" >/dev/null 2>&1 || true
    check "ps1 restored byte-identical" '[[ $(sha "$d/Apps/xpui.spa") == $(sha "$SRC/win/Apps/xpui.spa") ]]'
    DIGESTS+=("patch.ps1=${m1#* }")
  fi
fi
out="$("$BASH_BIN" "$ROOT/patch.sh" --mode nope 2>&1 || true)"
check "patch.sh rejects unknown modes" '[[ $out == *未知的使用方式* ]]'
out="$("$BASH_BIN" "$ROOT/patch.sh" -NoRestart -SpotifyPath /nonexistent apply 2>&1 || true)"
check "patch.sh accepts the PowerShell option style" '[[ $out == *"指定位置不是 Spotify：/nonexistent"* ]]'
echo "== cross-platform marker (cloud build)"
printf '   %s\n' "${DIGESTS[@]}"
uniq_count="$(printf '%s\n' "${DIGESTS[@]}" | cut -d= -f2 | sort -u | wc -l | tr -d ' ')"
check "all patchers produce the same build digest" '[[ $uniq_count -eq 1 ]]'
echo
echo "passed $pass, failed $fail"
[[ $fail -eq 0 ]]
