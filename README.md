# Spot-Lyric for Spotify

给 Spotify 桌面客户端（**Windows / macOS / Linux**）注入第三方歌词页：在底部播放栏官方歌词按钮左侧增加一个入口，打开一个高仿 Spotify 官方歌词页的页面，歌词来自网易云音乐 / QQ 音乐（Spotify 官方歌词兜底），匹配逻辑移植自 [spot-lyric](../spot-lyric)。

搜索、匹配和歌词下载都在**歌词服务器**上进行（默认 `https://spo.564616.xyz`，也可以[自己部署](#自部署歌词服务器)），客户端不再需要本地代理。点击「使用此歌词」后，这首歌的匹配信息和歌词会保存在服务器的 Cloudflare R2 中，之后任何设备播放这首歌都直接使用它；重新选择会覆盖为最新的一次。

## 安装

### Windows（10 / 11，x64 或 ARM64）

在文件夹里双击 `patch.cmd`，或在 PowerShell / CMD 中：

```bat
patch.cmd             :: 注入插件（会自动关闭并重新打开 Spotify）
patch.cmd status
patch.cmd hook        :: 可选：每次登录 Windows 时检查并重新注入（Spotify 会静默自动更新）
patch.cmd restore     :: 还原 Spotify 原始文件
patch.cmd uninstall   :: 还原 + 移除钩子（及旧版本地代理）
patch.cmd -SpotifyPath "D:\Apps\Spotify"   :: 手动指定安装目录
patch.cmd -Server https://lyrics.example.com  :: 使用自己部署的歌词服务器
```

- 支持 spotify.com 安装包（默认 `%APPDATA%\Spotify`）和 `SpotifyFullSetup.exe /extract` 解压到 Program Files 的方式。
- **不支持 Microsoft Store 版**（安装在只读的 WindowsApps 目录）。检测到时会提示先卸载，再从 spotify.com/download 安装普通版。
- Spotify 运行时会锁住 `xpui.spa`，所以需要写入时脚本会先关闭 Spotify，写完再打开。
- 旧版本安装的本地代理（`%LOCALAPPDATA%\SpotLyric\spot-lyric-proxy.exe`）会在 `install` / `uninstall` 时自动移除。

### macOS（13+，Apple Silicon / Intel）

```bash
./patch.sh            # 注入 + 重新签名 + 重启 Spotify
./patch.sh status
./patch.sh hook       # 可选：LaunchAgent 在登录时、以及 Spotify 更新替换 xpui.spa 后自动重新注入
./patch.sh restore | uninstall
./patch.sh --spotify-path ~/Applications/Spotify.app
```

- 自动查找 `/Applications/Spotify.app` 和 `~/Applications/Spotify.app`。
- 修改 `Contents/Resources` 会使 Spotify 的签名失效，macOS 13+ 会拒绝启动签名损坏的应用。所以注入后会执行 `xattr -cr` + `codesign -f --deep -s -`（ad-hoc 重签名，与 SpotX 相同）并校验。
- 如果提示 *Operation not permitted*，到「系统设置 > 隐私与安全性 > App 管理」（或「完全磁盘访问权限」）中允许你的终端 App 后重试。
- 不依赖 python3。打包用系统自带的 `zip` / `unzip`。

### Linux（deb / flatpak / 手动安装）

```bash
./patch.sh            # 注入 + 重启 Spotify
./patch.sh status
./patch.sh hook       # 可选：apt 升级 spotify-client 后自动重新注入
./patch.sh restore | uninstall
```

只有安装目录不可写时才会调用 sudo。Snap 版是只读文件系统，无法注入。

### 通用说明

- `--server URL`（Windows：`-Server URL`）指定歌词服务器，默认 `https://spo.564616.xyz`；也可以安装后在「歌词设置 > 歌词服务器」里修改地址和令牌。
- 旧版本的本地歌词代理（LaunchAgent / systemd 用户服务 / 登录自启项）会在 `install` 和 `uninstall` 时自动清理。
- 每次修改前都会保留原始文件 `Apps/xpui.spa.spot-lyric.bak`。如果检测到 Spotify 发布了新的 `xpui.spa`，会把它当作新的原始文件，自动刷新备份。
- 三个平台写入的 `index.html` 标记和构建摘要完全相同，`status` 可以直接看出是否为同一版本。
- Spotify 更新会覆盖补丁：重新运行脚本即可，装了 `hook` 则会自动处理。

## 功能

- **入口按钮**：与官方歌词按钮同组、同样式，打开时变绿并显示圆点。
- **歌词页**：
  - 背景取自专辑封面（Spotify 歌词时用官方配色）。
  - 行距、粗体标题字体、2 / 3 / 4rem 字号自适应。
  - 未唱行深色、当前行白色、已唱行半透明；点击跳转。
  - 自动滚动、"同步"按钮、未同步提示、"歌词提供者"、底部悬浮控件都与官方一致。
  - 支持逐字高亮（网易云 yrc / 增强 LRC / Spotify 音节）和译文。
- **自动匹配**（spot-lyric 规则）：
  - 按歌名、主艺术家、专辑、版本标记和总时长评分。
  - 时长差超过 3 秒不绑定；低分或歧义结果需手动确认。
  - 额外支持假名与罗马音互认（「ぎゅって」 = gyutte），以及 QQ 音乐标题里的译名括注。
  - 元数据无法判断时，会用 Spotify 歌词正文核对候选（歌词比对）。
- **手动匹配**：分来源列出候选，带评分、原因和标签，可预览后点「使用此歌词」。匹配信息和歌词保存到服务器（R2），所有设备共享；重新选择则以最新一次为准，「解除绑定」会删除服务器上的记录。支持粘贴歌曲链接，以及导入 / 复制 LRC（导入的 LRC 和本地文件只保存在本机）。
- **设置**：首选歌词源、Spotify 歌词优先、预加载、歌词比对、宽松匹配、译文、逐字、字号、背景、全局 / 单曲偏移、歌词服务器地址 / 令牌 / 状态、流量统计、清理缓存。

## 结构

```
patch.sh                     Linux + macOS（bash 3.2 兼容）
patch.ps1 / patch.cmd        Windows（PowerShell 5.1+）
src/core.js                  spot-lyric 移植：匹配、评分、LRC / yrc 解析、提供方请求、匹配引擎（服务器）、RemoteEngine（客户端）
src/app.js / app.css         Spotify 端：入口、歌词页、匹配面板、设置、IndexedDB
server/                      歌词服务器（Node.js，零依赖）+ Dockerfile + docker-compose.yml
tools/xpui_patch.py          Linux 的 xpui.spa 注入 / 还原
tools/server-smoke.sh        部署后的歌词服务器冒烟测试
tests/core.test.mjs          匹配引擎（SPOT_LYRIC_OFFLINE=1 跳过联网）
tests/server.test.mjs        服务器 + 客户端端到端（模拟网易云 / QQ 与 R2）
tests/patch_test.sh          用三个平台真实的 xpui.spa 跑注入 / 幂等 / 更新 / 还原
```

### 工作方式

Spotify 页面运行在 `https://xpui.app.spotify.com`，网易云 / QQ 音乐接口不返回 CORS 头，所以由歌词服务器完成所有外部请求：

1. 切歌时客户端把曲目信息（Spotify 链接、歌名、艺术家、专辑、时长）发给 `POST /api/match`。服务器先查这首歌有没有人工匹配（R2），有就直接返回保存的歌词；否则按 spot-lyric 规则搜索、评分、下载歌词。
2. 网易云 / QQ 都没有结果时，客户端用自己的 Spotify 登录读取官方歌词作兜底；需要「歌词比对」时，只把歌词文本发给服务器核对候选。
3. 「使用此歌词」调用 `POST /api/bind`：服务器自己重新下载这首歌词（不接受客户端上传的歌词文本），写入 R2 对象 `lyrics/<Spotify 曲目 ID>.json`，内容是 Spotify 链接与匹配歌词的一对一记录：

   ```json
   {
     "spotify_url": "https://open.spotify.com/track/0RiRZpuVRbi7oqRdSMwhQY",
     "track": { "title": "晴天", "artists": ["周杰伦"], "album": "叶惠美", "duration_ms": 269000 },
     "match": { "provider": "netease", "id": "2668397359", "title": "晴天", "provider_name": "网易云音乐", "url": "https://music.163.com/#/song?id=2668397359", "...": "..." },
     "sync_type": "line", "line_count": 63, "bind_count": 2, "created_at": "...", "updated_at": "...",
     "lrc": "[00:00.000]晴天 - 周杰伦 ...",
     "lyrics": { "source": "netease", "lines": [ ... ] }
   }
   ```

   同一首歌再次选择会覆盖这个对象（最新一次生效），「解除绑定」会删除它。自动匹配的结果不会保存。
4. 服务器只在内存里短时间缓存网易云 / QQ 的响应，不在本机磁盘保存任何歌词或匹配数据。歌词服务器不可用时，Spotify 官方歌词仍然可用。

## 自部署歌词服务器

需要 Docker。歌词与匹配保存在 Cloudflare R2（免费额度：10 GB 存储、每月 100 万次写 / 1000 万次读），也可用任何 S3 兼容存储；不配置时退回到容器卷里的本地目录。

```bash
# 1. 创建 R2 存储桶（Cloudflare CLI：npm i -g cf && cf auth login）
cf r2 buckets create --name spot-lyric
# 2. 创建只能读写这个桶的 API 令牌（权限 Workers R2 Storage Bucket Item Read / Write），
#    S3 Access Key ID = 令牌 ID，Secret Access Key = 令牌值的 SHA-256（十六进制）
# 3. 配置并启动
cd server
cp .env.example .env        # 填写 R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
docker compose up -d --build
curl http://127.0.0.1:38917/health      # {"ok":true,"storage":"r2",...}
```

对外发布（HTTPS）：

- 已有 Cloudflare Tunnel：在隧道里加一条公共主机名 → `http://<主机地址>:38917`（`.env` 中的 `BIND_ADDRESS` / `HOST_PORT` 决定发布在哪个地址和端口）。
- 新建隧道：把隧道令牌写入 `.env` 的 `TUNNEL_TOKEN`，运行 `docker compose --profile tunnel up -d --build`，公共主机名指向 `http://spot-lyric-server:8080`。
- 也可以用任意 HTTPS 反向代理。

然后安装插件时指定 `./patch.sh --server https://你的域名`（Windows：`patch.cmd -Server https://你的域名`），或在「歌词设置 > 歌词服务器」里修改。部署后可运行 `tools/server-smoke.sh https://你的域名` 检查。

可选设置（见 `server/.env.example`）：`API_TOKEN`（客户端需在设置中填写同一令牌）、`ALLOWED_ORIGINS`、每分钟请求限制 `RATE_LIMIT` / `WRITE_RATE_LIMIT`、`NETEASE_REAL_IP`（服务器在海外时网易云会返回加密的搜索结果，默认带一个大陆地址的 `X-Real-IP`）、`QQ_MIN_INTERVAL_MS`（QQ 音乐会对同一 IP 的突发请求返回 2001 限流，服务器会自动间隔和重试）、`CACHE_MB`。

### API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 版本、存储类型 |
| POST | `/api/match` | `{track, settings, force?, spotify?}` → 自动匹配 / 已保存的歌词 |
| POST | `/api/search` | `{query, track, settings}` → 按来源分组的候选（带评分、原因、是否已绑定） |
| POST | `/api/lyrics` | `{candidate}` → 预览歌词 |
| POST | `/api/bind` | `{track, candidate}` → 「使用此歌词」，写入 R2 |
| POST | `/api/unbind` | `{track}` → 删除这首歌的匹配 |
| GET | `/api/bindings/<Spotify 曲目 ID>` | 查看保存的匹配（含 LRC） |

## 测试

```bash
node --test tests/*.test.mjs          # 引擎 + 服务器端到端（SPOT_LYRIC_OFFLINE=1 跳过联网测试）
tools/server-smoke.sh https://spo.564616.xyz   # 已部署的服务器
# 下载 SpotifyFullSetupX64.exe / SpotifyARM64.dmg 后解包（exe 可用 SpotX-Official/Spotify-EXE-Unpacker，dmg 用 7z x），
# 按 tests/patch_test.sh 头部说明放置；PWSH 指向 pwsh 可同时测试 patch.ps1
PWSH=pwsh tests/patch_test.sh /path/to/unpacked
```
