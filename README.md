# Spot-Lyric for Spotify

Spotify 桌面客户端第三方歌词插件（支持 Windows / macOS / Linux）。  
采用原生 UI 风格，接入网易云音乐与 QQ 音乐（官方兜底），支持逐字高亮、双语翻译与跨设备云端同步。

---

## 特性

- **原生质感**：深度融合 Spotify 官方界面，自适应封面配色与动态字号。
- **多源歌词**：支持网易云、QQ 音乐与官方歌词兜底，支持逐字歌词与翻译。
- **精准匹配**：参考 Lyricify、LDDC 的匹配方式——繁简归一、版本标签（Live / Remix / Inst / xxx ver.）、多艺术家与「角色 (CV:声优)」别名、分级时长、缺失字段重新加权、逐步放宽的搜索词；跨语言艺术家（Eason Chan / 陈奕迅）用 Spotify 歌词正文核对。
- **本地匹配**：搜索、评分、歌词下载和解析都在本机进行；服务器只保存匹配与歌词。
- **云端共享**：「使用此歌词」或播放栏歌词图标旁的小箭头把当前歌词上传到服务器，所有设备直接使用。
- **背景**：柔和封面取色 / 封面模糊 / 深色。

---

## 快速安装

> **注意**：Windows 不支持 Microsoft Store 商店版（请从官网下载安装）。Spotify 自动更新后重新运行脚本即可（或使用 `hook` 自动重注）。

### 一键安装（无需克隆仓库）

脚本会下载最新代码到临时目录并运行，命令后面可直接追加参数（如 `restore`、`status`、`--server ...`）。

**macOS / Linux**

```bash
d=$(mktemp -d) && curl -fsSL https://github.com/dibin666/spotify-patch-lryic/archive/refs/heads/main.tar.gz | tar xz -C "$d" --strip-components=1 && bash "$d/patch.sh"
# 追加参数示例：... && bash "$d/patch.sh" restore
```

**Windows**（PowerShell）

```powershell
$d="$env:TEMP\spot-lyric"; Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue; Invoke-WebRequest https://github.com/dibin666/spotify-patch-lryic/archive/refs/heads/main.zip -OutFile "$d.zip"; Expand-Archive "$d.zip" $d -Force; & "$d\spotify-patch-lryic-main\patch.ps1"
# 追加参数示例：... patch.ps1 restore    或    patch.ps1 -Server https://lyrics.example.com
```

`hook` 会把所需文件复制到固定位置，所以用一键方式执行 `hook` 后，临时目录删除也不影响自动重新注入。

### Windows

双击运行 `patch.cmd`，或在终端执行：

```bat
patch.cmd             :: 注入安装（自动重启 Spotify）
patch.cmd restore     :: 还原官方客户端
patch.cmd hook        :: 可选：开机/登录时自动检查并重新注入
```

### macOS / Linux

在终端执行：

```bash
./patch.sh            # 注入安装（macOS 会自动重签名）
./patch.sh restore    # 还原官方客户端
./patch.sh hook       # 可选：系统或应用更新后自动重新注入
```

- 指定自建服务器：`./patch.sh --server https://lyrics.example.com`（Windows：`patch.cmd -Server ...`）
- 指定安装路径：`./patch.sh --spotify-path /path/to/Spotify`
- 本机直连网易云 / QQ 音乐：`./patch.sh --direct`（Windows：`patch.cmd -Direct`，取消用 `--no-direct` / `-NoDirect`）

### 网易云 / QQ 音乐请求怎么发出

Spotify 内置浏览器强制 CORS，而网易云 / QQ 音乐的接口不允许跨域读取，所以：

- **默认**：插件先尝试直连，被拦截后把自己构造好的请求交给歌词服务器原样转发（仅白名单域名与接口），匹配仍在本机。
- **`--direct`**：以 `--disable-web-security` 启动 Spotify，请求全部从本机发出，不经过服务器。该参数会关闭 Spotify 内置浏览器的同源限制；Linux 写入 `~/.local/share/applications/spotify.desktop`，Windows 修改 Spotify 快捷方式与开机自启项，macOS 不支持（自动使用转发）。从其它入口启动时未带参数也没关系，会自动改用转发。

「歌词设置 > 歌词服务器 > 网络」显示当前方式，也可关闭服务器转发。

---

## 命令速查

| 操作 | macOS / Linux | Windows |
| --- | --- | --- |
| 安装 / 更新 | `./patch.sh` | `patch.cmd` |
| 运行状态 | `./patch.sh status` | `patch.cmd status` |
| 还原官方 | `./patch.sh restore` | `patch.cmd restore` |
| 彻底卸载 | `./patch.sh uninstall` | `patch.cmd uninstall` |
| 自动重注 | `./patch.sh hook` | `patch.cmd hook` |

---

## 自建歌词服务器（可选）

服务器只做两件事：保存共享的匹配与歌词（每个 Spotify 曲目一个 R2 对象，最新上传生效；Spotify 官方歌词不会被上传），以及白名单转发（`RELAY=0` 可关闭）。v1.2 起不再在服务器上匹配，旧版客户端需重新运行 patch 脚本更新。

默认使用公共服务器（`https://spo.564616.xyz`），亦可通过 Docker 自建：

```bash
cd server
cp .env.example .env    # 按需配置存储（支持 Cloudflare R2 / S3 / 本地卷）
docker compose up -d --build
```

- 验证服务：`curl http://127.0.0.1:38917/health`，完整自检：`tools/server-smoke.sh http://127.0.0.1:38917`
- 安装时指定服务器或在客户端「歌词设置 > 歌词服务器」中修改。
