#!/usr/bin/env bash
# Spot-Lyric for Spotify — patches the Spotify desktop client (Linux / macOS)
# with a third-party lyrics page (NetEase / QQ Music via the Spot-Lyric lyrics server).
# Windows: use patch.cmd / patch.ps1.
#
# Portable to the bash 3.2 that ships with macOS: no readlink -f, getent,
# setsid, associative arrays, mapfile or ${x,,}.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
VERSION="$(cat "$ROOT/VERSION" 2>/dev/null || echo 0.0.0)"
DEFAULT_SERVER=https://spo.564616.xyz
SERVER="${SPOT_LYRIC_SERVER:-$DEFAULT_SERVER}"
SPOTIFY_PATH="${SPOTIFY_PATH:-}"
RESTART=auto
QUIET=0
PATCH_CHANGED=1
case "${SPOT_LYRIC_PLATFORM:-$(uname -s)}" in
  Darwin|macos) PLATFORM=macos ;;
  Linux|linux)  PLATFORM=linux ;;
  *) echo "不支持的系统：$(uname -s)（Windows 请使用 patch.cmd）" >&2; exit 1 ;;
esac
APT_HOOK_DIR=/usr/local/share/spot-lyric-patch
APT_HOOK_FILE=/etc/apt/apt.conf.d/99spot-lyric-patch

usage() {
  cat <<USAGE
Spot-Lyric for Spotify v$VERSION（Linux / macOS；Windows 请运行 patch.cmd）

用法: ./patch.sh [命令] [选项]

命令:
  install      给 Spotify 注入歌词插件，并清理旧版的本地代理（默认）
  apply        只给 Spotify 注入插件
  restore      还原 Spotify 原始文件
  uninstall    还原 Spotify，并移除钩子和旧版本地代理
  status       查看 Spotify 路径、版本、补丁和歌词服务器状态
  hook         自动重新注入：Linux 为 apt 钩子，macOS 为登录 / 更新时触发的 LaunchAgent
  unhook       移除钩子

选项:
  --spotify-path P     手动指定 Spotify 位置（Linux：含 Apps/xpui.spa 的目录；macOS：Spotify.app）
  --restart            完成后总是重启 Spotify
  --no-restart         不重启 Spotify
  --server URL         歌词服务器地址（默认 $DEFAULT_SERVER；自部署见 server/README.md）
  -q, --quiet          安静模式
  -h, --help           显示帮助
USAGE
}

say()  { [[ $QUIET == 1 ]] || printf '\033[1;32m[spot-lyric]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[spot-lyric]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[spot-lyric]\033[0m %s\n' "$*" >&2; exit 1; }

COMMAND=install
INTERNAL_APPS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    __patcher) INTERNAL_APPS="${2:?}"; shift 2; INTERNAL_ARGS=("$@"); break ;;   # privileged re-entry
    install|apply|restore|uninstall|status|hook|unhook) COMMAND="$1"; shift ;;
    --spotify-path) SPOTIFY_PATH="${2:?}"; shift 2 ;;
    --spotify-path=*) SPOTIFY_PATH="${1#*=}"; shift ;;
    --restart) RESTART=yes; shift ;;
    --no-restart) RESTART=no; shift ;;
    --server) SERVER="${2:?}"; shift 2 ;;
    --server=*) SERVER="${1#*=}"; shift ;;
    -q|--quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "未知参数：$1" ;;
  esac
done
SERVER="${SERVER%/}"
[[ $SERVER =~ ^https?://[A-Za-z0-9._~:/-]+$ ]] || die "歌词服务器地址无效：$SERVER（例如 https://lyrics.example.com）"

# ----------------------------------------------------------------- user ---
# User-level pieces (legacy proxy cleanup, Spotify restart) belong to the desktop user even
# when the script runs under sudo.
TARGET_USER="${SUDO_USER:-$(id -un)}"
TARGET_UID="$(id -u "$TARGET_USER")"
home_of() {
  local h=""
  command -v getent >/dev/null 2>&1 && h="$(getent passwd "$1" | cut -d: -f6)"
  [[ -z $h && $PLATFORM == macos ]] && h="$(dscl . -read "/Users/$1" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  [[ -z $h ]] && h="$(eval echo "~$1")"
  printf '%s' "$h"
}
TARGET_HOME="$(home_of "$TARGET_USER")"
as_user() {
  if [[ $(id -u) == "$TARGET_UID" ]]; then "$@"
  elif [[ $PLATFORM == linux ]]; then
    sudo -u "$TARGET_USER" XDG_RUNTIME_DIR="/run/user/$TARGET_UID" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$TARGET_UID/bus" HOME="$TARGET_HOME" "$@"
  else sudo -u "$TARGET_USER" HOME="$TARGET_HOME" "$@"
  fi
}
privileged() {
  if [[ $(id -u) == 0 ]]; then "$@"
  else say "需要管理员权限写入 Spotify 安装目录（sudo）"; sudo "$@"
  fi
}
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi; }
http_health() {  # prints the lyrics server version or nothing
  local body=""
  if command -v curl >/dev/null 2>&1; then body="$(curl -fsS -m 8 "$SERVER/health" 2>/dev/null || true)"
  elif command -v python3 >/dev/null 2>&1; then
    body="$(python3 -c 'import sys,urllib.request;print(urllib.request.urlopen(sys.argv[1]+"/health",timeout=8).read().decode())' "$SERVER" 2>/dev/null || true)"
  fi
  printf '%s' "$body" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p'
}

# --------------------------------------------------------------- detect ---
# Sets SPOTIFY_DIR (install / .app root) and APPS (directory holding xpui.spa).
apps_of() {
  if [[ $PLATFORM == macos ]]; then printf '%s/Contents/Resources/Apps' "$1"; else printf '%s/Apps' "$1"; fi
}
valid_install() { local a; a="$(apps_of "$1")"; [[ -n "$1" && ( -f "$a/xpui.spa" || -f "$a/xpui/index.html" ) ]]; }
detect_spotify() {
  local c
  if [[ -n $SPOTIFY_PATH ]]; then
    c="${SPOTIFY_PATH%/}"
    if [[ $PLATFORM == macos ]]; then
      case "$c" in */Contents/Resources) c="${c%/Contents/Resources}" ;; */Contents) c="${c%/Contents}" ;; esac
    fi
    valid_install "$c" || die "指定位置不是 Spotify：$SPOTIFY_PATH"
    SPOTIFY_DIR="$c"; APPS="$(apps_of "$c")"; return 0
  fi
  if [[ $PLATFORM == macos ]]; then
    for c in "$TARGET_HOME/Applications/Spotify.app" "/Applications/Spotify.app"; do
      valid_install "$c" && { SPOTIFY_DIR="$c"; APPS="$(apps_of "$c")"; return 0; }
    done
    return 1
  fi
  if command -v spotify >/dev/null 2>&1; then
    c="$(dirname "$(readlink -f "$(command -v spotify)")")"
    valid_install "$c" && { SPOTIFY_DIR="$c"; APPS="$(apps_of "$c")"; return 0; }
  fi
  if command -v dpkg >/dev/null 2>&1; then
    c="$(dpkg -L spotify-client 2>/dev/null | grep -m1 '/Apps/xpui.spa$' || true)"
    [[ -n $c ]] && { SPOTIFY_DIR="${c%/Apps/xpui.spa}"; APPS="$(apps_of "$SPOTIFY_DIR")"; return 0; }
  fi
  for c in /usr/share/spotify /opt/spotify /usr/lib/spotify /usr/local/share/spotify /usr/lib64/spotify-client \
      "$TARGET_HOME/.local/share/spotify" \
      "$TARGET_HOME/.local/share/flatpak/app/com.spotify.Client/current/active/files/extra/share/spotify" \
      /var/lib/flatpak/app/com.spotify.Client/current/active/files/extra/share/spotify \
      /snap/spotify/current/usr/share/spotify; do
    valid_install "$c" && { SPOTIFY_DIR="$(readlink -f "$c")"; APPS="$(apps_of "$SPOTIFY_DIR")"; return 0; }
  done
  return 1
}
spotify_version() {
  local v=""
  if [[ $PLATFORM == macos ]]; then
    v="$(defaults read "$SPOTIFY_DIR/Contents/Info" CFBundleShortVersionString 2>/dev/null ||
         plutil -extract CFBundleShortVersionString raw "$SPOTIFY_DIR/Contents/Info.plist" 2>/dev/null || true)"
  else
    command -v dpkg-query >/dev/null 2>&1 && v="$(dpkg-query -W -f='${Version}' spotify-client 2>/dev/null || true)"
    [[ -z $v && -x "$SPOTIFY_DIR/spotify" ]] && v="$(strings "$SPOTIFY_DIR/spotify" 2>/dev/null | grep -m1 -oE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.g[0-9a-f]+' || true)"
  fi
  printf '%s' "${v:-unknown}"
}

# ---------------------------------------------------------------- build ---
build_bundle() {
  local out="$1"
  mkdir -p "$out"
  {
    printf '/* Spot-Lyric for Spotify v%s - generated, do not edit */\n' "$VERSION"
    cat "$ROOT/src/core.js"
    printf '\n'
    sed -e "s/__SPOT_LYRIC_VERSION__/$VERSION/g" -e "s|__SPOT_LYRIC_SERVER__|$SERVER|g" "$ROOT/src/app.js"
  } > "$out/spot-lyric.js"
  cp "$ROOT/src/app.css" "$out/spot-lyric.css"
}

# ------------------------------------------------- patcher (zip / unzip) ---
# Same archive layout, marker and digest as tools/xpui_patch.py and patch.ps1.
# Used on macOS (python3 is not guaranteed there) and on Linux without python3.
ZP_BLOCK_RE='<!-- spot-lyric:start[^>]*-->.*<!-- spot-lyric:end -->'
zp_marker() { sed -n 's/.*<!-- spot-lyric:start v\([^ ]*\) sha=\([0-9a-f]*\) -->.*/\1 \2/p' | head -n1; }
zp_inject() {  # stdin html, $1 digest
  local block="<!-- spot-lyric:start v$VERSION sha=$1 --><link rel=\"stylesheet\" href=\"/spot-lyric/spot-lyric.css\"><script defer=\"defer\" src=\"/spot-lyric/spot-lyric.js\"></script><!-- spot-lyric:end -->"
  local html; html="$(sed -E "s#$ZP_BLOCK_RE##")"
  case "$html" in
    *"</body>"*) printf '%s' "${html%%</body>*}$block</body>${html#*</body>}" ;;
    *) printf '%s%s' "$html" "$block" ;;
  esac
}
zip_patcher() {
  local cmd="$1" apps="$2" folder spa backup html current digest stage tmp
  folder="$apps/xpui"; spa="$apps/xpui.spa"; backup="$spa.spot-lyric.bak"
  case "$cmd" in
    patch)
      local js="$3" css="$4"
      digest="$( { cat "$js"; printf '\0'; cat "$css"; } | sha256 | cut -c1-16)"
      if [[ -f "$folder/index.html" ]]; then
        current="$(zp_marker < "$folder/index.html")"
        [[ $current == "$VERSION $digest" ]] && { echo "UNCHANGED dir"; return 0; }
        mkdir -p "$folder/spot-lyric"
        cp "$js" "$css" "$folder/spot-lyric/"
        html="$(zp_inject "$digest" < "$folder/index.html")"
        printf '%s' "$html" > "$folder/index.html"
        echo "PATCHED dir $folder"; return 0
      fi
      [[ -f $spa ]] || { echo "xpui.spa not found in $apps"; return 1; }
      current="$(unzip -p "$spa" index.html | zp_marker)"
      [[ $current == "$VERSION $digest" ]] && { echo "UNCHANGED spa"; return 0; }
      if [[ -z $current ]]; then cp -p "$spa" "$backup"      # fresh / freshly updated archive = new original
      else [[ -f $backup ]] || { echo "xpui.spa is patched but the backup is missing; reinstall Spotify"; return 1; }
      fi
      stage="$(mktemp -d)"; tmp="$apps/.xpui-$$.spa"
      mkdir -p "$stage/spot-lyric"
      cp "$js" "$css" "$stage/spot-lyric/"
      unzip -p "$backup" index.html | zp_inject "$digest" > "$stage/index.html"
      cp -p "$backup" "$tmp"
      if ! ( cd "$stage" && zip -q -X "$tmp" index.html spot-lyric/spot-lyric.js spot-lyric/spot-lyric.css ); then
        rm -rf "$stage" "$tmp"; echo "zip failed"; return 1
      fi
      rm -rf "$stage"
      mv -f "$tmp" "$spa"
      echo "PATCHED spa $spa" ;;
    restore)
      local restored=""
      if [[ -f "$folder/index.html" ]]; then
        if [[ -n "$(zp_marker < "$folder/index.html")" ]]; then
          html="$(sed -E "s#$ZP_BLOCK_RE##" "$folder/index.html")"; printf '%s' "$html" > "$folder/index.html"; restored=1
        fi
        rm -rf "$folder/spot-lyric"
      fi
      if [[ -f $spa && -n "$(unzip -p "$spa" index.html | zp_marker)" ]]; then
        if [[ -f $backup ]]; then cp -p "$backup" "$spa.tmp" && mv -f "$spa.tmp" "$spa"
        else
          stage="$(mktemp -d)"
          unzip -p "$spa" index.html | sed -E "s#$ZP_BLOCK_RE##" > "$stage/index.html"
          ( cd "$stage" && zip -q -X "$spa" index.html && zip -q -d "$spa" 'spot-lyric/*' >/dev/null ) || true
          rm -rf "$stage"
        fi
        restored=1
      fi
      rm -f "$backup"
      [[ -n $restored ]] && echo RESTORED || echo NOT_PATCHED ;;
    status)
      if [[ -f "$folder/index.html" ]]; then current="$(zp_marker < "$folder/index.html")"
        [[ -n $current ]] && echo "dir patched v$current" || echo "dir not-patched"; return 0; fi
      [[ -f $spa ]] || { echo missing; return 0; }
      current="$(unzip -p "$spa" index.html | zp_marker)"
      printf '%s%s\n' "$([[ -n $current ]] && echo "spa patched v$current" || echo "spa not-patched")" "$([[ -f $backup ]] && echo " backup")" ;;
  esac
}
use_python_patcher() { [[ $PLATFORM == linux && ${SPOT_LYRIC_PATCHER:-} != zip ]] && command -v python3 >/dev/null 2>&1; }
patcher() {  # patcher <patch|restore|status> args...
  local cmd="$1"; shift
  if use_python_patcher; then
    case "$cmd" in
      patch) python3 "$ROOT/tools/xpui_patch.py" patch "$APPS" "$@" "$VERSION" ;;
      *) python3 "$ROOT/tools/xpui_patch.py" "$cmd" "$APPS" ;;
    esac
  else
    command -v unzip >/dev/null 2>&1 && command -v zip >/dev/null 2>&1 || die "需要 zip 和 unzip（或 python3）"
    zip_patcher "$cmd" "$APPS" "$@"
  fi
}
apps_writable() {
  [[ -w "$APPS" ]] && { [[ ! -e "$APPS/xpui.spa" ]] || [[ -w "$APPS/xpui.spa" || -O "$APPS" ]]; } &&
    { [[ ! -d "$APPS/xpui" ]] || [[ -w "$APPS/xpui" ]]; }
}
run_patcher() {
  if apps_writable; then patcher "$@"
  else
    # Re-run this script's patcher as root with the same environment.
    privileged env SPOT_LYRIC_PLATFORM="$PLATFORM" SPOT_LYRIC_PATCHER="${SPOT_LYRIC_PATCHER:-}" \
      bash "$ROOT/patch.sh" __patcher "$APPS" "$@"
  fi
}

# ------------------------------------------------------------ macOS sign ---
# Rewriting Contents/Resources invalidates Spotify's signature; Ventura and later
# refuse to start an app whose signature is broken. Re-sign ad hoc like SpotX.
macos_resign() {
  [[ $PLATFORM == macos ]] || return 0
  command -v codesign >/dev/null 2>&1 || { warn "未找到 codesign，跳过重新签名（如 Spotify 无法启动，请安装 Xcode Command Line Tools：xcode-select --install）"; return 0; }
  local run=""; [[ -w "$SPOTIFY_DIR" ]] || run=privileged
  $run xattr -cr "$SPOTIFY_DIR" 2>/dev/null || true
  if $run codesign -f --deep -s - "$SPOTIFY_DIR" >/dev/null 2>&1 && codesign --verify --deep --strict "$SPOTIFY_DIR" >/dev/null 2>&1; then
    say "已重新签名 Spotify.app（ad-hoc）"
  else
    warn "重新签名失败。若 Spotify 打不开，请运行：codesign -f --deep -s - \"$SPOTIFY_DIR\""
  fi
}
macos_permission_hint() {
  warn "写入被 macOS 拒绝（Operation not permitted）。"
  warn "请到 系统设置 > 隐私与安全性 > App 管理（或 完全磁盘访问权限）中允许当前终端 App，然后重新运行。"
}

do_apply() {
  local tmp result
  detect_spotify || die "没有找到 Spotify，请用 --spotify-path 指定（macOS 为 Spotify.app 路径）"
  [[ $SPOTIFY_DIR == /snap/* ]] && die "Snap 版 Spotify 是只读文件系统，无法注入。请改用 deb 或 flatpak 版本。"
  say "Spotify 位置：$SPOTIFY_DIR"
  say "Spotify 版本：$(spotify_version)"
  tmp="$(mktemp -d)"
  build_bundle "$tmp"
  if ! result="$(run_patcher patch "$tmp/spot-lyric.js" "$tmp/spot-lyric.css" 2>&1)"; then
    rm -rf "$tmp"
    [[ $PLATFORM == macos && $result == *"ermitted"* ]] && macos_permission_hint
    die "注入失败：$result"
  fi
  rm -rf "$tmp"
  case "$result" in
    *UNCHANGED*) say "插件已是最新（v$VERSION），无需修改"; PATCH_CHANGED=0 ;;
    *PATCHED*)   say "已注入歌词插件 v$VERSION → ${result##*PATCHED * }"; PATCH_CHANGED=1; macos_resign ;;
    *) [[ $PLATFORM == macos && $result == *"ermitted"* ]] && macos_permission_hint; die "注入失败：$result" ;;
  esac
}

# ------------------------------------------------------- legacy proxy ---
# Versions before 1.1 ran a local proxy (127.0.0.1:38917). Lyrics now come from
# the remote lyrics server, so remove the old service if it is still installed.
if [[ $PLATFORM == macos ]]; then
  PROXY_DIR="$TARGET_HOME/Library/Application Support/SpotLyric"
  AGENT_DIR="$TARGET_HOME/Library/LaunchAgents"
else
  PROXY_DIR="$TARGET_HOME/.local/share/spot-lyric-patch"
  UNIT_DIR="$TARGET_HOME/.config/systemd/user"
fi
PROXY_LABEL=com.spotlyric.proxy
REAPPLY_LABEL=com.spotlyric.reapply
have_user_systemd() { [[ $PLATFORM == linux ]] && as_user systemctl --user show-environment >/dev/null 2>&1; }
launch_agent() {  # launch_agent <label> <plist> : (re)load into the user's GUI session
  local domain="gui/$TARGET_UID"
  launchctl bootout "$domain/$1" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$2" 2>/dev/null || as_user launchctl load -w "$2" 2>/dev/null || warn "无法加载 LaunchAgent $1"
}
remove_legacy_proxy() {
  local found=""
  if [[ $PLATFORM == macos ]]; then
    if [[ -e "$AGENT_DIR/$PROXY_LABEL.plist" || -e "$PROXY_DIR/spot-lyric-proxy" ]]; then
      found=1
      launchctl bootout "gui/$TARGET_UID/$PROXY_LABEL" >/dev/null 2>&1 || as_user launchctl unload -w "$AGENT_DIR/$PROXY_LABEL.plist" 2>/dev/null || true
      as_user rm -f "$AGENT_DIR/$PROXY_LABEL.plist" "$PROXY_DIR/spot-lyric-proxy"
    fi
  else
    if [[ -e "$UNIT_DIR/spot-lyric-proxy.service" || -e "$UNIT_DIR/spot-lyric-proxy.socket" || -d "$PROXY_DIR" || -e "$TARGET_HOME/.config/autostart/spot-lyric-proxy.desktop" ]]; then
      found=1
      if have_user_systemd; then
        as_user systemctl --user disable --now spot-lyric-proxy.socket >/dev/null 2>&1 || true
        as_user systemctl --user disable --now spot-lyric-proxy.service >/dev/null 2>&1 || true
      fi
      as_user rm -f "$UNIT_DIR/spot-lyric-proxy.socket" "$UNIT_DIR/spot-lyric-proxy.service" \
        "$TARGET_HOME/.config/autostart/spot-lyric-proxy.desktop"
      as_user rm -rf "$PROXY_DIR"
      have_user_systemd && as_user systemctl --user daemon-reload || true
    fi
    # Only the installed proxy (python script or Go binary), not anything that mentions its name.
    pkill -u "$TARGET_UID" -f "^[^ ]*(python3?|env python3) [^ ]*$PROXY_DIR/spot-lyric-proxy\.py" 2>/dev/null || true
    pkill -u "$TARGET_UID" -f "^$PROXY_DIR/spot-lyric-proxy( |$)" 2>/dev/null || true
  fi
  [[ -n $found ]] && say "已移除旧版本地歌词代理（歌词现在由歌词服务器提供）"
  return 0
}
server_status() {
  local v; v="$(http_health)"
  if [[ -n $v ]]; then echo "歌词服务器：运行正常 v$v · $SERVER"
  else echo "歌词服务器：无法连接 $SERVER"; fi
}

# -------------------------------------------------------------- restart ---
spotify_running() {
  if [[ $PLATFORM == macos ]]; then pgrep -u "$TARGET_UID" -x Spotify >/dev/null 2>&1
  else pgrep -u "$TARGET_UID" -x spotify >/dev/null 2>&1; fi
}
stop_spotify() {
  if [[ $PLATFORM == macos ]]; then pkill -u "$TARGET_UID" -x Spotify || true
  else pkill -u "$TARGET_UID" -x spotify || true; fi
  local i; for i in $(seq 1 30); do spotify_running || return 0; sleep 0.2; done
}
start_spotify() {
  if [[ $PLATFORM == macos ]]; then as_user open -a "$SPOTIFY_DIR" || warn "请手动启动 Spotify"
  else
    local launcher=spotify
    command -v spotify >/dev/null 2>&1 || launcher="$SPOTIFY_DIR/spotify"
    if command -v setsid >/dev/null 2>&1; then as_user env DISPLAY="${DISPLAY:-:0}" setsid -f "$launcher" >/dev/null 2>&1 < /dev/null || warn "请手动启动 Spotify"
    else as_user env DISPLAY="${DISPLAY:-:0}" nohup "$launcher" >/dev/null 2>&1 < /dev/null & fi
  fi
}
restart_spotify() {
  [[ $RESTART == no ]] && return 0
  if spotify_running; then
    [[ $RESTART == auto && $PATCH_CHANGED == 0 ]] && return 0
    say "重启 Spotify 以加载插件…"
    stop_spotify; start_spotify
  elif [[ $RESTART == yes ]]; then start_spotify
  else say "下次启动 Spotify 时生效"; fi
}

# ----------------------------------------------------------------- hook ---
install_hook() {
  if [[ $PLATFORM == macos ]]; then
    detect_spotify || die "没有找到 Spotify"
    local dir="$PROXY_DIR/patcher" plist="$AGENT_DIR/$REAPPLY_LABEL.plist"
    as_user mkdir -p "$dir" "$AGENT_DIR" "$TARGET_HOME/Library/Logs"
    as_user cp -R "$ROOT/patch.sh" "$ROOT/VERSION" "$ROOT/src" "$dir/"
    # Runs at login and whenever Spotify's updater replaces xpui.spa.
    as_user tee "$plist" >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$REAPPLY_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$dir/patch.sh</string><string>apply</string><string>--quiet</string>
    <string>--no-restart</string><string>--server</string><string>$SERVER</string><string>--spotify-path</string><string>$SPOTIFY_DIR</string></array>
  <key>RunAtLoad</key><true/>
  <key>WatchPaths</key><array><string>$APPS/xpui.spa</string></array>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$TARGET_HOME/Library/Logs/spot-lyric-reapply.log</string>
  <key>StandardErrorPath</key><string>$TARGET_HOME/Library/Logs/spot-lyric-reapply.log</string>
</dict>
</plist>
PLIST
    launch_agent "$REAPPLY_LABEL" "$plist"
    say "已安装 LaunchAgent：登录时和 Spotify 更新 xpui.spa 后自动重新注入（日志 ~/Library/Logs/spot-lyric-reapply.log）"
    say "提示：如日志出现 Operation not permitted，请在 系统设置 > 隐私与安全性 > App 管理 中允许 bash"
    return 0
  fi
  [[ -d /etc/apt/apt.conf.d ]] || die "未检测到 apt，钩子仅适用于 deb 安装"
  privileged mkdir -p "$APT_HOOK_DIR"
  privileged cp -r "$ROOT/patch.sh" "$ROOT/VERSION" "$ROOT/src" "$ROOT/tools" "$APT_HOOK_DIR/"
  privileged chmod -R a+rX "$APT_HOOK_DIR"
  printf '%s\n' "DPkg::Post-Invoke { \"if [ -x $APT_HOOK_DIR/patch.sh ] && command -v spotify >/dev/null 2>&1; then $APT_HOOK_DIR/patch.sh apply --quiet --no-restart --server $SERVER || true; fi\"; };" \
    | privileged tee "$APT_HOOK_FILE" >/dev/null
  say "已安装 apt 钩子：$APT_HOOK_FILE（spotify-client 升级后自动重新注入）"
}
remove_hook() {
  if [[ $PLATFORM == macos ]]; then
    launchctl bootout "gui/$TARGET_UID/$REAPPLY_LABEL" >/dev/null 2>&1 || true
    as_user rm -rf "$AGENT_DIR/$REAPPLY_LABEL.plist" "$PROXY_DIR/patcher"
    say "已移除 LaunchAgent 钩子"; return 0
  fi
  if [[ -e $APT_HOOK_FILE || -d $APT_HOOK_DIR ]]; then privileged rm -rf "$APT_HOOK_FILE" "$APT_HOOK_DIR"; say "已移除 apt 钩子"; fi
}
hook_status() {
  if [[ $PLATFORM == macos ]]; then [[ -f "$AGENT_DIR/$REAPPLY_LABEL.plist" ]] && echo "自动重新注入：已安装（LaunchAgent）" || echo "自动重新注入：未安装"
  else [[ -e $APT_HOOK_FILE ]] && echo "apt 钩子：已安装" || echo "apt 钩子：未安装"; fi
}

# ----------------------------------------------------------------- main ---
if [[ -n $INTERNAL_APPS ]]; then APPS="$INTERNAL_APPS"; patcher "${INTERNAL_ARGS[@]}"; exit $?; fi
case "$COMMAND" in
  install)
    do_apply
    remove_legacy_proxy
    restart_spotify
    say "完成！在 Spotify 底部播放栏（官方歌词按钮左侧）点击新的歌词图标打开歌词页。"
    ;;
  apply)
    do_apply
    restart_spotify
    ;;
  restore|uninstall)
    detect_spotify || die "没有找到 Spotify"
    result="$(run_patcher restore)" || die "还原失败：$result"
    if [[ $result == *RESTORED* ]]; then say "已还原 Spotify 原始文件"; macos_resign; else say "Spotify 未被修改，无需还原"; fi
    if [[ $COMMAND == uninstall ]]; then remove_legacy_proxy; remove_hook; fi
    PATCH_CHANGED=1; [[ $result == *RESTORED* ]] && restart_spotify
    ;;
  status)
    if detect_spotify; then
      echo "系统：$PLATFORM"
      echo "Spotify：$SPOTIFY_DIR"
      echo "版本：$(spotify_version)"
      echo "补丁：$(patcher status)"
    else echo "Spotify：未找到"; fi
    echo "插件版本：v$VERSION"
    server_status
    hook_status
    ;;
  hook) install_hook ;;
  unhook) remove_hook ;;
esac
