# Spot-Lyric for Spotify

Spotify 桌面客户端的第三方歌词插件，支持 Windows / macOS / Linux。  
界面沿用 Spotify 原生风格，歌词来自网易云音乐和 QQ 音乐（Spotify 官方歌词兜底），支持逐字高亮、双语翻译。可以用云端服务器共享歌词，也可以纯本地使用，不连接任何远程服务器。

---

## 特性

- **原生质感**：深度融入 Spotify 官方界面，背景色跟随封面，字号自动适配。
- **多源歌词**：网易云、QQ 音乐，Spotify 官方歌词兜底；支持逐字歌词和翻译。
- **精准匹配**：参考 Lyricify、LDDC 的做法，包括：繁简归一；识别版本标签（Live / Remix / Inst / xxx ver.）；多艺术家和「角色 (CV:声优)」别名；按时长差分级打分；缺失字段时重新分配权重；搜索词逐步放宽。艺术家名跨语言时（如 Eason Chan / 陈奕迅），用 Spotify 歌词正文核对。
- **本地匹配**：搜索、评分、歌词下载和解析都在本机完成。
- **三种使用方式**：云端服务器（多设备共享）、纯本地 · 本地服务、纯本地 · 直连，安装时按提示一步步选择。
- **背景**：柔和封面取色 / 封面模糊 / 深色。

---

## 快速安装

macOS / Linux 运行 `patch.sh`，Windows 运行 `patch.cmd`（实际执行 `patch.ps1`），两边的命令、参数和引导步骤完全一样。不带参数运行会一步步引导：

```
[1] 选择使用方式                     云端服务器 / 纯本地
云端：  [2] 歌词服务器地址
        [3] 网易云 / QQ 请求怎么发出？   直连 / 经歌词服务器转发（macOS 不支持直连，不问）
纯本地：使用本地服务，不用再选
最后：  Spotify 更新后自动重新注入？
```

注入由脚本自己完成，不需要额外程序：`patch.sh` 只用系统自带的工具（bash、gzip、od、awk、curl，macOS 自带的 bash 3.2 即可），不需要 python、zip / unzip；`patch.ps1` 只用 Windows 自带的 PowerShell 5.1。只有选择纯本地时，才会获取本地服务程序 `spot-lyric-server`：本机装了 Go 就从源码编译，否则下载 CI 编译好的对应版本（GitHub Releases `v<VERSION>`，带 SHA256 校验）。

> Windows 不支持 Microsoft Store 版 Spotify，请从官网下载安装。Spotify 自动更新后重新运行即可，选了「自动重新注入」的话会自己处理。

### 一键安装（无需克隆仓库）

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/dibin666/spotify-patch-lryic/main/patch.sh | bash
# 带参数：... | bash -s -- --mode local
```

**Windows**（PowerShell）

```powershell
$d="$env:TEMP\spot-lyric"; Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue; Invoke-WebRequest https://github.com/dibin666/spotify-patch-lryic/archive/refs/heads/main.zip -OutFile "$d.zip"; Expand-Archive "$d.zip" $d -Force; powershell -NoProfile -ExecutionPolicy Bypass -File "$d\spotify-patch-lryic-main\patch.ps1"
# 带参数：在最后追加，例如 ... patch.ps1" --mode local
```

`hook`（自动重新注入）会把所需文件复制到固定位置，所以一键安装用的临时目录删掉也不影响。

### 在仓库目录中

```bash
./patch.sh            # macOS / Linux
patch.cmd             # Windows（双击也可以）
```

---

## 使用方式

| 使用方式 | 参数 | 远程服务器 | 网易云 / QQ 请求怎么发出 | 系统 |
| --- | --- | --- | --- | --- |
| 云端服务器 · 直连 | `--mode cloud --request direct` | 保存共享的匹配和歌词 | Spotify 以 `--disable-web-security` 启动，请求从本机直接发出 | Windows / Linux |
| 云端服务器 · 经服务器转发（默认） | `--mode cloud --request server` | 保存共享的匹配和歌词 | 歌词服务器原样转发（只转发白名单域名和接口） | 全部 |
| 纯本地 | `--mode local` | 无 | 本机 `127.0.0.1:38917` 的本地服务（`spot-lyric-server`，仅此方式需要下载 / 编译）转发 | 全部 |
| 纯本地 · 直连（高级，仅命令行） | `--mode direct` | 无 | 不装本地服务，Spotify 以 `--disable-web-security` 启动 | Windows / Linux |

Spotify 内置浏览器会强制执行 CORS，而网易云 / QQ 音乐的接口不允许跨域读取，所以请求必须走上面其中一条路径。

**始终本地优先**：无论安装时选了哪种方式，插件都按「直连 → 本地服务 → 歌词服务器」的顺序尝试。能直连就直连；本地服务在运行就用本地服务；两者都不可用时，云端模式才交给歌词服务器转发，纯本地模式则直接报错，从不访问远程服务器。

不管哪种方式，匹配都在本机完成，「使用此歌词」也会保存在本机。只有云端模式会把它上传到服务器，供所有设备共享；播放栏歌词图标旁的上传按钮也只在云端模式下出现。

**本地服务**就是 `spot-lyric-server serve --local`（与歌词服务器是同一个程序）：只监听 `127.0.0.1`，只接受 Spotify 页面的请求，只转发白名单接口，内存占用约 10 MB，登录后自动启动：

| 系统 | 自启方式 | 程序与日志 |
| --- | --- | --- |
| Linux | systemd 用户服务 `spot-lyric-local.service`（没有 systemd 时用 XDG 自启） | `~/.local/share/spot-lyric/` |
| macOS | LaunchAgent `com.spotlyric.local` | `~/Library/Application Support/SpotLyric/` |
| Windows | 登录启动项 `SpotLyricLocal`（隐藏窗口） | `%LOCALAPPDATA%\SpotLyric\` |

**直连**会关闭 Spotify 内置浏览器的同源限制。新版 Chromium 要求同时指定一个非默认的 `--user-data-dir`：Linux 用符号链接 `~/.config/spotify-direct` 指向原配置目录，登录状态不受影响，并写入 `~/.local/share/applications/spotify.desktop`；Windows 使用 `%LOCALAPPDATA%\Spotify\DirectProfile`，并修改 Spotify 快捷方式和开机自启项，首次启动可能需要重新登录。macOS 无法给从 Dock / 启动台打开的 Spotify 加启动参数，所以不支持这种方式，请改用本地服务。

在 Spotify 里，「歌词设置 > 使用方式与网络」会显示安装时选择的请求方式、本地服务状态和本次各路径的请求次数，也可以在云端和纯本地之间临时切换。重新运行脚本会以安装时的选择为准。

---

## 命令速查

下面都以 `./patch.sh` 为例，Windows 换成 `patch.cmd`。

| 操作 | 命令 |
| --- | --- |
| 引导安装 / 更新 / 更换使用方式 | `./patch.sh` |
| 不询问，纯本地 | `./patch.sh --mode local -y` |
| 不询问，云端 + 本机直连 | `./patch.sh --mode cloud --request direct -y` |
| 不询问，云端 + 经服务器转发 | `./patch.sh --mode cloud --request server -y` |
| 不询问，纯本地 · 直连（不装本地服务） | `./patch.sh --mode direct -y` |
| 不询问，使用自建服务器 | `./patch.sh --server https://lyrics.example.com -y` |
| 运行状态 | `./patch.sh status` |
| 只重新注入（沿用上次的方式） | `./patch.sh apply` |
| 还原官方客户端 | `./patch.sh restore` |
| 彻底卸载（含钩子、本地服务、直连参数） | `./patch.sh uninstall` |
| 安装 / 移除自动重新注入 | `./patch.sh hook` / `./patch.sh unhook` |

常用选项：`--spotify-path P`（手动指定 Spotify 位置；macOS 填 Spotify.app）、`--hook` / `--no-hook`、`--restart` / `--no-restart`、`-y`（不询问）、`-q`（安静模式）。完整说明见 `./patch.sh --help`。旧版的 `-Server`、`-NoRestart`、`-SpotifyPath` 等写法仍然有效；`--direct` / `-Direct` 表示「纯本地 · 直连」，`--no-direct` 等同 `--request server`，`--request service` 等同 `--mode local`。没有记录过选择时，1.2 版 `--direct` 留下的直连启动项会被识别为「云端 + 直连」。

macOS 注入后会自动重新签名（ad-hoc）。Linux 的 Spotify 装在系统目录时，写入这一步会通过 sudo 请求权限。

---

## 自建歌词服务器（可选，云端模式）

服务器只做两件事：保存共享的匹配和歌词（每个 Spotify 曲目对应一个 R2 对象，以最新上传为准；Spotify 官方歌词不会被上传），以及白名单转发（`RELAY=0` 可关闭）。

默认使用公共服务器（`https://spo.564616.xyz`），也可以用 Docker 自建：

```bash
cd server
cp .env.example .env    # 按需配置存储（支持 Cloudflare R2 / S3 / 本地卷）
docker compose up -d --build
```

- 验证服务：`curl http://127.0.0.1:38917/health`；完整自检：`tools/server-smoke.sh http://127.0.0.1:38917`
- 在安装引导中填写服务器地址，或在客户端「歌词设置 > 使用方式与网络」中修改。
- 镜像里运行的就是 `spot-lyric-server`，纯本地模式的本地服务也是它。

---

## 开发

```
patch.sh / patch.ps1   注入 Spotify、分步引导、直连、本地服务安装、钩子（两者行为一致）
src/                   注入到 Spotify 的插件
server/                歌词服务器（存储 + 转发），也是纯本地模式的本地服务
cmd/spot-lyric-server/ 服务端程序入口：serve [--local]、healthcheck、version
```

```bash
go vet ./... && go test ./...                      # 服务端
SPOT_LYRIC_OFFLINE=1 node --test tests/*.test.mjs  # 插件匹配引擎、请求路径、服务器端到端
tests/patch_test.sh [解包的安装包目录]               # patch.sh 与 patch.ps1（pwsh）注入 / 还原
powershell -File tests\patch_test.ps1              # Windows PowerShell 5.1 下的 patch.ps1
```

CI 每次推送都会在 6 个原生 runner（Windows / macOS / Linux × amd64 / arm64）上分别测试并编译 `spot-lyric-server`，在 macOS（bash 3.2）和 Windows（PowerShell 5.1）上测试 patch 脚本，然后发布到 Release `v<VERSION>`。修改 `VERSION` 即发布新版本。
