package patcher

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

/*
Re-patching after Spotify updates itself (the update replaces xpui.spa):
  - Linux:   apt DPkg::Post-Invoke hook (deb installs)
  - macOS:   LaunchAgent com.spotlyric.reapply, run at login and when xpui.spa changes
  - Windows: HKCU Run entry SpotLyricReapply, run at every login
Each runs `spot-lyric apply` with the mode and server chosen at install time.
*/

const (
	aptHookDir   = "/usr/local/share/spot-lyric-patch"
	aptHookFile  = "/etc/apt/apt.conf.d/99spot-lyric-patch"
	reapplyLabel = "com.spotlyric.reapply"
	reapplyRun   = "SpotLyricReapply"
)

/* HookSupported explains why hooks are unavailable ("" = supported). */
func (c *Ctx) HookSupported() string {
	if c.OS == "linux" && !isDir("/etc/apt/apt.conf.d") {
		return "未检测到 apt：自动重新注入仅适用于 deb 安装的 Spotify（其它安装方式更新后请重新运行本程序）"
	}
	return ""
}

func (c *Ctx) HookInstalled() bool {
	switch c.OS {
	case "windows":
		v, _ := c.runValue(reapplyRun)
		return v != ""
	case "macos":
		return isFile(c.agentPath(reapplyLabel))
	}
	return isFile(aptHookFile)
}

func (c *Ctx) hookArgs(mode, server string) []string {
	/* The server is baked into every build (the settings can switch to cloud), so it is
	 * passed in every mode: the hook then rebuilds exactly the installed bundle. */
	args := []string{"apply", "--yes", "--quiet", "--mode", mode, "--server", server, "--spotify-path", c.SpotifyDir}
	/* Windows locks xpui.spa while Spotify runs: there apply may close and reopen it. */
	if c.OS != "windows" {
		args = append(args, "--no-restart")
	}
	return args
}

func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func (c *Ctx) InstallHook(mode, server string) error {
	if why := c.HookSupported(); why != "" {
		return errorf("%s", why)
	}
	args := c.hookArgs(mode, server)
	switch c.OS {
	case "windows":
		exe, err := c.installSelf()
		if err != nil {
			return err
		}
		if _, err := c.writeHiddenLauncher(); err != nil {
			return err
		}
		if err := c.setRunValue(reapplyRun, c.hiddenCommand(exe, args...)); err != nil {
			return errorf("无法写入登录自启项：%v", err)
		}
		os.RemoveAll(filepath.Join(c.DataDir, "patcher")) // copy used by the old PowerShell hook
		c.Say("已安装登录钩子：每次登录 Windows 时检查并重新注入（Spotify 自动更新后生效）")
	case "macos":
		exe, err := c.installSelf()
		if err != nil {
			return err
		}
		var program strings.Builder
		for _, a := range append([]string{exe}, args...) {
			program.WriteString("<string>" + xmlEscape(a) + "</string>")
		}
		logFile := filepath.Join(c.Home, "Library", "Logs", "spot-lyric-reapply.log")
		plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array>%s</array>
  <key>RunAtLoad</key><true/>
  <key>WatchPaths</key><array><string>%s</string></array>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>%s</string>
  <key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, reapplyLabel, program.String(), xmlEscape(filepath.Join(c.Apps, "xpui.spa")), xmlEscape(logFile), xmlEscape(logFile))
		if err := c.loadAgent(reapplyLabel, plist); err != nil {
			return err
		}
		os.RemoveAll(filepath.Join(c.DataDir, "patcher")) // copy used by the old shell hook
		c.Say("已安装 LaunchAgent：登录时和 Spotify 更新 xpui.spa 后自动重新注入（日志 ~/Library/Logs/spot-lyric-reapply.log）")
		c.Say("提示：如日志出现 Operation not permitted，请在 系统设置 > 隐私与安全性 > App 管理 中允许 spot-lyric")
	default:
		exe, err := self()
		if err != nil {
			return err
		}
		bin := aptHookDir + "/spot-lyric"
		if err := c.privileged("rm", "-rf", aptHookDir); err != nil {
			return err
		}
		if err := c.privileged("install", "-D", "-m", "755", exe, bin); err != nil {
			return errorf("无法复制程序到 %s", bin)
		}
		quoted := make([]string, len(args))
		for i, a := range args {
			quoted[i] = shQuote(a)
		}
		command := fmt.Sprintf("if [ -x %s ] && [ -d %s ]; then %s %s || true; fi", bin, shQuote(c.Apps), bin, strings.Join(quoted, " "))
		/* apt.conf strings cannot contain double quotes. */
		hook := fmt.Sprintf("DPkg::Post-Invoke { \"%s\"; };\n", strings.ReplaceAll(command, `"`, `'`))
		if err := c.writeRootFile(aptHookFile, []byte(hook), 0o644); err != nil {
			return errorf("无法写入 %s", aptHookFile)
		}
		c.Say("已安装 apt 钩子：%s（spotify-client 升级后自动重新注入）", aptHookFile)
	}
	return nil
}

func (c *Ctx) RemoveHook() {
	switch c.OS {
	case "windows":
		if v, _ := c.runValue(reapplyRun); v != "" {
			_ = c.setRunValue(reapplyRun, "")
			c.Say("已移除登录钩子")
		}
		os.RemoveAll(filepath.Join(c.DataDir, "patcher"))
	case "macos":
		if isFile(c.agentPath(reapplyLabel)) {
			c.unloadAgent(reapplyLabel)
			c.Say("已移除 LaunchAgent 钩子")
		}
		os.RemoveAll(filepath.Join(c.DataDir, "patcher"))
	default:
		if isFile(aptHookFile) || isDir(aptHookDir) {
			if c.privileged("rm", "-rf", aptHookFile, aptHookDir) == nil {
				c.Say("已移除 apt 钩子")
			}
		}
	}
}

/* --------------------------------------------------------- legacy proxy ---- */

/*
Versions before 1.1 ran a local proxy on 127.0.0.1:38917 (spot-lyric-proxy).
It is removed so the port is free for the local service.
*/
func (c *Ctx) RemoveLegacyProxy() {
	found := false
	switch c.OS {
	case "windows":
		exe := filepath.Join(c.DataDir, "spot-lyric-proxy.exe")
		v, _ := c.runValue("SpotLyricProxy")
		if v == "" && !isFile(exe) {
			return
		}
		found = true
		_, _ = run("taskkill", "/F", "/IM", "spot-lyric-proxy.exe")
		_ = c.setRunValue("SpotLyricProxy", "")
		os.Remove(exe)
	case "macos":
		plist, bin := c.agentPath("com.spotlyric.proxy"), filepath.Join(c.DataDir, "spot-lyric-proxy")
		if isFile(plist) || isFile(bin) {
			found = true
			c.unloadAgent("com.spotlyric.proxy")
			os.Remove(bin)
		}
	default:
		dir := filepath.Join(c.Home, ".local", "share", "spot-lyric-patch")
		units := filepath.Join(c.configHome(), "systemd", "user")
		autostart := filepath.Join(c.configHome(), "autostart", "spot-lyric-proxy.desktop")
		if isFile(filepath.Join(units, "spot-lyric-proxy.service")) || isFile(filepath.Join(units, "spot-lyric-proxy.socket")) || isDir(dir) || isFile(autostart) {
			found = true
			if haveUserSystemd() {
				_, _ = run("systemctl", "--user", "disable", "--now", "spot-lyric-proxy.socket")
				_, _ = run("systemctl", "--user", "disable", "--now", "spot-lyric-proxy.service")
			}
			os.Remove(filepath.Join(units, "spot-lyric-proxy.socket"))
			os.Remove(filepath.Join(units, "spot-lyric-proxy.service"))
			os.Remove(autostart)
			os.RemoveAll(dir)
			if haveUserSystemd() {
				_, _ = run("systemctl", "--user", "daemon-reload")
			}
		}
		_, _ = run("pkill", "-u", fmt.Sprint(os.Getuid()), "-f", "^[^ ]*(python3?|env python3) [^ ]*"+dir+"/spot-lyric-proxy\\.py")
		_, _ = run("pkill", "-u", fmt.Sprint(os.Getuid()), "-f", "^"+dir+"/spot-lyric-proxy( |$)")
	}
	if found {
		c.Say("已移除旧版本地歌词代理（spot-lyric-proxy）")
	}
}
