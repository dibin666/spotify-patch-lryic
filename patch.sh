#!/usr/bin/env bash
# Spot-Lyric for Spotify — patches the Spotify desktop client (macOS / Linux) with a
# third-party lyrics page (NetEase / QQ Music, matched on this machine).
# Windows: patch.cmd / patch.ps1 — same commands, options and guided steps.
#
# Usage modes (asked step by step, or --mode):
#   cloud   lyrics server stores shared matches (default); NetEase / QQ requests (--request)
#           go direct (--disable-web-security, Linux) or through the lyrics server relay
#   local   pure local: the local service (spot-lyric-server on 127.0.0.1:38917,
#           downloaded / built only for this mode) relays NetEase / QQ requests
#   direct  pure local without the service: --disable-web-security (advanced, Linux only)
# The plugin always prefers local paths: direct -> local service -> lyrics server.
#
# Portable to the bash 3.2 that ships with macOS: no readlink -f, getent,
# setsid, associative arrays, mapfile or ${x,,}.
set -Eeuo pipefail

REPO=dibin666/spotify-patch-lryic
ROOT=""
if [[ -n ${BASH_SOURCE[0]:-} && -f ${BASH_SOURCE[0]} ]]; then ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"; fi

# ------------------------------------------------------------ bootstrap ---
# Run without a checkout (curl ... | bash): fetch the sources, then run them.
if [[ -z $ROOT || ! -f $ROOT/src/app.js ]]; then
  tmp="$(mktemp -d)"
  # Only the scripts and the plugin sources (a few hundred KB); the local service program is
  # fetched later and only for the pure local mode.
  printf '\033[1;32m[spot-lyric]\033[0m 获取最新的补丁脚本与歌词插件（github.com/%s）…\n' "$REPO" >&2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar xz -C "$tmp" --strip-components=1
  else
    wget -qO- "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar xz -C "$tmp" --strip-components=1
  fi
  [[ -f $tmp/patch.sh ]] || { echo "[spot-lyric] 下载失败" >&2; exit 1; }
  # Prompts need the terminal even though this script arrived through a pipe.
  if [[ ! -t 0 ]] && { : < /dev/tty; } 2>/dev/null; then exec bash "$tmp/patch.sh" "$@" < /dev/tty; fi
  exec bash "$tmp/patch.sh" "$@"
fi

VERSION="$(tr -d ' \r\n' < "$ROOT/VERSION" 2>/dev/null || echo 0.0.0)"
DEFAULT_SERVER=https://spo.564616.xyz
LOCAL_URL=http://127.0.0.1:38917
case "${SPOT_LYRIC_PLATFORM:-$(uname -s)}" in
  Darwin|macos) PLATFORM=macos ;;
  Linux|linux)  PLATFORM=linux ;;
  *) echo "不支持的系统：$(uname -s)（Windows 请使用 patch.cmd）" >&2; exit 1 ;;
esac
# Overridable for tests (a sandbox must never see or change the real system hook).
APT_HOOK_DIR="${SPOT_LYRIC_APT_HOOK_DIR:-/usr/local/share/spot-lyric-patch}"
APT_HOOK_FILE="${SPOT_LYRIC_APT_HOOK_FILE:-/etc/apt/apt.conf.d/99spot-lyric-patch}"

usage() {
  cat <<USAGE
Spot-Lyric for Spotify v${VERSION}（macOS / Linux；Windows 运行 patch.cmd，命令和参数相同）

用法: ./patch.sh [命令] [选项]

命令:
  install      安装 / 更新（默认）：分步选择使用方式，注入插件并完成相应设置
  apply        只注入插件（沿用上次选择的使用方式）
  status       查看 Spotify、补丁、使用方式和服务状态
  restore      还原 Spotify 原始文件
  uninstall    还原 Spotify，并移除钩子、本地服务和直连启动参数
  hook         安装自动重新注入（Linux：apt 钩子；macOS：LaunchAgent）
  unhook       移除自动重新注入

使用方式（--mode）:
  cloud        云端服务器（默认）：服务器保存共享的匹配与歌词；网易云 / QQ 请求见 --request
  local        纯本地：不连接远程服务器，请求经本机 127.0.0.1:38917 的本地服务
               （spot-lyric-server，仅此方式需要下载 / 编译）
  direct       纯本地，不用本地服务而以 --disable-web-security 启动 Spotify（高级，不支持 macOS）

云端模式下网易云 / QQ 的请求方式（--request；插件始终本地优先：直连 → 本地服务 → 歌词服务器）:
  direct       直连：以 --disable-web-security 启动 Spotify，请求从本机发出（不支持 macOS）
  server       经歌词服务器原样转发（macOS 默认）

选项:
  --mode M             使用方式：cloud / local / direct（不指定时分步询问）
  --request R          云端模式的网易云 / QQ 请求方式：direct / server（不指定时分步询问）
  --server URL         歌词服务器地址（默认 ${DEFAULT_SERVER}）
  --local / --direct   等同 --mode local / --mode direct
  --spotify-path P     手动指定 Spotify 位置（Linux：含 Apps/xpui.spa 的目录；macOS：Spotify.app）
  --hook / --no-hook   安装 / 不安装自动重新注入
  --restart            完成后总是重启 Spotify
  --no-restart         不重启 Spotify
  -y, --yes            不询问，使用参数、上次的选择或默认值
  -q, --quiet          安静模式
  -h, --help           显示帮助
USAGE
}

COLOR=0; [[ -t 1 && -z ${NO_COLOR:-} ]] && COLOR=1
paint() { if [[ $COLOR == 1 ]]; then printf '\033[%sm%s\033[0m' "$1" "$2"; else printf '%s' "$2"; fi; }
QUIET=0
say()  { [[ $QUIET == 1 ]] || printf '%s %s\n' "$(paint '1;32' '[spot-lyric]')" "$*"; }
warn() { printf '%s %s\n' "$(paint '1;33' '[spot-lyric]')" "$*" >&2; }
die()  { printf '%s %s\n' "$(paint '1;31' '[spot-lyric]')" "$*" >&2; exit 1; }

# -------------------------------------------------------------- options ---
# Long options may be written --name, -name or PowerShell style (-Server, -NoRestart).
COMMAND=""; MODE=""; REQUEST=""; SERVER=""; SPOTIFY_PATH="${SPOTIFY_PATH:-}"; RESTART=auto; HOOK=""; YES=0
INTERNAL_APPS=""
SERVER_RE='^https?://[A-Za-z0-9._~:/-]+$'
while [[ $# -gt 0 ]]; do
  arg="$1"; shift
  if [[ $arg == __patcher ]]; then INTERNAL_APPS="${1:?}"; shift; INTERNAL_ARGS=("$@"); break; fi   # privileged re-entry
  if [[ $arg != -* ]]; then
    [[ -z $COMMAND ]] || { usage >&2; die "多余的参数：$arg"; }
    case "$(printf '%s' "$arg" | tr 'A-Z' 'a-z')" in
      install|apply|restore|uninstall|status|hook|unhook) COMMAND="$(printf '%s' "$arg" | tr 'A-Z' 'a-z')" ;;
      help) usage; exit 0 ;;
      version) echo "$VERSION"; exit 0 ;;
      *) usage >&2; die "未知命令：$arg" ;;
    esac
    continue
  fi
  name="${arg#-}"; name="${name#-}"; value=""; has_value=0
  if [[ $name == *=* ]]; then value="${name#*=}"; name="${name%%=*}"; has_value=1; fi
  key="$(printf '%s' "$name" | tr 'A-Z' 'a-z' | tr -d '_-')"
  take() { if [[ $has_value == 1 ]]; then return 0; fi; [[ $# -gt 0 ]] || die "$arg 需要一个值"; value="$1"; }
  case "$key" in
    mode)
      take "$@"; [[ $has_value == 1 ]] || shift
      case "$(printf '%s' "$value" | tr 'A-Z' 'a-z')" in
        cloud|server|remote) MODE=cloud ;;
        local|service) MODE=local ;;
        direct) MODE=direct ;;
        *) die "未知的使用方式：${value}（cloud / local / direct）" ;;
      esac ;;
    request)
      take "$@"; [[ $has_value == 1 ]] || shift
      case "$(printf '%s' "$value" | tr 'A-Z' 'a-z')" in
        service|local) REQUEST=service ;;
        direct) REQUEST=direct ;;
        server|relay|remote|none) REQUEST=server ;;
        *) die "未知的请求方式：${value}（service / direct / server）" ;;
      esac ;;
    server)
      take "$@"; [[ $has_value == 1 ]] || shift
      SERVER="${value%/}"
      [[ $SERVER =~ $SERVER_RE ]] || die "歌词服务器地址无效：${SERVER}（例如 https://lyrics.example.com）" ;;
    spotifypath) take "$@"; [[ $has_value == 1 ]] || shift; SPOTIFY_PATH="$value" ;;
    cloud) MODE=cloud ;;
    nodirect) REQUEST=server ;;
    local) MODE=local ;;
    direct) MODE=direct ;;
    restart) RESTART=yes ;;
    norestart) RESTART=no ;;
    hook) HOOK=on ;;
    nohook) HOOK=off ;;
    yes|y) YES=1 ;;
    quiet|q) QUIET=1 ;;
    help|h) usage; exit 0 ;;
    *) usage >&2; die "未知参数：$arg" ;;
  esac
done
COMMAND="${COMMAND:-install}"
# --request is the cloud mode's choice; "service" means the pure local mode.
case "$MODE:$REQUEST" in
  :service|local:service) MODE=local; REQUEST="" ;;
  cloud:service) die "本地服务只用于纯本地模式（--mode local）；云端模式的 --request 可选 direct / server" ;;
  local:*?) die "纯本地模式（--mode local）使用本地服务，不需要 --request" ;;
  direct:server) die "--mode direct 是不连接服务器的纯本地模式，不能配合 --request server" ;;
  direct:direct) REQUEST="" ;;
esac

# ----------------------------------------------------------------- user ---
# User-level pieces (config, local service, launcher entries, Spotify restart) belong to
# the desktop user even when the script runs under sudo.
TARGET_USER="${SUDO_USER:-$(id -un)}"
TARGET_UID="$(id -u "$TARGET_USER")"
home_of() {
  local h=""
  command -v getent >/dev/null 2>&1 && h="$(getent passwd "$1" | cut -d: -f6)"
  [[ -z $h && $PLATFORM == macos ]] && h="$(dscl . -read "/Users/$1" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  [[ -z $h ]] && h="$(eval echo "~$1")"
  printf '%s' "$h"
}
# Without sudo $HOME is authoritative (also keeps test runs with a throw-away HOME contained).
if [[ -z ${SUDO_USER:-} && -n ${HOME:-} ]]; then TARGET_HOME="$HOME"; else TARGET_HOME="$(home_of "$TARGET_USER")"; fi
as_user() {
  if [[ $(id -u) == "$TARGET_UID" ]]; then "$@"
  elif [[ $PLATFORM == linux ]]; then
    sudo -u "$TARGET_USER" XDG_RUNTIME_DIR="/run/user/$TARGET_UID" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$TARGET_UID/bus" HOME="$TARGET_HOME" "$@"
  else sudo -u "$TARGET_USER" HOME="$TARGET_HOME" "$@"
  fi
}
# Root for system files (apt hook, re-signing): one notice and one password prompt per run.
SUDO_READY=0
need_root() {  # need_root REASON
  [[ $(id -u) == 0 || $SUDO_READY == 1 ]] && return 0
  say "需要管理员权限（sudo）：$1"
  sudo -v || die "没有获得管理员权限"
  SUDO_READY=1
}
privileged() {
  if [[ $(id -u) == 0 ]]; then "$@"
  else need_root "修改系统文件"; sudo "$@"
  fi
}
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi; }
http_get() {  # http_get URL [timeout] -> body (empty on failure)
  if command -v curl >/dev/null 2>&1; then curl -fsS -m "${2:-8}" "$1" 2>/dev/null || true
  elif command -v wget >/dev/null 2>&1; then wget -qO- -T "${2:-8}" "$1" 2>/dev/null || true
  fi
}
json_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p'; }

# Per-user data: config (last choices), the local service program and its log.
if [[ $PLATFORM == macos ]]; then
  DATA_DIR="$TARGET_HOME/Library/Application Support/SpotLyric"
  AGENT_DIR="$TARGET_HOME/Library/LaunchAgents"
else
  DATA_DIR="${XDG_DATA_HOME:-$TARGET_HOME/.local/share}/spot-lyric"
  CONFIG_HOME="${XDG_CONFIG_HOME:-$TARGET_HOME/.config}"
  UNIT_DIR="$CONFIG_HOME/systemd/user"
fi
[[ -n ${SPOT_LYRIC_DATA:-} ]] && DATA_DIR="$SPOT_LYRIC_DATA"
CONFIG_FILE="$DATA_DIR/config"
CFG_MODE=""; CFG_SERVER=""; CFG_REQUEST=""
if [[ -f $CONFIG_FILE ]]; then
  CFG_MODE="$(sed -n 's/^mode=//p' "$CONFIG_FILE" | head -n1)"
  CFG_SERVER="$(sed -n 's/^server=//p' "$CONFIG_FILE" | head -n1)"
  CFG_REQUEST="$(sed -n 's/^request=//p' "$CONFIG_FILE" | head -n1)"
  case "$CFG_MODE" in cloud|local|direct) ;; *) CFG_MODE="" ;; esac
  case "$CFG_REQUEST" in service|direct|server) ;; *) CFG_REQUEST="" ;; esac
  [[ $CFG_SERVER =~ $SERVER_RE ]] || CFG_SERVER=""
fi
save_config() {  # save_config MODE SERVER REQUEST
  as_user mkdir -p "$DATA_DIR"
  { printf 'mode=%s\nrequest=%s\n' "$1" "$3"; [[ $2 == "$DEFAULT_SERVER" ]] || printf 'server=%s\n' "$2"; } | as_user tee "$CONFIG_FILE" >/dev/null
}
mode_name() { case "$1" in cloud) echo "云端服务器" ;; local) echo "纯本地 · 本地服务" ;; direct) echo "纯本地 · 直连" ;; esac; }
request_name() { case "$1" in service) echo "本地服务" ;; direct) echo "直连" ;; server) echo "经歌词服务器转发" ;; esac; }

# --------------------------------------------------------------- detect ---
# Sets SPOTIFY_DIR (install / .app root) and APPS (directory holding xpui.spa).
apps_of() {
  if [[ $PLATFORM == macos ]]; then printf '%s/Contents/Resources/Apps' "$1"; else printf '%s/Apps' "$1"; fi
}
valid_install() { local a; a="$(apps_of "$1")"; [[ -n "$1" && ( -f "$a/xpui.spa" || -f "$a/xpui/index.html" ) ]]; }
detect_spotify() {
  local c
  [[ -n ${SPOTIFY_DIR:-} ]] && return 0
  if [[ -n $SPOTIFY_PATH ]]; then
    c="${SPOTIFY_PATH%/}"
    if [[ $PLATFORM == macos ]]; then
      case "$c" in */Contents/Resources) c="${c%/Contents/Resources}" ;; */Contents) c="${c%/Contents}" ;; esac
    fi
    valid_install "$c" || die "指定位置不是 Spotify：$SPOTIFY_PATH"
    SPOTIFY_DIR="$(cd "$c" && pwd -P)"; APPS="$(apps_of "$SPOTIFY_DIR")"; return 0
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
need_spotify() {
  detect_spotify || {
    [[ $PLATFORM == macos ]] && die "没有找到 Spotify.app，请用 --spotify-path 指定（例如 /Applications/Spotify.app）"
    die "没有找到 Spotify，请用 --spotify-path 指定（含 Apps/xpui.spa 的目录）"
  }
}
spotify_version() {
  local v=""
  if [[ $PLATFORM == macos ]]; then
    v="$(defaults read "$SPOTIFY_DIR/Contents/Info" CFBundleShortVersionString 2>/dev/null ||
         plutil -extract CFBundleShortVersionString raw "$SPOTIFY_DIR/Contents/Info.plist" 2>/dev/null || true)"
  else
    if command -v dpkg >/dev/null 2>&1 && dpkg -S "$APPS/xpui.spa" >/dev/null 2>&1; then
      v="$(dpkg-query -W -f='${Version}' spotify-client 2>/dev/null || true)"
    fi
    [[ -z $v && -x "$SPOTIFY_DIR/spotify" ]] && v="$( (strings "$SPOTIFY_DIR/spotify" 2>/dev/null || true) | grep -m1 -oE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.g[0-9a-f]+' || true)"
  fi
  printf '%s' "${v:-unknown}"
}

# ---------------------------------------------------------------- build ---
# The usage mode and both addresses are baked into the plugin.
build_bundle() {  # build_bundle OUT_DIR MODE SERVER REQUEST
  local out="$1"
  mkdir -p "$out"
  {
    printf '/* Spot-Lyric for Spotify v%s - generated, do not edit */\n' "$VERSION"
    cat "$ROOT/src/core.js"
    printf '\n'
    sed -e "s/__SPOT_LYRIC_VERSION__/$VERSION/g" -e "s|__SPOT_LYRIC_SERVER__|$3|g" \
        -e "s/__SPOT_LYRIC_MODE__/$2/g" -e "s/__SPOT_LYRIC_REQUEST__/$4/g" -e "s|__SPOT_LYRIC_LOCAL__|$LOCAL_URL|g" "$ROOT/src/app.js"
  } > "$out/spot-lyric.js"
  cp "$ROOT/src/app.css" "$out/spot-lyric.css"
}

# ----------------------------------------------------- patcher (pure sh) ---
# xpui.spa is a zip archive. It is read and rewritten with base tools only (od, awk,
# gzip, head, tail): a zip "deflate" entry stores exactly the raw deflate stream and
# CRC-32 that gzip produces, so no python / zip / unzip is needed. A rewrite keeps all
# original entry data as is, appends the new index.html and plugin files and writes a
# new central directory without the replaced entries. Restoring copies the untouched
# backup back. Same layout, marker and digest as patch.ps1.
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
fsize() { local n; n="$(wc -c < "$1")"; echo $((n)); }
zbytes() { ( set +o pipefail; tail -c +"$(( $2 + 1 ))" "$1" | head -c "$3" ); }   # file offset length
dec() { LC_ALL=C od -An -tu1 -v; }
# Raw little-endian integers / bytes.
raw() { local b f=""; for b in "$@"; do f="$f$(printf '\\0%03o' "$b")"; done; printf '%b' "$f"; }
le16() { raw $(($1 & 255)) $(($1 >> 8 & 255)); }
le32() { raw $(($1 & 255)) $(($1 >> 8 & 255)) $(($1 >> 16 & 255)) $(($1 >> 24 & 255)); }
# zip_eocd FILE -> "count cd_size cd_offset" of the end-of-central-directory record.
zip_eocd() {
  local size n; size="$(fsize "$1")"; n=$(( size < 65557 ? size : 65557 ))
  zbytes "$1" $((size - n)) "$n" | dec | LC_ALL=C awk '
    { for (i = 1; i <= NF; i++) b[c++] = $i }
    END {
      for (p = c - 22; p >= 0; p--) if (b[p] == 80 && b[p+1] == 75 && b[p+2] == 5 && b[p+3] == 6) break
      if (p < 0) exit 1
      count = b[p+10] + 256 * b[p+11]
      size = b[p+12] + 256 * (b[p+13] + 256 * (b[p+14] + 256 * b[p+15]))
      off = b[p+16] + 256 * (b[p+17] + 256 * (b[p+18] + 256 * b[p+19]))
      if (count == 65535 || off == 4294967295) exit 2
      print count, size, off
    }'
}
# zip_central FILE CD_OFF CD_SIZE -> one line per entry:
#   start length method crc0 crc1 crc2 crc3 csize usize local_offset name
zip_central() {
  zbytes "$1" "$2" "$3" | dec | LC_ALL=C awk '
    function u16(p) { return b[p] + 256 * b[p+1] }
    function u32(p) { return b[p] + 256 * (b[p+1] + 256 * (b[p+2] + 256 * b[p+3])) }
    { for (i = 1; i <= NF; i++) b[c++] = $i }
    END {
      for (p = 0; p + 46 <= c && b[p] == 80 && b[p+1] == 75 && b[p+2] == 1 && b[p+3] == 2; p += len) {
        n = u16(p + 28); len = 46 + n + u16(p + 30) + u16(p + 32); name = ""
        for (i = 0; i < n; i++) name = name sprintf("%c", b[p + 46 + i])
        print p, len, u16(p + 10), b[p+16], b[p+17], b[p+18], b[p+19], u32(p + 20), u32(p + 24), u32(p + 42), name
      }
    }'
}
# zip_read FILE NAME -> the entry contents on stdout (status 1 when missing).
zip_read() {
  local e start len method c0 c1 c2 c3 csize usize lho name hdr
  e="$(zip_eocd "$1")" || return 1
  set -- "$1" "$2" $e
  while read -r start len method c0 c1 c2 c3 csize usize lho name; do
    [[ $name == "$2" ]] || continue
    hdr="$(zbytes "$1" "$lho" 30 | dec | LC_ALL=C awk '{ for (i = 1; i <= NF; i++) b[c++] = $i } END { print b[26] + 256 * b[27] + b[28] + 256 * b[29] }')"
    case "$method" in
      0) zbytes "$1" $((lho + 30 + hdr)) "$csize" ;;
      8) { raw 31 139 8 0 0 0 0 0 0 255; zbytes "$1" $((lho + 30 + hdr)) "$csize"; raw "$c0" "$c1" "$c2" "$c3"; le32 "$usize"; } | gzip -dc ;;
      *) return 1 ;;
    esac
    return 0
  done < <(zip_central "$1" "$5" "$4")
  return 1
}
# zip_rewrite SOURCE TARGET HTML [JS CSS]: SOURCE without index.html and spot-lyric/*,
# plus HTML as index.html and the plugin files; written next to TARGET, then swapped in.
zip_rewrite() {
  local src="$1" target="$2" e count cdsize cdoff tmp cd keep start len method c0 c1 c2 c3 csize usize lho name
  local run_start=-1 run_end=0 entry file gz gsize off crc tm dt n
  e="$(zip_eocd "$src")" || { echo "xpui.spa: 无法读取 zip 目录（或为不支持的 ZIP64）"; return 1; }
  read -r count cdsize cdoff <<< "$e"
  tmp="$target.spot-lyric-$$"; cd="$tmp.cd"
  head -c "$cdoff" "$src" > "$tmp"; : > "$cd"
  keep=0
  # Copy the kept central records in contiguous runs (dropped records are few).
  while read -r start len method c0 c1 c2 c3 csize usize lho name; do
    if [[ $name == index.html || $name == spot-lyric/* ]]; then
      [[ $run_start -ge 0 ]] && zbytes "$src" $((cdoff + run_start)) $((run_end - run_start)) >> "$cd"
      run_start=-1; continue
    fi
    [[ $run_start -lt 0 ]] && run_start=$start
    run_end=$((start + len)); keep=$((keep + 1))
  done < <(zip_central "$src" "$cdoff" "$cdsize")
  [[ $run_start -ge 0 ]] && zbytes "$src" $((cdoff + run_start)) $((run_end - run_start)) >> "$cd"
  set -- $(date '+%Y %m %d %H %M %S')
  tm=$(( (10#$4 << 11) | (10#$5 << 5) | (10#$6 / 2) )); dt=$(( ((10#$1 - 1980) << 9) | (10#$2 << 5) | 10#$3 ))
  set -- "index.html=$ZR_HTML" ${ZR_JS:+"spot-lyric/spot-lyric.js=$ZR_JS"} ${ZR_CSS:+"spot-lyric/spot-lyric.css=$ZR_CSS"}
  for entry in "$@"; do
    name="${entry%%=*}"; file="${entry#*=}"
    gz="$tmp.gz"; gzip -n -c < "$file" > "$gz"; gsize="$(fsize "$gz")"; csize=$((gsize - 18))
    crc="$(zbytes "$gz" $((gsize - 8)) 4 | dec)"; usize="$(fsize "$file")"; off="$(fsize "$tmp")"; n=${#name}
    { raw 80 75 3 4; le16 20; le16 0; le16 8; le16 "$tm"; le16 "$dt"; raw $crc; le32 "$csize"; le32 "$usize"; le16 "$n"; le16 0; printf '%s' "$name"
      zbytes "$gz" 10 "$csize"; } >> "$tmp"
    { raw 80 75 1 2; le16 20; le16 20; le16 0; le16 8; le16 "$tm"; le16 "$dt"; raw $crc; le32 "$csize"; le32 "$usize"; le16 "$n"
      le16 0; le16 0; le16 0; le16 0; le32 0; le32 "$off"; printf '%s' "$name"; } >> "$cd"
    keep=$((keep + 1)); rm -f "$gz"
  done
  off="$(fsize "$tmp")"; cdsize="$(fsize "$cd")"
  cat "$cd" >> "$tmp"; rm -f "$cd"
  { raw 80 75 5 6; le16 0; le16 0; le16 "$keep"; le16 "$keep"; le32 "$cdsize"; le32 "$off"; le16 0; } >> "$tmp"
  # Keep the owner / mode of the archive it replaces (root-owned installs stay readable).
  chmod "$(stat -c %a "$target" 2>/dev/null || stat -f %Lp "$target" 2>/dev/null || echo 644)" "$tmp"
  if [[ $(id -u) == 0 ]]; then chown "$(stat -c %u:%g "$target" 2>/dev/null || stat -f %u:%g "$target")" "$tmp" 2>/dev/null || true; fi
  mv -f "$tmp" "$target"
}
xpui() {  # xpui <patch|restore|status> APPS [js css]
  local cmd="$1" apps="$2" folder spa backup html current digest stage
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
      current="$(zip_read "$spa" index.html | zp_marker)"
      [[ $current == "$VERSION $digest" ]] && { echo "UNCHANGED spa"; return 0; }
      if [[ -z $current ]]; then cp -p "$spa" "$backup"      # fresh / freshly updated archive = new original
      else [[ -f $backup ]] || { echo "xpui.spa is patched but the backup is missing; reinstall Spotify"; return 1; }
      fi
      stage="$(mktemp -d)"
      zip_read "$backup" index.html > "$stage/original.html" || { rm -rf "$stage"; echo "xpui.spa: 读不到 index.html"; return 1; }
      zp_inject "$digest" < "$stage/original.html" > "$stage/index.html"
      ZR_HTML="$stage/index.html" ZR_JS="$js" ZR_CSS="$css" zip_rewrite "$backup" "$spa" || { rm -rf "$stage"; return 1; }
      rm -rf "$stage"
      echo "PATCHED spa $spa" ;;
    restore)
      local restored=""
      if [[ -f "$folder/index.html" ]]; then
        if [[ -n "$(zp_marker < "$folder/index.html")" ]]; then
          html="$(sed -E "s#$ZP_BLOCK_RE##" "$folder/index.html")"; printf '%s' "$html" > "$folder/index.html"; restored=1
        fi
        rm -rf "$folder/spot-lyric"
      fi
      if [[ -f $spa && -n "$(zip_read "$spa" index.html | zp_marker)" ]]; then
        if [[ -f $backup ]]; then cp -p "$backup" "$spa.tmp" && mv -f "$spa.tmp" "$spa"
        else
          stage="$(mktemp -d)"
          zip_read "$spa" index.html | sed -E "s#$ZP_BLOCK_RE##" > "$stage/index.html"
          ZR_HTML="$stage/index.html" ZR_JS="" ZR_CSS="" zip_rewrite "$spa" "$spa" || { rm -rf "$stage"; return 1; }
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
      current="$(zip_read "$spa" index.html | zp_marker)"
      printf '%s%s\n' "$([[ -n $current ]] && echo "spa patched v$current" || echo "spa not-patched")" "$([[ -f $backup ]] && echo " backup")" ;;
  esac
}
patcher() { xpui "$1" "$APPS" "${@:2}"; }   # patcher <patch|restore|status> args...
apps_writable() {
  [[ -w "$APPS" ]] && { [[ ! -e "$APPS/xpui.spa" ]] || [[ -w "$APPS/xpui.spa" || -O "$APPS" ]]; } &&
    { [[ ! -d "$APPS/xpui" ]] || [[ -w "$APPS/xpui" ]]; }
}
run_patcher() {
  if apps_writable; then patcher "$@"
  else
    # Re-run this script's patcher as root with the same environment.
    say "需要管理员权限写入 Spotify 安装目录（sudo）" >&2
    if [[ $(id -u) == 0 ]]; then patcher "$@"
    else sudo env SPOT_LYRIC_PLATFORM="$PLATFORM" bash "$ROOT/patch.sh" __patcher "$APPS" "$@"; fi
  fi
}
describe_patch() {
  case "$1" in
    *not-patched*) echo "未注入" ;;
    *"patched v"*) local v="${1#*patched v}"; echo "已注入 v${v%% *}" ;;
    missing) echo "找不到 xpui.spa" ;;
    *) echo "$1" ;;
  esac
}

# ------------------------------------------------------------ macOS sign ---
# Rewriting Contents/Resources invalidates Spotify's signature; Ventura and later
# refuse to start an app whose signature is broken. Re-sign ad hoc like SpotX.
macos_resign() {
  [[ $PLATFORM == macos ]] || return 0
  command -v codesign >/dev/null 2>&1 || { warn "未找到 codesign，跳过重新签名（如 Spotify 无法启动，请安装 Xcode Command Line Tools：xcode-select --install）"; return 0; }
  local run=""; [[ -w "$SPOTIFY_DIR" ]] || { run=privileged; need_root "重新签名 Spotify.app"; }
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

PATCH_CHANGED=0
do_apply() {  # do_apply MODE SERVER REQUEST
  local tmp result
  [[ $SPOTIFY_DIR == /snap/* ]] && die "Snap 版 Spotify 是只读文件系统，无法注入。请改用 deb 或 flatpak 版本。"
  tmp="$(mktemp -d)"
  build_bundle "$tmp" "$1" "$2" "$3"
  if ! result="$(run_patcher patch "$tmp/spot-lyric.js" "$tmp/spot-lyric.css" 2>&1)"; then
    rm -rf "$tmp"
    [[ $PLATFORM == macos && $result == *"ermitted"* ]] && macos_permission_hint
    die "注入失败：$result"
  fi
  rm -rf "$tmp"
  case "$result" in
    *UNCHANGED*) say "插件已是最新（v${VERSION}，$(mode_name "$1")），无需修改"; PATCH_CHANGED=0 ;;
    *PATCHED*)   say "已注入歌词插件 v${VERSION}（$(mode_name "$1")）→ ${result##*PATCHED * }"; PATCH_CHANGED=1; macos_resign ;;
    *) [[ $PLATFORM == macos && $result == *"ermitted"* ]] && macos_permission_hint; die "注入失败：$result" ;;
  esac
}

# ------------------------------------------------------- legacy proxy ---
# Versions before 1.1 ran a local proxy (spot-lyric-proxy, 127.0.0.1:38917). It is
# removed so the port is free for the local service.
if [[ $PLATFORM == macos ]]; then
  LEGACY_DIR="$TARGET_HOME/Library/Application Support/SpotLyric"
else
  LEGACY_DIR="$TARGET_HOME/.local/share/spot-lyric-patch"
fi
PROXY_LABEL=com.spotlyric.proxy
REAPPLY_LABEL=com.spotlyric.reapply
SERVICE_LABEL=com.spotlyric.local
SERVICE_UNIT=spot-lyric-local.service
have_user_systemd() { [[ $PLATFORM == linux ]] && as_user systemctl --user show-environment >/dev/null 2>&1; }
launch_agent() {  # launch_agent <label> <plist> : (re)load into the user's GUI session
  local domain="gui/$TARGET_UID"
  launchctl bootout "$domain/$1" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$2" 2>/dev/null || as_user launchctl load -w "$2" 2>/dev/null || warn "无法加载 LaunchAgent $1"
}
unload_agent() {  # unload_agent <label>
  launchctl bootout "gui/$TARGET_UID/$1" >/dev/null 2>&1 || as_user launchctl unload -w "$AGENT_DIR/$1.plist" 2>/dev/null || true
  as_user rm -f "$AGENT_DIR/$1.plist"
}
remove_legacy_proxy() {
  local found=""
  if [[ $PLATFORM == macos ]]; then
    if [[ -e "$AGENT_DIR/$PROXY_LABEL.plist" || -e "$LEGACY_DIR/spot-lyric-proxy" ]]; then
      found=1; unload_agent "$PROXY_LABEL"; as_user rm -f "$LEGACY_DIR/spot-lyric-proxy"
    fi
  else
    if [[ -e "$UNIT_DIR/spot-lyric-proxy.service" || -e "$UNIT_DIR/spot-lyric-proxy.socket" || -d "$LEGACY_DIR" || -e "$CONFIG_HOME/autostart/spot-lyric-proxy.desktop" ]]; then
      found=1
      if have_user_systemd; then
        as_user systemctl --user disable --now spot-lyric-proxy.socket >/dev/null 2>&1 || true
        as_user systemctl --user disable --now spot-lyric-proxy.service >/dev/null 2>&1 || true
      fi
      as_user rm -f "$UNIT_DIR/spot-lyric-proxy.socket" "$UNIT_DIR/spot-lyric-proxy.service" "$CONFIG_HOME/autostart/spot-lyric-proxy.desktop"
      as_user rm -rf "$LEGACY_DIR"
      have_user_systemd && as_user systemctl --user daemon-reload || true
    fi
    # Only the installed proxy (python script or Go binary), not anything that mentions its name.
    pkill -u "$TARGET_UID" -f "^[^ ]*(python3?|env python3) [^ ]*$LEGACY_DIR/spot-lyric-proxy\.py" 2>/dev/null || true
    pkill -u "$TARGET_UID" -f "^$LEGACY_DIR/spot-lyric-proxy( |$)" 2>/dev/null || true
  fi
  [[ -n $found ]] && say "已移除旧版本地歌词代理（spot-lyric-proxy）"
  return 0
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
    local launcher=spotify flags=()
    command -v spotify >/dev/null 2>&1 || launcher="$SPOTIFY_DIR/spotify"
    direct_enabled && flags=("$DIRECT_FLAG" "--user-data-dir=$DIRECT_PROFILE")
    if command -v setsid >/dev/null 2>&1; then as_user env DISPLAY="${DISPLAY:-:0}" setsid -f "$launcher" ${flags[@]+"${flags[@]}"} >/dev/null 2>&1 < /dev/null || warn "请手动启动 Spotify"
    else as_user env DISPLAY="${DISPLAY:-:0}" nohup "$launcher" ${flags[@]+"${flags[@]}"} >/dev/null 2>&1 < /dev/null & fi
  fi
}
restart_spotify() {  # restart_spotify CHANGED(0/1)
  if [[ $RESTART == no ]]; then [[ $1 == 1 ]] && say "下次启动 Spotify 时生效"; return 0; fi
  if spotify_running; then
    [[ $RESTART == auto && $1 == 0 ]] && return 0
    say "重启 Spotify 以加载插件…"
    stop_spotify; start_spotify
  elif [[ $RESTART == yes ]]; then start_spotify
  elif [[ $1 == 1 ]]; then say "下次启动 Spotify 时生效"; fi
}

# --------------------------------------------------------------- direct ---
# Spotify's renderer enforces CORS and NetEase / QQ send no CORS headers, so the
# plugin can only reach them itself when Spotify runs with --disable-web-security
# (CEF honours the switch). Newer Chromium refuses it unless --user-data-dir is
# also given a non-default path, so a symlink to Spotify's real profile directory
# is used (same data, different path). A per-user spotify.desktop overrides the
# system launcher entry. macOS: launches from the Dock cannot carry switches.
DIRECT_FLAG=--disable-web-security
SPOTIFY_PROFILE="${XDG_CONFIG_HOME:-$TARGET_HOME/.config}/spotify"
DIRECT_PROFILE="${XDG_CONFIG_HOME:-$TARGET_HOME/.config}/spotify-direct"
DIRECT_ARGS="$DIRECT_FLAG --user-data-dir=$DIRECT_PROFILE"
DESKTOP_OVERRIDE="$TARGET_HOME/.local/share/applications/spotify.desktop"
direct_enabled() { [[ $PLATFORM == linux && -f $DESKTOP_OVERRIDE ]] && grep -q '^X-Spot-Lyric=direct' "$DESKTOP_OVERRIDE" 2>/dev/null && grep -q -- '--user-data-dir=' "$DESKTOP_OVERRIDE" 2>/dev/null; }
enable_direct() {
  [[ $PLATFORM == macos ]] && die "macOS 无法给从 Dock / 启动台打开的 Spotify 固定启动参数，不支持直连；请使用 --mode local"
  local src="" f
  for f in /usr/share/applications/spotify.desktop /usr/local/share/applications/spotify.desktop "$SPOTIFY_DIR/spotify.desktop" \
      /var/lib/flatpak/exports/share/applications/com.spotify.Client.desktop; do
    [[ -f $f ]] && { src="$f"; break; }
  done
  local was=0; direct_enabled && was=1
  as_user mkdir -p "$(dirname "$DESKTOP_OVERRIDE")" "$SPOTIFY_PROFILE"
  [[ -e $DIRECT_PROFILE && ! -L $DIRECT_PROFILE ]] && die "$DIRECT_PROFILE 已存在且不是符号链接，请先移走它"
  as_user ln -sfn "$SPOTIFY_PROFILE" "$DIRECT_PROFILE"
  {
    if [[ -n $src ]]; then
      # Add the switches to every Exec= line, right after the program.
      sed -e "s| $DIRECT_FLAG||g" -e "s| --user-data-dir=$DIRECT_PROFILE||g" -e "/^Exec=/s|^Exec=\([^ ]*\)|Exec=\1 $DIRECT_ARGS|" -e '/^X-Spot-Lyric=/d' "$src"
    else
      printf '[Desktop Entry]\nType=Application\nName=Spotify\nIcon=spotify-client\nExec=spotify %s %%U\nTerminal=false\nMimeType=x-scheme-handler/spotify;\nCategories=Audio;Music;Player;AudioVideo;\nStartupWMClass=spotify\n' "$DIRECT_ARGS"
    fi
    printf 'X-Spot-Lyric=direct\n'
  } | as_user tee "$DESKTOP_OVERRIDE" >/dev/null
  if [[ $was == 1 ]]; then say "直连启动参数已启用（${DESKTOP_OVERRIDE}）"; return 0; fi
  say "已启用直连：应用菜单中的 Spotify 将以 $DIRECT_ARGS 启动（${DESKTOP_OVERRIDE}）"
  say "其它启动方式（自建快捷方式、AppImage、开机自启）请自行加上这两个参数"
}
disable_direct() {
  if [[ -f $DESKTOP_OVERRIDE ]] && grep -q '^X-Spot-Lyric=direct' "$DESKTOP_OVERRIDE" 2>/dev/null; then
    as_user rm -f "$DESKTOP_OVERRIDE"; [[ -L $DIRECT_PROFILE ]] && as_user rm -f "$DIRECT_PROFILE"
    say "已取消直连启动参数"
  fi
  return 0
}

# -------------------------------------------------------- local service ---
# spot-lyric-server serve --local on 127.0.0.1:38917, only for --mode local. Built from
# this checkout when Go is installed, otherwise the release binary of this version.
SERVICE_BIN="$DATA_DIR/spot-lyric-server"
service_installed() {
  if [[ $PLATFORM == macos ]]; then [[ -f "$AGENT_DIR/$SERVICE_LABEL.plist" ]]
  else [[ -f "$UNIT_DIR/$SERVICE_UNIT" || -f "$CONFIG_HOME/autostart/spot-lyric-local.desktop" ]]; fi
}
local_health() { http_get "$LOCAL_URL/health" 2 | json_version; }
obtain_server() {  # installs $SERVICE_BIN
  local os arch asset tag base tmp want
  if [[ -x $SERVICE_BIN && "$("$SERVICE_BIN" version 2>/dev/null || true)" == "$VERSION" && ${SPOT_LYRIC_BUILD:-} != 1 ]]; then return 0; fi
  as_user mkdir -p "$DATA_DIR"
  tmp="$(mktemp -d)"; chmod 755 "$tmp"
  if [[ -f $ROOT/go.mod && ${SPOT_LYRIC_BUILD:-} != 0 ]] && command -v go >/dev/null 2>&1; then
    say "从源码编译本地服务（Go）…"
    if (cd "$ROOT" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$tmp/spot-lyric-server" ./cmd/spot-lyric-server); then
      chmod 755 "$tmp/spot-lyric-server"; as_user cp "$tmp/spot-lyric-server" "$SERVICE_BIN.new"; as_user mv -f "$SERVICE_BIN.new" "$SERVICE_BIN"
      rm -rf "$tmp"; return 0
    fi
    warn "编译失败，改为下载预编译程序"
  fi
  if [[ $PLATFORM == macos ]]; then os=darwin; else os=linux; fi
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) die "不支持的处理器架构：$(uname -m)" ;; esac
  [[ $os == darwin && $arch == amd64 && "$(sysctl -n hw.optional.arm64 2>/dev/null)" == 1 ]] && arch=arm64
  asset="spot-lyric-server-$os-$arch"
  for tag in "v$VERSION" latest; do
    if [[ $tag == latest ]]; then base="https://github.com/$REPO/releases/latest/download"; else base="https://github.com/$REPO/releases/download/$tag"; fi
    say "下载本地服务 ${asset}（${tag}）…"
    if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 -o "$tmp/$asset" "$base/$asset" 2>/dev/null || continue
      curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" 2>/dev/null || true
    else wget -q -O "$tmp/$asset" "$base/$asset" 2>/dev/null || continue
      wget -q -O "$tmp/SHA256SUMS" "$base/SHA256SUMS" 2>/dev/null || true
    fi
    want="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS" 2>/dev/null || true)"
    [[ -z $want || $want == "$(sha256 < "$tmp/$asset")" ]] || { rm -rf "$tmp"; die "$asset 校验失败（SHA256 不一致）"; }
    chmod 755 "$tmp/$asset"
    as_user cp "$tmp/$asset" "$SERVICE_BIN.new"; as_user mv -f "$SERVICE_BIN.new" "$SERVICE_BIN"
    [[ $PLATFORM == macos ]] && { as_user xattr -d com.apple.quarantine "$SERVICE_BIN" 2>/dev/null || true; }
    rm -rf "$tmp"; return 0
  done
  rm -rf "$tmp"
  die "无法下载本地服务（https://github.com/$REPO/releases）。可安装 Go 后在仓库目录中重新运行以从源码编译，或改用其它使用方式。"
}
install_service() {
  local log="$DATA_DIR/local.log" i v
  obtain_server
  if [[ $PLATFORM == macos ]]; then
    as_user mkdir -p "$AGENT_DIR"
    as_user tee "$AGENT_DIR/$SERVICE_LABEL.plist" >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$SERVICE_BIN</string><string>serve</string><string>--local</string><string>--data</string><string>$DATA_DIR</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
PLIST
    launch_agent "$SERVICE_LABEL" "$AGENT_DIR/$SERVICE_LABEL.plist"
    say "已安装 LaunchAgent ${SERVICE_LABEL}（登录时自动启动本地服务）"
  elif have_user_systemd; then
    as_user mkdir -p "$UNIT_DIR"
    printf '[Unit]\nDescription=Spot-Lyric local lyrics service (%s)\nAfter=network-online.target\n\n[Service]\nExecStart="%s" serve --local --data "%s"\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n' \
      "$LOCAL_URL" "$SERVICE_BIN" "$DATA_DIR" | as_user tee "$UNIT_DIR/$SERVICE_UNIT" >/dev/null
    as_user rm -f "$CONFIG_HOME/autostart/spot-lyric-local.desktop"
    as_user systemctl --user daemon-reload
    as_user systemctl --user enable "$SERVICE_UNIT" >/dev/null 2>&1 || die "无法启用 $SERVICE_UNIT"
    as_user systemctl --user restart "$SERVICE_UNIT" || die "无法启动 ${SERVICE_UNIT}（日志：journalctl --user -u ${SERVICE_UNIT}）"
    say "已安装 systemd 用户服务 ${SERVICE_UNIT}（登录时自动启动本地服务）"
  else
    as_user mkdir -p "$CONFIG_HOME/autostart"
    printf '[Desktop Entry]\nType=Application\nName=Spot-Lyric local service\nExec="%s" serve --local --data "%s"\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n' \
      "$SERVICE_BIN" "$DATA_DIR" | as_user tee "$CONFIG_HOME/autostart/spot-lyric-local.desktop" >/dev/null
    pkill -u "$TARGET_UID" -f "^$SERVICE_BIN serve" 2>/dev/null || true
    if command -v setsid >/dev/null 2>&1; then as_user setsid -f "$SERVICE_BIN" serve --local --data "$DATA_DIR" >/dev/null 2>&1 < /dev/null
    else as_user nohup "$SERVICE_BIN" serve --local --data "$DATA_DIR" >/dev/null 2>&1 < /dev/null & fi
    say "已添加登录自启 $CONFIG_HOME/autostart/spot-lyric-local.desktop（未检测到 systemd 用户实例）"
  fi
  for i in $(seq 1 50); do
    v="$(local_health)"
    [[ -n $v ]] && { say "本地服务运行中：${LOCAL_URL}（v${v}）"; return 0; }
    sleep 0.2
  done
  die "本地服务没有在 $LOCAL_URL 上响应（端口 38917 可能被其它程序占用），日志：$log"
}
remove_service() {
  service_installed || return 0
  if [[ $PLATFORM == macos ]]; then unload_agent "$SERVICE_LABEL"
  else
    if [[ -f "$UNIT_DIR/$SERVICE_UNIT" ]]; then
      as_user systemctl --user disable --now "$SERVICE_UNIT" >/dev/null 2>&1 || true
      as_user rm -f "$UNIT_DIR/$SERVICE_UNIT"
      have_user_systemd && as_user systemctl --user daemon-reload || true
    fi
    as_user rm -f "$CONFIG_HOME/autostart/spot-lyric-local.desktop"
    pkill -u "$TARGET_UID" -f "^$SERVICE_BIN serve" 2>/dev/null || true
  fi
  say "已停止并移除本地服务"
}

# ----------------------------------------------------------------- hook ---
hook_supported() { [[ $PLATFORM == macos || -d $(dirname "$APT_HOOK_FILE") ]]; }
hook_installed() {
  if [[ $PLATFORM == macos ]]; then [[ -f "$AGENT_DIR/$REAPPLY_LABEL.plist" ]]; else [[ -e $APT_HOOK_FILE ]]; fi
}
install_hook() {  # install_hook MODE SERVER REQUEST
  local mode="$1" server="$2" request="$3"
  if [[ $PLATFORM == macos ]]; then
    local dir="$DATA_DIR/patcher" plist="$AGENT_DIR/$REAPPLY_LABEL.plist"
    as_user mkdir -p "$dir" "$AGENT_DIR" "$TARGET_HOME/Library/Logs"
    as_user rm -rf "$dir/src" "$dir/tools"
    as_user cp -R "$ROOT/patch.sh" "$ROOT/VERSION" "$ROOT/src" "$ROOT/tools" "$dir/"
    # Runs at login and whenever Spotify's updater replaces xpui.spa.
    as_user tee "$plist" >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$REAPPLY_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$dir/patch.sh</string><string>apply</string><string>--yes</string><string>--quiet</string>
    <string>--no-restart</string><string>--mode</string><string>$mode</string><string>--request</string><string>$request</string><string>--server</string><string>$server</string>
    <string>--spotify-path</string><string>$SPOTIFY_DIR</string></array>
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
  hook_supported || { warn "未检测到 apt：自动重新注入仅适用于 deb 安装的 Spotify"; return 0; }
  # Unchanged scripts and settings: nothing to write (and no sudo prompt).
  if [[ "$(cat "$APT_HOOK_FILE" 2>/dev/null)" == "$(apt_hook_line "$mode" "$server" "$request")" ]] &&
     cmp -s "$ROOT/patch.sh" "$APT_HOOK_DIR/patch.sh" && cmp -s "$ROOT/VERSION" "$APT_HOOK_DIR/VERSION" &&
     diff -rq "$ROOT/src" "$APT_HOOK_DIR/src" >/dev/null 2>&1; then
    say "apt 钩子已是最新（${APT_HOOK_FILE}）"; return 0
  fi
  need_root "写入 apt 钩子 ${APT_HOOK_FILE}"
  privileged rm -rf "$APT_HOOK_DIR"
  privileged mkdir -p "$APT_HOOK_DIR"
  privileged cp -r "$ROOT/patch.sh" "$ROOT/VERSION" "$ROOT/src" "$ROOT/tools" "$APT_HOOK_DIR/"
  privileged chmod -R a+rX "$APT_HOOK_DIR"
  apt_hook_line "$mode" "$server" "$request" | privileged tee "$APT_HOOK_FILE" >/dev/null
  say "已安装 apt 钩子：${APT_HOOK_FILE}（spotify-client 升级后自动重新注入）"
}
apt_hook_line() {  # apt_hook_line MODE SERVER REQUEST
  printf '%s\n' "DPkg::Post-Invoke { \"if [ -x $APT_HOOK_DIR/patch.sh ] && [ -d '$APPS' ]; then $APT_HOOK_DIR/patch.sh apply --yes --quiet --no-restart --mode $1 --request $3 --server $2 --spotify-path '$SPOTIFY_DIR' || true; fi\"; };"
}
remove_hook() {
  if [[ $PLATFORM == macos ]]; then
    if [[ -f "$AGENT_DIR/$REAPPLY_LABEL.plist" ]]; then unload_agent "$REAPPLY_LABEL"; say "已移除 LaunchAgent 钩子"; fi
    as_user rm -rf "$DATA_DIR/patcher"; return 0
  fi
  if [[ -e $APT_HOOK_FILE || -d $APT_HOOK_DIR ]]; then need_root "移除 apt 钩子 ${APT_HOOK_FILE}"; privileged rm -rf "$APT_HOOK_FILE" "$APT_HOOK_DIR"; say "已移除 apt 钩子"; fi
  return 0
}

# --------------------------------------------------------------- prompts ---
TTY_IN=""
if [[ $YES != 1 ]]; then
  if [[ -t 0 ]]; then TTY_IN=/dev/stdin
  elif { : < /dev/tty; } 2>/dev/null; then TTY_IN=/dev/tty; fi
fi
interactive() { [[ -n $TTY_IN ]]; }
LINE=""
read_line() { LINE=""; IFS= read -r LINE < "$TTY_IN" || { TTY_IN=""; echo; return 1; }; LINE="$(printf '%s' "$LINE" | tr -d '\r')"; }
# choose STEP TITLE DEFAULT_KEY  "key|label|hint|disabled-reason" ... -> CHOICE
CHOICE=""
choose() {
  local step="$1" title="$2" def="$3"; shift 3
  CHOICE="$def"; interactive || return 0
  local items=("$@") i=0 n="$#" defi=1 key label hint off rest
  printf '\n%s%s\n' "${step:+$(paint '1;36' "$step") }" "$(paint 1 "$title")"
  for i in $(seq 1 "$n"); do
    IFS='|' read -r key label hint off <<< "${items[$((i - 1))]}"
    [[ $key == "$def" ]] && defi=$i
    if [[ -n $off ]]; then printf '  %s\n' "$(paint 2 "$i) $label — $off")"; continue; fi
    [[ $key == "$def" ]] && label="$label$(paint 32 '（默认）')"
    printf '  %s %s\n' "$(paint 1 "$i)")" "$label"
    rest="$hint"
    while [[ -n $rest ]]; do printf '     %s\n' "$(paint 2 "${rest%%\\n*}")"; [[ $rest == *'\n'* ]] && rest="${rest#*\\n}" || rest=""; done
  done
  while :; do
    printf '请输入序号 [%s]: ' "$defi"
    read_line || return 0
    [[ -z $LINE ]] && LINE="$defi"
    if [[ $LINE =~ ^[0-9]+$ ]] && (( LINE >= 1 && LINE <= n )); then
      IFS='|' read -r key label hint off <<< "${items[$((LINE - 1))]}"
      if [[ -n $off ]]; then printf '%s\n' "$(paint 33 "不可用：$off")"; continue; fi
      CHOICE="$key"; return 0
    fi
    printf '%s\n' "$(paint 33 "请输入 1 到 $n 之间的数字")"
  done
}
confirm() {  # confirm QUESTION DEFAULT(y/n) -> status
  local def="$2"; interactive || [[ $def == y ]] || return 1; interactive || return 0
  while :; do
    if [[ $def == y ]]; then printf '%s [Y/n]: ' "$1"; else printf '%s [y/N]: ' "$1"; fi
    read_line || { [[ $def == y ]]; return; }
    case "$(printf '%s' "$LINE" | tr 'A-Z' 'a-z')" in
      "") [[ $def == y ]]; return ;;
      y|yes|是|好) return 0 ;;
      n|no|否|不) return 1 ;;
    esac
  done
}

# ---------------------------------------------------------------- plan ---
current_mode() { echo "${CFG_MODE:-cloud}"; }
current_server() { printf '%s' "${SERVER:-${CFG_SERVER:-$DEFAULT_SERVER}}"; }
# Pure local modes imply their request method. Cloud: the option, the recorded choice, or
# what is set up (a launcher with the direct switches from 1.2 --direct means direct).
current_request() {
  case "$1" in local) echo service; return 0 ;; direct) echo direct; return 0 ;; esac
  if [[ -n $REQUEST ]]; then echo "$REQUEST"
  elif [[ $CFG_REQUEST == direct || $CFG_REQUEST == server ]]; then echo "$CFG_REQUEST"
  elif direct_enabled; then echo direct; else echo server; fi
}
PURE_HINT="不连接任何远程服务器：在本机 127.0.0.1:38917 运行一个小服务（登录时自动启动）转发网易云 / QQ 请求；\n搜索、匹配、歌词下载都在本机进行，绑定的歌词只保存在本机（会下载或编译 spot-lyric-server，约 10 MB）"
DIRECT_HINT="以 --disable-web-security 启动 Spotify，请求从本机直接发出，不需要下载任何程序；\n会关闭 Spotify 内置浏览器的同源限制，并修改应用菜单中的 Spotify 启动项"
SERVER_HINT="Spotify 内置浏览器会拦截跨域请求，由歌词服务器原样转发（搜索和匹配仍在本机），什么都不用改"
STEP=0
next_step() { STEP=$((STEP + 1)); }

P_MODE=""; P_REQ=""; P_SERVER=""; P_HOOK=0; P_ACTION=install
# Installed before (choices recorded) and nothing asked for on the command line: offer a
# one-step update with the same choices instead of walking through every step again.
quick_plan() {
  [[ -n $CFG_MODE && -z $MODE$REQUEST$SERVER$HOOK ]] && interactive || return 1
  local req summary
  req="$(current_request "$CFG_MODE")"
  [[ $req == direct && $PLATFORM == macos ]] && req=server
  summary="使用方式：$(mode_name "$CFG_MODE")"
  [[ $CFG_MODE == cloud ]] && summary="$summary · 网易云 / QQ 请求：$(request_name "$req")\n歌词服务器：$(current_server)"
  summary="$summary\n自动重新注入：$(hook_installed && echo 已安装 || echo 未安装)"
  choose "" "已安装过 Spot-Lyric，要做什么？" update \
    "update|更新到 v${VERSION}（沿用当前设置）|$summary|" \
    "setup|重新设置|重新选择使用方式、歌词服务器和请求方式|" \
    "uninstall|卸载|还原 Spotify，并移除钩子、本地服务和直连启动参数|"
  case "$CHOICE" in
    update)
      P_ACTION=update; P_MODE="$CFG_MODE"; P_SERVER="$(current_server)"; P_REQ="$req"
      P_HOOK=0; hook_installed && P_HOOK=1
      printf '\n'; return 0 ;;
    uninstall)
      printf '\n'; confirm "确定卸载 Spot-Lyric" n || die "已取消，没有做任何修改"
      P_ACTION=uninstall; printf '\n'; return 0 ;;
  esac
  return 1
}
make_plan() {
  local current current_req
  quick_plan && return 0
  P_MODE="$MODE"; P_SERVER="$(current_server)"
  [[ -z $P_MODE && ( -n $SERVER || $REQUEST == server ) ]] && P_MODE=cloud
  current="$(current_mode)"; current_req="$(current_request cloud)"
  [[ $current_req == direct && $PLATFORM == macos ]] && current_req=server
  if [[ -z $P_MODE ]]; then
    next_step; choose "[$STEP]" "选择使用方式" "$([[ $current == cloud ]] && echo cloud || echo pure)" \
      "cloud|云端服务器|歌词服务器保存「使用此歌词」和上传按钮提交的匹配，多台设备共享|" \
      "pure|纯本地|$PURE_HINT|"
    if [[ $CHOICE == cloud ]]; then P_MODE=cloud
    elif [[ $REQUEST == direct || ( -z $REQUEST && $current == direct ) ]]; then P_MODE=direct   # kept only when asked for (--mode direct)
    else P_MODE=local; fi
  fi
  case "$P_MODE" in
    local) P_REQ=service ;;
    direct) P_REQ=direct ;;
    cloud)
      if interactive && [[ -z $SERVER ]]; then
        printf '\n'; next_step
        while :; do
          printf '%s 歌词服务器地址（回车使用默认，也可以填自建服务器） [%s]: ' "$(paint '1;36' "[$STEP]")" "$P_SERVER"
          read_line || break
          [[ -z $LINE ]] && break
          LINE="${LINE%/}"
          if [[ $LINE =~ $SERVER_RE ]]; then P_SERVER="$LINE"; break; fi
          printf '%s\n' "$(paint 33 '地址无效，例如 https://lyrics.example.com')"
        done
      fi
      if [[ -n $REQUEST ]]; then P_REQ="$REQUEST"
      elif [[ $PLATFORM == macos ]]; then P_REQ=server   # no direct mode on macOS: nothing to choose
      else
        next_step; choose "[$STEP]" "网易云 / QQ 音乐的请求怎么发出？" "$current_req" \
          "direct|直连|$DIRECT_HINT|" "server|经歌词服务器转发|$SERVER_HINT|"
        P_REQ="$CHOICE"
      fi ;;
  esac
  [[ $P_REQ == direct && $PLATFORM == macos ]] && die "macOS 不支持直连（无法给从 Dock / 启动台打开的 Spotify 加启动参数）；云端模式请用 --request server，纯本地请用 --mode local"
  case "$HOOK" in
    on) P_HOOK=1 ;;
    off) P_HOOK=0 ;;
    *)
      P_HOOK=0
      if hook_supported; then
        if interactive; then
          next_step
          if [[ $PLATFORM == macos ]]; then printf '\n%s %s\n' "$(paint '1;36' "[$STEP]")" "$(paint 1 'Spotify 自动更新后重新注入插件？（LaunchAgent，登录时和 Spotify 更新后检查）')"
          else printf '\n%s %s\n' "$(paint '1;36' "[$STEP]")" "$(paint 1 'Spotify 自动更新后重新注入插件？（apt 钩子，spotify-client 升级后执行）')"; fi
          confirm "安装自动重新注入" y && P_HOOK=1
        elif hook_installed; then P_HOOK=1; fi
      fi ;;
  esac
  if interactive; then
    printf '\n%s\n' "$(paint 1 '即将执行：')"
    printf '  • 注入歌词插件 v%s（使用方式：%s）\n' "$VERSION" "$(mode_name "$P_MODE")"
    [[ $P_MODE == cloud ]] && printf '  • 歌词服务器：%s\n' "$P_SERVER"
    [[ $P_MODE == cloud ]] && printf '  • 网易云 / QQ 请求：%s\n' "$(request_name "$P_REQ")"
    case "$P_REQ" in
      service) printf '  • 安装本地服务：%s，登录时自动启动（需要时下载 / 编译 spot-lyric-server）\n' "$LOCAL_URL" ;;
      direct) printf '  • 让 Spotify 以 %s 启动\n' "$DIRECT_FLAG" ;;
    esac
    [[ $P_REQ != direct ]] && direct_enabled && printf '  • 取消 Spotify 的直连启动参数（%s）\n' "$DIRECT_FLAG"
    [[ $P_REQ != service ]] && service_installed && printf '  • 停止并移除本地服务\n'
    if [[ $P_HOOK == 1 ]]; then printf '  • 安装自动重新注入\n'; elif hook_installed; then printf '  • 移除自动重新注入\n'; fi
    printf '\n'
    confirm "继续" y || die "已取消，没有做任何修改"
    printf '\n'
  fi
}

# ----------------------------------------------------------------- main ---
if [[ -n $INTERNAL_APPS ]]; then APPS="$INTERNAL_APPS"; patcher "${INTERNAL_ARGS[@]}"; exit $?; fi
header() {
  [[ $QUIET == 1 ]] && return 0
  printf '%s\n' "$(paint 1 "Spot-Lyric for Spotify v$VERSION")"
  printf '系统：%s（%s）\n' "$([[ $PLATFORM == macos ]] && echo macOS || echo Linux)" "$(uname -m)"
}
show_spotify() {
  [[ $QUIET == 1 ]] && return 0
  printf 'Spotify：%s\n版本：%s\n补丁：%s\n' "$SPOTIFY_DIR" "$(spotify_version)" "$(describe_patch "$(patcher status 2>/dev/null || true)")"
}
restore_cmd() {  # restore_cmd restore|uninstall
  local result changed=0
  result="$(run_patcher restore)" || die "还原失败：$result"
  if [[ $result == *RESTORED* ]]; then say "已还原 Spotify 原始文件"; macos_resign; changed=1; else say "Spotify 未被修改，无需还原"; fi
  if [[ $1 == uninstall ]]; then
    remove_legacy_proxy; remove_hook; disable_direct; remove_service
    as_user rm -f "$CONFIG_FILE" "$SERVICE_BIN" "$DATA_DIR/local.log"
    as_user rm -rf "$DATA_DIR/data"
    as_user rmdir "$DATA_DIR" 2>/dev/null || true
    say "已卸载 Spot-Lyric"
  fi
  restart_spotify "$changed"
}
case "$COMMAND" in
  install)
    header; need_spotify; show_spotify
    make_plan
    [[ $P_ACTION == uninstall ]] && { restore_cmd uninstall; exit 0; }
    remove_legacy_proxy
    do_apply "$P_MODE" "$P_SERVER" "$P_REQ"
    changed=$PATCH_CHANGED
    case "$P_REQ" in
      service) direct_enabled && { disable_direct; changed=1; }; install_service ;;
      direct) remove_service; direct_enabled || changed=1; enable_direct ;;
      server) remove_service; direct_enabled && { disable_direct; changed=1; } ;;
    esac
    if [[ $P_HOOK == 1 ]]; then install_hook "$P_MODE" "$P_SERVER" "$P_REQ"; elif hook_installed; then remove_hook; fi
    save_config "$P_MODE" "$P_SERVER" "$P_REQ"
    restart_spotify "$changed"
    if [[ $P_ACTION == update ]]; then say "完成！以后想更换使用方式，重新运行本脚本并选择「重新设置」。"
    else
      if [[ $P_MODE == cloud ]]; then say "完成！在 Spotify 底部播放栏（官方歌词按钮左侧）点击新的歌词图标打开歌词页；旁边的小箭头可把当前歌词上传到服务器。"
      else say "完成！纯本地模式：不连接任何远程服务器。在 Spotify 底部播放栏（官方歌词按钮左侧）点击新的歌词图标打开歌词页。"; fi
      if [[ $P_MODE == cloud ]]; then say "网易云 / QQ 请求：$(request_name "$P_REQ")。以后想更换方式，重新运行本脚本即可。"
      else say "以后想更换方式，重新运行本脚本即可。"; fi
    fi
    ;;
  apply)
    need_spotify
    mode="${MODE:-$(current_mode)}"
    do_apply "$mode" "$(current_server)" "$(current_request "$mode")"
    restart_spotify "$PATCH_CHANGED"
    ;;
  restore|uninstall)
    need_spotify
    restore_cmd "$COMMAND"
    ;;
  status)
    QUIET=0; header
    if detect_spotify; then show_spotify; else echo "Spotify：未找到"; fi
    echo "插件版本：v$VERSION"
    mode="$(current_mode)"
    echo "使用方式：$(mode_name "$mode")"
    req="$(current_request "$mode")"
    echo "网易云 / QQ 请求：$(request_name "$req")（始终本地优先：直连 → 本地服务$([[ $mode == cloud ]] && echo ' → 歌词服务器')）"
    if [[ $mode == cloud ]]; then
      v="$(http_get "$(current_server)/health" | json_version)"
      if [[ -n $v ]]; then echo "歌词服务器：运行正常 v$v · $(current_server)"; else echo "歌词服务器：无法连接 $(current_server)"; fi
    fi
    v="$(local_health)"
    if [[ -n $v ]]; then echo "本地服务：运行中 v$v · $LOCAL_URL"
    elif service_installed || [[ $req == service ]]; then echo "本地服务：未运行（${LOCAL_URL}）"; fi
    if [[ $PLATFORM == linux ]]; then direct_enabled && echo "直连启动参数：已启用（${DIRECT_FLAG}）" || echo "直连启动参数：未启用"; fi
    if ! hook_supported; then echo "自动重新注入：不可用"; elif hook_installed; then echo "自动重新注入：已安装"; else echo "自动重新注入：未安装"; fi
    ;;
  hook) need_spotify; mode="${MODE:-$(current_mode)}"; install_hook "$mode" "$(current_server)" "$(current_request "$mode")" ;;
  unhook) remove_hook ;;
esac
