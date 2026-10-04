package patcher

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

func Usage(version string) string {
	return fmt.Sprintf(`Spot-Lyric for Spotify v%s（Windows / macOS / Linux 同一套命令）

用法: spot-lyric [命令] [选项]
      （仓库中：macOS / Linux 运行 ./patch.sh，Windows 运行 patch.cmd，参数相同）

命令:
  install      安装 / 更新（默认）：分步选择使用方式，注入插件并完成相应设置
  apply        只注入插件（沿用上次选择的使用方式）
  status       查看 Spotify、补丁、使用方式和服务状态
  restore      还原 Spotify 原始文件
  uninstall    还原 Spotify，并移除钩子、本地服务和直连启动参数
  hook         安装自动重新注入（Spotify 更新后）
  unhook       移除自动重新注入
  serve        运行歌词服务器（--local：本机 127.0.0.1:38917 本地服务）
  version      显示版本

使用方式（--mode）:
  cloud        云端服务器（默认）：服务器保存共享的匹配与歌词，本机无法直连时转发请求
  local        纯本地 · 本地服务：在 127.0.0.1:38917 运行后台小服务转发请求，不连接远程服务器
  direct       纯本地 · 直连：以 --disable-web-security 启动 Spotify，无后台进程（不支持 macOS）

选项:
  --mode M             使用方式：cloud / local / direct（不指定时分步询问）
  --server URL         歌词服务器地址（cloud，默认 %s）
  --local / --direct   等同 --mode local / --mode direct
  --spotify-path P     手动指定 Spotify 位置（Windows / Linux：安装目录；macOS：Spotify.app）
  --hook / --no-hook   安装 / 不安装自动重新注入
  --restart            完成后总是重启 Spotify
  --no-restart         不重启 Spotify
  -y, --yes            不询问，使用参数、上次的选择或默认值
  -q, --quiet          安静模式
  -h, --help           显示帮助
`, version, DefaultServer)
}

var commands = map[string]bool{
	"install": true, "apply": true, "restore": true, "uninstall": true, "status": true,
	"hook": true, "unhook": true, "version": true, "help": true, "__xpui": true,
}

var serverRe = regexp.MustCompile(`^https?://[A-Za-z0-9._~:/-]+$`)

func validServer(url string) string {
	if !serverRe.MatchString(url) {
		return "地址无效，例如 https://lyrics.example.com"
	}
	return ""
}

/*
ParseArgs reads the command line. Long options may be written --name, -name or
in the PowerShell style of earlier releases (-Server, -NoRestart, -SpotifyPath).
*/
func ParseArgs(args []string) (Options, error) {
	opts := Options{Command: "", Restart: "auto"}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if opts.Command == "__xpui" {
			opts.Args = append(opts.Args, arg)
			continue
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			if opts.Command != "" {
				return opts, fmt.Errorf("多余的参数：%s", arg)
			}
			name := strings.ToLower(arg)
			if !commands[name] {
				return opts, fmt.Errorf("未知命令：%s", arg)
			}
			opts.Command = name
			continue
		}
		name, value, hasValue := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		key := strings.NewReplacer("-", "", "_", "").Replace(strings.ToLower(name))
		take := func() (string, error) {
			if hasValue {
				return value, nil
			}
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s 需要一个值", arg)
			}
			i++
			return args[i], nil
		}
		var err error
		switch key {
		case "mode":
			var v string
			if v, err = take(); err == nil {
				switch strings.ToLower(v) {
				case "cloud", "server", "remote":
					opts.Mode = ModeCloud
				case "local", "service":
					opts.Mode = ModeLocal
				case "direct":
					opts.Mode = ModeDirect
				default:
					err = fmt.Errorf("未知的使用方式：%s（cloud / local / direct）", v)
				}
			}
		case "server":
			if opts.Server, err = take(); err == nil {
				opts.Server = strings.TrimRight(strings.TrimSpace(opts.Server), "/")
				if msg := validServer(opts.Server); msg != "" {
					err = fmt.Errorf("歌词服务器%s", msg)
				}
			}
		case "cloud":
			opts.Mode = ModeCloud
		case "local":
			opts.Mode = ModeLocal
		case "direct":
			opts.Mode = ModeDirect
		case "nodirect":
			opts.Mode = ModeCloud
		case "spotifypath":
			opts.SpotifyPath, err = take()
		case "restart":
			opts.Restart = "yes"
		case "norestart":
			opts.Restart = "no"
		case "hook":
			opts.Hook = "on"
		case "nohook":
			opts.Hook = "off"
		case "yes", "y":
			opts.Yes = true
		case "quiet", "q":
			opts.Quiet = true
		case "help", "h":
			opts.Command = "help"
		default:
			err = fmt.Errorf("未知参数：%s", arg)
		}
		if err != nil {
			return opts, err
		}
	}
	if opts.Command == "" {
		opts.Command = "install"
	}
	return opts, nil
}

var errCancelled = errors.New("已取消，没有做任何修改")

/* Main runs one command and returns the exit status. */
func Main(version string, args []string) int {
	opts, err := ParseArgs(args)
	if err != nil {
		fmt.Fprint(os.Stderr, Usage(version))
		fmt.Fprintln(os.Stderr, "\n[spot-lyric] "+err.Error())
		return 2
	}
	switch opts.Command {
	case "help":
		fmt.Print(Usage(version))
		return 0
	case "version":
		fmt.Println(version)
		return 0
	case "__xpui":
		return internalXpui(version, opts.Args)
	}
	c := NewCtx(version, opts)
	if code, done := c.dropRoot(args); done {
		return code
	}
	c.setupInput()
	switch opts.Command {
	case "install":
		err = c.cmdInstall()
	case "apply":
		err = c.cmdApply()
	case "restore":
		err = c.cmdRestore(false)
	case "uninstall":
		err = c.cmdRestore(true)
	case "status":
		err = c.cmdStatus()
	case "hook":
		err = c.cmdHook()
	case "unhook":
		c.RemoveHook()
	}
	if err != nil {
		c.Fail(err)
		return 1
	}
	return 0
}

/*
dropRoot: under `sudo`, user-level parts (local service, launcher entries,
restarting Spotify) must belong to the desktop user. Re-run as that user; the
steps that need root ask sudo again (cached, usually without a prompt).
*/
func (c *Ctx) dropRoot(args []string) (int, bool) {
	user := os.Getenv("SUDO_USER")
	if c.OS == "windows" || os.Geteuid() != 0 || user == "" || user == "root" || c.Opts.Command == "apply" {
		return 0, false
	}
	exe, err := self()
	if err != nil {
		return 0, false
	}
	/* The program may sit in root's cache: run a world-readable copy. */
	tmp := filepath.Join(os.TempDir(), fmt.Sprintf("spot-lyric-%d", os.Getpid()))
	if err := copyFile(exe, tmp); err != nil {
		return 0, false
	}
	defer os.Remove(tmp)
	_ = os.Chmod(tmp, 0o755)
	c.Say("检测到 sudo：改以用户 %s 的身份运行，需要时会再次请求管理员权限", user)
	env := []string{"env"}
	if uid := os.Getenv("SUDO_UID"); uid != "" && c.OS == "linux" {
		env = append(env, "XDG_RUNTIME_DIR=/run/user/"+uid, "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"+uid+"/bus")
	}
	for _, k := range []string{"DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "SPOT_LYRIC_PLATFORM"} {
		if v := os.Getenv(k); v != "" {
			env = append(env, k+"="+v)
		}
	}
	cmd := exec.Command("sudo", append(append([]string{"-u", user, "-H"}, env...), append([]string{tmp}, args...)...)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode(), true
		}
		c.Fail(err)
		return 1, true
	}
	return 0, true
}

/* ------------------------------------------------------------ xpui ---- */

func (c *Ctx) appsWritable() bool {
	spa, folder := filepath.Join(c.Apps, "xpui.spa"), filepath.Join(c.Apps, "xpui")
	return writable(c.Apps) && (!isFile(spa) || writable(spa)) && (!isDir(folder) || writable(folder))
}

/* xpui runs patch / restore in this process, or as root when the install directory needs it. */
func (c *Ctx) xpui(command string, b *Bundle) (string, error) {
	if c.OS == "windows" || c.appsWritable() {
		if command == "patch" {
			return PatchApps(c.Apps, c.Version, *b)
		}
		return RestoreApps(c.Apps)
	}
	exe, err := self()
	if err != nil {
		return "", err
	}
	args := []string{"__xpui", command, c.Apps}
	if command == "patch" {
		dir, err := os.MkdirTemp("", "spot-lyric-build-")
		if err != nil {
			return "", err
		}
		defer os.RemoveAll(dir)
		_ = os.Chmod(dir, 0o755)
		js, css := filepath.Join(dir, "spot-lyric.js"), filepath.Join(dir, "spot-lyric.css")
		if err := os.WriteFile(js, b.JS, 0o644); err != nil {
			return "", err
		}
		if err := os.WriteFile(css, b.CSS, 0o644); err != nil {
			return "", err
		}
		args = append(args, js, css, c.Version)
	}
	c.Say("需要管理员权限写入 Spotify 安装目录（sudo）")
	out, err := c.privilegedOutput(exe, args...)
	lines := strings.Split(strings.TrimSpace(out), "\n")
	last := lines[len(lines)-1]
	if err != nil {
		if last == "" {
			last = err.Error()
		}
		return "", errors.New(last)
	}
	return last, nil
}

/* internalXpui is the root side of xpui(): __xpui <patch|restore> <apps> [js css version]. */
func internalXpui(version string, args []string) int {
	if len(args) < 2 {
		return 2
	}
	var (
		result string
		err    error
	)
	switch args[0] {
	case "patch":
		if len(args) < 5 {
			return 2
		}
		var js, css []byte
		if js, err = os.ReadFile(args[2]); err == nil {
			if css, err = os.ReadFile(args[3]); err == nil {
				result, err = PatchApps(args[1], args[4], Bundle{JS: js, CSS: css, Digest: digest(js, css)})
			}
		}
	case "restore":
		result, err = RestoreApps(args[1])
	default:
		return 2
	}
	if err != nil {
		fmt.Println(err.Error())
		return 1
	}
	fmt.Println(result)
	return 0
}

/* ---------------------------------------------------------- commands ---- */

func (c *Ctx) header() {
	if c.Opts.Quiet {
		return
	}
	c.Print("%s\n", c.paint("1", "Spot-Lyric for Spotify v"+c.Version))
	c.Print("系统：%s（%s）\n", c.OSName(), runtime.GOARCH)
}

func (c *Ctx) showSpotify() {
	if c.Opts.Quiet {
		return
	}
	c.Print("Spotify：%s\n", c.SpotifyDir)
	c.Print("版本：%s\n", c.SpotifyVersion())
	c.Print("补丁：%s\n", describePatch(StatusApps(c.Apps)))
}

func describePatch(status string) string {
	switch {
	case strings.Contains(status, "not-patched"):
		return "未注入"
	case strings.Contains(status, "patched v"):
		v := strings.Fields(strings.SplitN(status, "patched v", 2)[1])[0]
		return "已注入 v" + v
	case status == "missing":
		return "找不到 xpui.spa"
	}
	return status
}

/*
currentMode guesses the mode in use when no choice was recorded. Releases before
1.3 had no pure local mode: their --direct only sped up the cloud mode, so a
direct launcher without a recorded choice still means cloud.
*/
func (c *Ctx) currentMode() string {
	if c.Config.Mode != "" {
		return c.Config.Mode
	}
	if c.ServiceInstalled() {
		return ModeLocal
	}
	return ModeCloud
}

func (c *Ctx) currentServer() string {
	if c.Opts.Server != "" {
		return c.Opts.Server
	}
	if c.Config.Server != "" {
		return c.Config.Server
	}
	return DefaultServer
}

type plan struct {
	mode, server string
	hook         bool
}

/* makePlan settles mode, server and hook: options first, otherwise step-by-step questions. */
func (c *Ctx) makePlan() (plan, error) {
	p := plan{mode: c.Opts.Mode, server: c.currentServer()}
	if c.Opts.Server != "" && p.mode == "" {
		p.mode = ModeCloud
	}
	current := c.currentMode()
	if current == ModeDirect && !c.DirectSupported() {
		current = ModeLocal
	}
	asked := false
	if p.mode == "" {
		kind := "cloud"
		if current != ModeCloud {
			kind = "pure"
		}
		kind = c.Choose("[1/3]", "选择使用方式", []Choice{
			{Key: "cloud", Label: "云端服务器", Hint: "歌词服务器保存「使用此歌词」和上传按钮提交的匹配，多台设备共享；\n本机无法直连网易云 / QQ 音乐时由服务器原样转发请求（搜索和匹配仍在本机）"},
			{Key: "pure", Label: "纯本地", Hint: "不连接任何远程服务器：搜索、匹配、歌词下载都在本机进行，绑定的歌词只保存在本机"},
		}, kind)
		if kind == "cloud" {
			p.mode = ModeCloud
		} else {
			def := current
			if def == ModeCloud {
				def = ModeLocal
			}
			direct := Choice{Key: ModeDirect, Label: "直连", Hint: "以 --disable-web-security 启动 Spotify，没有后台进程；会关闭 Spotify 内置浏览器的同源限制"}
			switch c.OS {
			case "macos":
				direct.Disabled = "macOS 不支持（无法给从 Dock / 启动台打开的 Spotify 加启动参数）"
			case "windows":
				direct.Hint += "\n修改 Spotify 快捷方式和开机自启；使用单独的配置目录，首次需要重新登录 Spotify"
			default:
				direct.Hint += "\n修改应用菜单中的 Spotify 启动项（~/.local/share/applications/spotify.desktop）"
			}
			p.mode = c.Choose("[2/3]", "纯本地：网易云 / QQ 音乐的请求怎么发出？（Spotify 内置浏览器会拦截跨域请求）", []Choice{
				{Key: ModeLocal, Label: "本地服务", Hint: fmt.Sprintf("在 %s 运行一个后台小服务（就是本程序，约 10 MB 内存），登录时自动启动；\n不改 Spotify 的启动方式", strings.TrimPrefix(LocalURL, "http://"))},
				direct,
			}, def)
		}
		asked = c.Interactive()
	}
	if p.mode == ModeDirect && !c.DirectSupported() {
		return p, errorf("macOS 不支持直连（无法给从 Dock / 启动台打开的 Spotify 加启动参数），请使用 --mode local")
	}
	if p.mode == ModeCloud && asked && c.Opts.Server == "" {
		c.Print("\n")
		p.server = c.Ask("[2/3] 歌词服务器地址（回车使用默认，也可以填自建服务器）", p.server, func(s string) string {
			return validServer(strings.TrimRight(s, "/"))
		})
		p.server = strings.TrimRight(p.server, "/")
	}
	installed := c.HookInstalled()
	switch c.Opts.Hook {
	case "on":
		p.hook = true
	case "off":
		p.hook = false
	default:
		if why := c.HookSupported(); why != "" {
			p.hook = false
		} else {
			title := "Spotify 自动更新后重新注入插件？"
			if c.OS == "macos" {
				title += "（LaunchAgent，登录时和 Spotify 更新后检查）"
			} else if c.OS == "windows" {
				title += "（每次登录 Windows 时检查）"
			} else {
				title += "（apt 钩子，spotify-client 升级后执行）"
			}
			if c.Interactive() {
				c.Print("\n%s %s\n", c.paint("1;36", "[3/3]"), c.paint("1", title))
			}
			p.hook = c.Confirm("安装自动重新注入", installed || c.Interactive())
		}
	}
	if c.Interactive() {
		c.Print("\n%s\n", c.paint("1", "即将执行："))
		c.Print("  • 注入歌词插件 v%s（使用方式：%s）\n", c.Version, modeNames[p.mode])
		switch p.mode {
		case ModeCloud:
			c.Print("  • 歌词服务器：%s\n", p.server)
		case ModeLocal:
			c.Print("  • 安装本地服务：%s，登录时自动启动\n", LocalURL)
		case ModeDirect:
			c.Print("  • 让 Spotify 以 %s 启动\n", directFlag)
		}
		if p.mode != ModeDirect && c.DirectEnabled() {
			c.Print("  • 取消 Spotify 的直连启动参数（%s）\n", directFlag)
		}
		if p.mode != ModeLocal && c.ServiceInstalled() {
			c.Print("  • 停止并移除本地服务\n")
		}
		if p.hook {
			c.Print("  • 安装自动重新注入\n")
		} else if installed {
			c.Print("  • 移除自动重新注入\n")
		}
		if !c.Confirm("\n继续", true) {
			return p, errCancelled
		}
		c.Print("\n")
	}
	return p, nil
}

/* apply injects the bundle for mode / server. stopped: Spotify was closed to write (Windows). */
func (c *Ctx) apply(mode, server string) (changed, stopped bool, err error) {
	b := BuildBundle(c.Version, mode, server)
	needsWrite := !strings.Contains(StatusApps(c.Apps), "patched v"+c.Version+" "+b.Digest)
	/* Windows locks xpui.spa while Spotify runs. */
	if c.OS == "windows" && needsWrite && c.SpotifyRunning() {
		if c.Opts.Restart == "no" {
			return false, false, errorf("Spotify 正在运行，xpui.spa 被占用：请完全退出 Spotify（含托盘图标）后重试，或去掉 --no-restart")
		}
		c.Say("关闭 Spotify 以写入补丁…")
		c.StopSpotify()
		time.Sleep(500 * time.Millisecond)
		stopped = true
	}
	result, err := c.xpui("patch", &b)
	if err != nil {
		msg := err.Error()
		switch {
		case c.OS == "macos" && strings.Contains(msg, "ermitted"):
			c.Warn("写入被 macOS 拒绝（Operation not permitted）。")
			c.Warn("请到 系统设置 > 隐私与安全性 > App 管理（或 完全磁盘访问权限）中允许当前终端 App，然后重新运行。")
		case c.OS == "windows":
			msg += "\n如果提示文件被占用，请完全退出 Spotify（包括托盘图标）后重试；安装在 Program Files 时请以管理员身份运行"
		}
		if stopped {
			c.StartSpotify()
		}
		return false, false, errorf("注入失败：%s", msg)
	}
	if strings.HasPrefix(result, "UNCHANGED") {
		c.Say("插件已是最新（v%s，%s），无需修改", c.Version, modeNames[mode])
		return false, stopped, nil
	}
	c.Say("已注入歌词插件 v%s（%s）→ %s", c.Version, modeNames[mode], strings.TrimPrefix(result, "PATCHED "))
	c.macResign()
	return true, stopped, nil
}

func (c *Ctx) restart(changed, stopped bool) {
	if c.Opts.Restart == "no" || (c.OS != "windows" && os.Geteuid() == 0) {
		if changed {
			c.Say("下次启动 Spotify 时生效")
		}
		return
	}
	if c.SpotifyRunning() {
		if c.Opts.Restart == "yes" || changed {
			c.Say("重启 Spotify 以加载插件…")
			c.StopSpotify()
			c.StartSpotify()
		}
		return
	}
	if stopped || c.Opts.Restart == "yes" {
		c.Say("启动 Spotify…")
		c.StartSpotify()
	} else if changed {
		c.Say("下次启动 Spotify 时生效")
	}
}

func (c *Ctx) cmdInstall() error {
	c.header()
	if err := c.DetectSpotify(); err != nil {
		return err
	}
	if c.OS == "linux" && strings.HasPrefix(c.SpotifyDir, "/snap/") {
		return errorf("Snap 版 Spotify 是只读文件系统，无法注入。请改用 deb 或 flatpak 版本。")
	}
	c.showSpotify()
	p, err := c.makePlan()
	if err != nil {
		return err
	}
	c.RemoveLegacyProxy()
	changed, stopped, err := c.apply(p.mode, p.server)
	if err != nil {
		return err
	}
	var setupErr error
	switch p.mode {
	case ModeCloud:
		c.RemoveService()
		if c.DirectEnabled() {
			c.DisableDirect()
			changed = true
		}
	case ModeDirect:
		c.RemoveService()
		was := c.DirectEnabled()
		if setupErr = c.EnableDirect(); setupErr == nil && !was {
			changed = true
		}
	case ModeLocal:
		if c.DirectEnabled() {
			c.DisableDirect()
			changed = true
		}
		setupErr = c.InstallService()
	}
	if p.hook {
		if err := c.InstallHook(p.mode, p.server); err != nil {
			c.Warn("自动重新注入安装失败：%v", err)
		}
	} else if c.HookInstalled() {
		c.RemoveHook()
	} else if why := c.HookSupported(); why != "" && c.Opts.Hook == "on" {
		c.Warn("%s", why)
	}
	c.Config = Config{Mode: p.mode}
	if p.server != DefaultServer {
		c.Config.Server = p.server
	}
	c.saveConfig()
	c.restart(changed, stopped)
	if setupErr != nil {
		return setupErr
	}
	switch p.mode {
	case ModeCloud:
		c.Say("完成！在 Spotify 底部播放栏（官方歌词按钮左侧）点击新的歌词图标打开歌词页；旁边的小箭头可把当前歌词上传到服务器。")
	default:
		c.Say("完成！纯本地模式：不连接任何远程服务器。在 Spotify 底部播放栏（官方歌词按钮左侧）点击新的歌词图标打开歌词页。")
	}
	c.Say("以后想更换使用方式，重新运行本程序即可。")
	return nil
}

func (c *Ctx) cmdApply() error {
	if err := c.DetectSpotify(); err != nil {
		return err
	}
	mode := c.Opts.Mode
	if mode == "" {
		mode = c.currentMode()
	}
	changed, stopped, err := c.apply(mode, c.currentServer())
	if err != nil {
		return err
	}
	c.restart(changed, stopped)
	return nil
}

func (c *Ctx) cmdRestore(uninstall bool) error {
	if err := c.DetectSpotify(); err != nil {
		return err
	}
	stopped := false
	if c.OS == "windows" && c.SpotifyRunning() {
		c.StopSpotify()
		time.Sleep(500 * time.Millisecond)
		stopped = true
	}
	result, err := c.xpui("restore", nil)
	if err != nil {
		if stopped {
			c.StartSpotify()
		}
		return errorf("还原失败：%v", err)
	}
	restored := result == "RESTORED"
	if restored {
		c.Say("已还原 Spotify 原始文件")
		c.macResign()
	} else {
		c.Say("Spotify 未被修改，无需还原")
	}
	if uninstall {
		c.RemoveLegacyProxy()
		c.RemoveHook()
		c.DisableDirect()
		c.RemoveService()
		for _, name := range []string{"config.json", "hidden.vbs", "direct", "local.log", filepath.Base(c.binaryPath())} {
			os.Remove(filepath.Join(c.DataDir, name))
		}
		os.Remove(c.DataDir) // only when empty
		c.Say("已卸载 Spot-Lyric")
	}
	c.restart(restored, stopped)
	return nil
}

func (c *Ctx) cmdHook() error {
	if err := c.DetectSpotify(); err != nil {
		return err
	}
	mode := c.Opts.Mode
	if mode == "" {
		mode = c.currentMode()
	}
	return c.InstallHook(mode, c.currentServer())
}

func (c *Ctx) cmdStatus() error {
	c.Opts.Quiet = false
	c.header()
	if err := c.DetectSpotify(); err != nil {
		c.Print("Spotify：未找到（%v）\n", err)
	} else {
		c.showSpotify()
	}
	c.Print("插件版本：v%s\n", c.Version)
	mode := c.currentMode()
	c.Print("使用方式：%s\n", modeNames[mode])
	switch mode {
	case ModeCloud:
		server := c.currentServer()
		if body, err := httpGet(server+"/health", 8*time.Second); err == nil {
			version := regexp.MustCompile(`"version":\s*"([^"]*)"`).FindStringSubmatch(body)
			if version != nil {
				c.Print("歌词服务器：运行正常 v%s · %s\n", version[1], server)
			} else {
				c.Print("歌词服务器：已连接 · %s\n", server)
			}
		} else {
			c.Print("歌词服务器：无法连接 %s（%v）\n", server, err)
		}
	}
	if v, _ := LocalHealth(2 * time.Second); v != "" {
		c.Print("本地服务：运行中 v%s · %s\n", v, LocalURL)
	} else if c.ServiceInstalled() || mode == ModeLocal {
		c.Print("本地服务：未运行（%s）\n", LocalURL)
	}
	if c.DirectSupported() {
		if c.DirectEnabled() {
			c.Print("直连启动参数：已启用（%s）\n", directFlag)
		} else {
			c.Print("直连启动参数：未启用\n")
		}
	}
	if why := c.HookSupported(); why != "" {
		c.Print("自动重新注入：不可用\n")
	} else if c.HookInstalled() {
		c.Print("自动重新注入：已安装\n")
	} else {
		c.Print("自动重新注入：未安装\n")
	}
	return nil
}
