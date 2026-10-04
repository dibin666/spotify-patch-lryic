#!/usr/bin/env bash
# Spot-Lyric for Spotify — macOS / Linux launcher (Windows: patch.cmd).
#
# Everything is done by the spot-lyric program (cmd/spot-lyric, the same on every
# system); this script only gets it and passes all arguments on:
#   - in a checkout with Go installed: built from source;
#   - otherwise: the prebuilt binary of this version from GitHub Releases (built by CI).
#
#   ./patch.sh                 guided install (asks step by step)
#   ./patch.sh --help          commands and options
#   curl -fsSL https://raw.githubusercontent.com/dibin666/spotify-patch-lryic/main/patch.sh | bash
#
# Env: SPOT_LYRIC_BIN (use this program), SPOT_LYRIC_BUILD=0 (never build from source).
set -euo pipefail

REPO=dibin666/spotify-patch-lryic
ROOT=""
if [[ -n ${BASH_SOURCE[0]:-} && -f ${BASH_SOURCE[0]} ]]; then ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"; fi

die() { printf '\033[1;31m[spot-lyric]\033[0m %s\n' "$*" >&2; exit 1; }
say() { printf '\033[1;32m[spot-lyric]\033[0m %s\n' "$*" >&2; }

case "$(uname -s)" in
  Darwin) os=darwin; cache="$HOME/Library/Caches/spot-lyric" ;;
  Linux)  os=linux;  cache="${XDG_CACHE_HOME:-$HOME/.cache}/spot-lyric" ;;
  *) die "不支持的系统：$(uname -s)（Windows 请运行 patch.cmd）" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "不支持的处理器架构：$(uname -m)" ;;
esac
# Apple silicon running this shell under Rosetta still gets the native build.
[[ $os == darwin && $arch == amd64 && "$(sysctl -n hw.optional.arm64 2>/dev/null)" == 1 ]] && arch=arm64

fetch() {  # fetch URL FILE
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else die "需要 curl 或 wget"; fi
}
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }

obtain() {
  if [[ -n ${SPOT_LYRIC_BIN:-} ]]; then printf '%s' "$SPOT_LYRIC_BIN"; return; fi
  mkdir -p "$cache"
  local version="" bin
  [[ -n $ROOT && -f $ROOT/VERSION ]] && version="$(tr -d ' \r\n' < "$ROOT/VERSION")"
  # A checkout + Go: build exactly this source (fast after the first time).
  if [[ -n $ROOT && -f $ROOT/go.mod && ${SPOT_LYRIC_BUILD:-1} != 0 ]] && command -v go >/dev/null 2>&1; then
    bin="$cache/spot-lyric-dev"
    if (cd "$ROOT" && CGO_ENABLED=0 go build -trimpath -o "$bin.tmp" ./cmd/spot-lyric) >&2; then
      mv -f "$bin.tmp" "$bin"; printf '%s' "$bin"; return
    fi
    say "从源码编译失败，改为下载预编译程序"
  fi
  local asset="spot-lyric-$os-$arch" tag base
  for tag in ${version:+"v$version"} latest; do
    if [[ $tag == latest ]]; then base="https://github.com/$REPO/releases/latest/download"
    else base="https://github.com/$REPO/releases/download/$tag"; fi
    bin="$cache/$asset-$tag"
    [[ $tag != latest && -x $bin ]] && { printf '%s' "$bin"; return; }
    say "下载 $asset（$tag）…"
    if fetch "$base/$asset" "$bin.tmp" 2>/dev/null; then
      if fetch "$base/SHA256SUMS" "$cache/SHA256SUMS" 2>/dev/null; then
        local want; want="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$cache/SHA256SUMS")"
        [[ -z $want || $want == "$(sha256 "$bin.tmp")" ]] || { rm -f "$bin.tmp"; die "$asset 校验失败（SHA256 不一致）"; }
      fi
      chmod +x "$bin.tmp"; mv -f "$bin.tmp" "$bin"
      [[ $os == darwin ]] && xattr -d com.apple.quarantine "$bin" 2>/dev/null || true
      printf '%s' "$bin"; return
    fi
    rm -f "$bin.tmp"
  done
  die "无法下载 spot-lyric（https://github.com/$REPO/releases）。可安装 Go 后在仓库目录中运行本脚本以从源码编译。"
}

bin="$(obtain)"
# Prompts need a terminal even when this script arrives through a pipe (curl ... | bash).
if [[ ! -t 0 ]] && { : < /dev/tty; } 2>/dev/null; then exec "$bin" "$@" < /dev/tty; fi
exec "$bin" "$@"
