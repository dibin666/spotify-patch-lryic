package patcher

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

/*
The local service: this same program (`spot-lyric serve --local`) listening on
127.0.0.1:38917 and relaying NetEase / QQ requests for the plugin. It is
started at login by the user's service manager:
  - Linux:   systemd user unit spot-lyric-local.service (XDG autostart without systemd)
  - macOS:   LaunchAgent com.spotlyric.local
  - Windows: HKCU Run entry SpotLyricLocal (started hidden through wscript)
*/

const (
	serviceUnit  = "spot-lyric-local.service"
	serviceLabel = "com.spotlyric.local"
	serviceRun   = "SpotLyricLocal"
	runKey       = `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run`
)

/* LocalHealth reports the version of the service answering on 127.0.0.1:38917. */
func LocalHealth(timeout time.Duration) (string, bool) {
	body, err := httpGet(LocalURL+"/health", timeout)
	if err != nil {
		return "", false
	}
	var health struct {
		OK      bool   `json:"ok"`
		Version string `json:"version"`
		Relay   bool   `json:"relay"`
	}
	if json.Unmarshal([]byte(body), &health) != nil || !health.OK {
		return "", false
	}
	return health.Version, health.Relay
}

func (c *Ctx) unitPath() string {
	return filepath.Join(c.configHome(), "systemd", "user", serviceUnit)
}
func (c *Ctx) autostartPath() string {
	return filepath.Join(c.configHome(), "autostart", "spot-lyric-local.desktop")
}
func (c *Ctx) agentPath(label string) string {
	return filepath.Join(c.Home, "Library", "LaunchAgents", label+".plist")
}
func (c *Ctx) hiddenLauncher() string { return filepath.Join(c.DataDir, "hidden.vbs") }

func haveUserSystemd() bool {
	return exec.Command("systemctl", "--user", "show-environment").Run() == nil
}

/* ServiceInstalled reports whether the local service is registered to start at login. */
func (c *Ctx) ServiceInstalled() bool {
	switch c.OS {
	case "windows":
		v, _ := c.runValue(serviceRun)
		return v != ""
	case "macos":
		return isFile(c.agentPath(serviceLabel))
	}
	return isFile(c.unitPath()) || isFile(c.autostartPath())
}

/* ----------------------------------------------------------- Windows ---- */

/* Runs its arguments as one command without a console window (Run entries would flash one). */
const hiddenVBS = `' Spot-Lyric: runs a program without a console window.
Dim i, a, cmd
For i = 0 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  If InStr(a, " ") > 0 Then a = """" & a & """"
  cmd = cmd & a & " "
Next
CreateObject("WScript.Shell").Run cmd, 0, False
`

func (c *Ctx) writeHiddenLauncher() (string, error) {
	path := c.hiddenLauncher()
	if err := os.MkdirAll(c.DataDir, 0o755); err != nil {
		return "", err
	}
	return path, os.WriteFile(path, []byte(strings.ReplaceAll(hiddenVBS, "\n", "\r\n")), 0o644)
}

/* hiddenCommand is the Run-entry command line starting exe with args, hidden. */
func (c *Ctx) hiddenCommand(exe string, args ...string) string {
	parts := []string{`wscript.exe //B //Nologo "` + c.hiddenLauncher() + `"`, `"` + exe + `"`}
	for _, a := range args {
		if strings.ContainsAny(a, " \t") {
			a = `"` + a + `"`
		}
		parts = append(parts, a)
	}
	return strings.Join(parts, " ")
}

func (c *Ctx) runValue(name string) (string, error) {
	return powershell(`(Get-ItemProperty -Path `+psQuote(runKey)+` -Name $env:SL_NAME -ErrorAction SilentlyContinue).$env:SL_NAME`, "SL_NAME="+name)
}

func (c *Ctx) setRunValue(name, value string) error {
	if value == "" {
		_, err := powershell(`Remove-ItemProperty -Path `+psQuote(runKey)+` -Name $env:SL_NAME -ErrorAction SilentlyContinue`, "SL_NAME="+name)
		return err
	}
	_, err := powershell(`$null = New-ItemProperty -Path `+psQuote(runKey)+` -Name $env:SL_NAME -Value $env:SL_VALUE -PropertyType String -Force`,
		"SL_NAME="+name, "SL_VALUE="+value)
	return err
}

/* stopWindowsService ends `spot-lyric.exe serve` processes started from the data directory. */
func (c *Ctx) stopWindowsService() {
	_, _ = powershell(`Get-CimInstance Win32_Process -Filter "Name='spot-lyric.exe'" | `+
		`Where-Object { $_.CommandLine -like '* serve*' -and $_.ExecutablePath -like ($env:SL_DIR + '*') } | `+
		`ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`, "SL_DIR="+c.DataDir)
}

/* -------------------------------------------------------------- all ---- */

/* InstallService copies this program into the data directory, registers the local service and (re)starts it. */
func (c *Ctx) InstallService() error {
	if c.OS == "windows" {
		c.stopWindowsService()
	}
	exe, err := c.installSelf()
	if err != nil {
		return err
	}
	logFile := filepath.Join(c.DataDir, "local.log")
	switch c.OS {
	case "windows":
		if _, err := c.writeHiddenLauncher(); err != nil {
			return err
		}
		command := c.hiddenCommand(exe, "serve", "--local")
		if err := c.setRunValue(serviceRun, command); err != nil {
			return errorf("无法写入登录自启项：%v", err)
		}
		cmd := exec.Command("wscript.exe", "//B", "//Nologo", c.hiddenLauncher(), exe, "serve", "--local")
		hideWindow(cmd)
		if err := cmd.Run(); err != nil {
			return errorf("无法启动本地服务：%v", err)
		}
		c.Say("已注册登录自启：%s", serviceRun)
	case "macos":
		plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array><string>%s</string><string>serve</string><string>--local</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>%s</string>
  <key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, serviceLabel, xmlEscape(exe), xmlEscape(logFile), xmlEscape(logFile))
		if err := c.loadAgent(serviceLabel, plist); err != nil {
			return err
		}
		c.Say("已安装 LaunchAgent：%s（登录时自动启动）", c.agentPath(serviceLabel))
	default:
		if haveUserSystemd() {
			unit := fmt.Sprintf("[Unit]\nDescription=Spot-Lyric local lyrics service (%s)\nAfter=network-online.target\n\n"+
				"[Service]\nExecStart=%s serve --local\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n",
				LocalURL, systemdQuote(exe))
			if err := os.MkdirAll(filepath.Dir(c.unitPath()), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(c.unitPath(), []byte(unit), 0o644); err != nil {
				return err
			}
			os.Remove(c.autostartPath())
			_, _ = run("systemctl", "--user", "daemon-reload")
			if out, err := run("systemctl", "--user", "enable", serviceUnit); err != nil {
				return errorf("无法启用 %s：%s", serviceUnit, out)
			}
			if out, err := run("systemctl", "--user", "restart", serviceUnit); err != nil {
				return errorf("无法启动 %s：%s", serviceUnit, out)
			}
			c.Say("已安装 systemd 用户服务：%s（登录时自动启动）", serviceUnit)
		} else {
			entry := fmt.Sprintf("[Desktop Entry]\nType=Application\nName=Spot-Lyric local service\nExec=%s serve --local\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n", desktopQuote(exe))
			if err := os.MkdirAll(filepath.Dir(c.autostartPath()), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(c.autostartPath(), []byte(entry), 0o644); err != nil {
				return err
			}
			c.stopUnixService(exe)
			cmd := exec.Command(exe, "serve", "--local")
			if f, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
				cmd.Stdout, cmd.Stderr = f, f
				defer f.Close()
			}
			detach(cmd)
			if err := cmd.Start(); err != nil {
				return errorf("无法启动本地服务：%v", err)
			}
			go cmd.Wait()
			c.Say("已添加登录自启：%s（未检测到 systemd 用户实例）", c.autostartPath())
		}
	}
	for i := 0; i < 50; i++ {
		if v, relay := LocalHealth(time.Second); v != "" && relay {
			c.Say("本地服务运行中：%s（v%s）", LocalURL, v)
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return errorf("本地服务没有在 %s 上响应（端口 %d 可能被其它程序占用），日志：%s", LocalURL, 38917, logFile)
}

/* RemoveService stops and unregisters the local service. */
func (c *Ctx) RemoveService() {
	if !c.ServiceInstalled() {
		return
	}
	switch c.OS {
	case "windows":
		_ = c.setRunValue(serviceRun, "")
		c.stopWindowsService()
	case "macos":
		c.unloadAgent(serviceLabel)
	default:
		if isFile(c.unitPath()) {
			_, _ = run("systemctl", "--user", "disable", "--now", serviceUnit)
			os.Remove(c.unitPath())
			_, _ = run("systemctl", "--user", "daemon-reload")
		}
		if isFile(c.autostartPath()) {
			os.Remove(c.autostartPath())
			c.stopUnixService(c.binaryPath())
		}
	}
	c.Say("已停止并移除本地服务")
}

/* stopUnixService ends a service started without systemd (matched by its executable). */
func (c *Ctx) stopUnixService(exe string) {
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		cmdline, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
		if err != nil {
			continue
		}
		args := strings.Split(string(cmdline), "\x00")
		if len(args) >= 2 && args[0] == exe && args[1] == "serve" {
			if p, err := os.FindProcess(pid); err == nil {
				_ = p.Kill()
			}
		}
	}
}

/* ---------------------------------------------------------- launchd ---- */

func (c *Ctx) loadAgent(label, plist string) error {
	path := c.agentPath(label)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(c.Home, "Library", "Logs"), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(plist), 0o644); err != nil {
		return err
	}
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	_, _ = run("launchctl", "bootout", domain+"/"+label)
	if _, err := run("launchctl", "bootstrap", domain, path); err != nil {
		if out, err := run("launchctl", "load", "-w", path); err != nil {
			return errorf("无法加载 LaunchAgent %s：%s", label, out)
		}
	}
	return nil
}

func (c *Ctx) unloadAgent(label string) {
	path := c.agentPath(label)
	if _, err := run("launchctl", "bootout", fmt.Sprintf("gui/%d/%s", os.Getuid(), label)); err != nil {
		_, _ = run("launchctl", "unload", "-w", path)
	}
	os.Remove(path)
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

func systemdQuote(s string) string {
	if strings.ContainsAny(s, " \t\"'\\") {
		return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
	}
	return s
}
