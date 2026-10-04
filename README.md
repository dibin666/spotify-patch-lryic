# Spot-Lyric for Spotify

Spotify 桌面客户端第三方歌词插件（支持 Windows / macOS / Linux）。  
采用原生 UI 风格，接入网易云音乐与 QQ 音乐（官方兜底），支持逐字高亮、双语翻译与跨设备云端同步。

---

## 特性

- **原生质感**：深度融合 Spotify 官方界面，自适应封面配色与动态字号。
- **多源歌词**：支持网易云、QQ 音乐与官方歌词兜底，支持逐字歌词与翻译。
- **精准匹配**：智能评分自动匹配，支持手动检索、校准与歌词比对。
- **云端同步**：手动匹配结果多端实时共享，无需重复配置。
- **轻量稳定**：无需本地代理，支持客户端自动恢复注入。

---

## 快速安装

> **注意**：Windows 不支持 Microsoft Store 商店版（请从官网下载安装）。Spotify 自动更新后重新运行脚本即可（或使用 `hook` 自动重注）。

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

默认使用公共服务器（`https://spo.564616.xyz`），亦可通过 Docker 自建：

```bash
cd server
cp .env.example .env    # 按需配置存储（支持 Cloudflare R2 / S3 / 本地卷）
docker compose up -d --build
```

- 验证服务：`curl http://127.0.0.1:38917/health`
- 安装时指定服务器或在客户端「歌词设置 > 歌词服务器」中修改。
