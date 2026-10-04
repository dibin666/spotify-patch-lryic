package patcher

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

/*
Direct mode. Spotify's renderer enforces CORS and NetEase / QQ send no CORS
headers, so the plugin reaches them itself only when Spotify runs with
--disable-web-security (CEF honours the switch). Newer Chromium refuses it unless
--user-data-dir also names a non-default directory:
  - Linux: a symlink to Spotify's real profile directory (same data, other path);
    a per-user spotify.desktop adds both switches to the menu launcher.
  - Windows: %LOCALAPPDATA%\Spotify\DirectProfile; the Spotify shortcuts and
    Spotify's own autostart entry get the switches.
  - macOS: launches from the Dock / Launchpad cannot carry switches: not supported.
*/

const directFlag = "--disable-web-security"

/* desktopSources lists the system launcher entries a per-user override is based on. */
var desktopSources = func(c *Ctx) []string {
	return []string{"/usr/share/applications/spotify.desktop", "/usr/local/share/applications/spotify.desktop",
		filepath.Join(c.SpotifyDir, "spotify.desktop"), "/var/lib/flatpak/exports/share/applications/com.spotify.Client.desktop"}
}

func (c *Ctx) configHome() string {
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return d
	}
	return filepath.Join(c.Home, ".config")
}

func (c *Ctx) directProfile() string {
	if c.OS == "windows" {
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = os.TempDir()
		}
		return filepath.Join(base, "Spotify", "DirectProfile")
	}
	return filepath.Join(c.configHome(), "spotify-direct")
}

func (c *Ctx) directArgs() []string {
	return []string{directFlag, "--user-data-dir=" + c.directProfile()}
}

func (c *Ctx) desktopOverride() string {
	return filepath.Join(c.Home, ".local", "share", "applications", "spotify.desktop")
}

func (c *Ctx) directMarker() string { return filepath.Join(c.DataDir, "direct") }

/* DirectSupported reports whether this system can start Spotify with the switches. */
func (c *Ctx) DirectSupported() bool { return c.OS != "macos" }

func (c *Ctx) DirectEnabled() bool {
	switch c.OS {
	case "windows":
		return isFile(c.directMarker())
	case "linux":
		data, err := os.ReadFile(c.desktopOverride())
		return err == nil && strings.Contains(string(data), "\nX-Spot-Lyric=direct") && strings.Contains(string(data), "--user-data-dir=")
	}
	return false
}

func (c *Ctx) EnableDirect() error {
	switch c.OS {
	case "macos":
		return errorf("macOS 无法给从 Dock / 启动台打开的 Spotify 固定启动参数，不支持直连；请改用「纯本地 · 本地服务」")
	case "windows":
		return c.windowsDirect(true)
	}
	return c.linuxDirect()
}

func (c *Ctx) DisableDirect() {
	switch c.OS {
	case "windows":
		if c.DirectEnabled() {
			if err := c.windowsDirect(false); err != nil {
				c.Warn("取消直连失败：%v", err)
			}
		}
	case "linux":
		path := c.desktopOverride()
		if data, err := os.ReadFile(path); err == nil && strings.Contains(string(data), "\nX-Spot-Lyric=direct") {
			os.Remove(path)
			if info, err := os.Lstat(c.directProfile()); err == nil && info.Mode()&os.ModeSymlink != 0 {
				os.Remove(c.directProfile())
			}
			c.Say("已取消直连启动参数")
		}
	}
}

func desktopQuote(s string) string {
	if strings.ContainsAny(s, " \t\"'\\$`") {
		return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "`", "\\`", "$", `\$`).Replace(s) + `"`
	}
	return s
}

func (c *Ctx) linuxDirect() error {
	profile, direct := filepath.Join(c.configHome(), "spotify"), c.directProfile()
	if err := os.MkdirAll(profile, 0o700); err != nil {
		return err
	}
	if info, err := os.Lstat(direct); err == nil && info.Mode()&os.ModeSymlink == 0 {
		return errorf("%s 已存在且不是符号链接，请先移走它", direct)
	}
	os.Remove(direct)
	if err := os.Symlink(profile, direct); err != nil {
		return errorf("无法创建 %s：%v", direct, err)
	}
	args := directFlag + " " + desktopQuote("--user-data-dir="+direct)
	var source string
	for _, f := range desktopSources(c) {
		if data, err := os.ReadFile(f); err == nil {
			source = string(data)
			break
		}
	}
	var out strings.Builder
	if source != "" {
		stale := regexp.MustCompile(` (?:` + regexp.QuoteMeta(directFlag) + `|"?--user-data-dir=[^ ]*spotify-direct"?)`)
		for _, line := range strings.Split(strings.TrimRight(source, "\n"), "\n") {
			if strings.HasPrefix(line, "X-Spot-Lyric=") {
				continue
			}
			line = stale.ReplaceAllString(line, "")
			if strings.HasPrefix(line, "Exec=") {
				/* The switches go right after the program, before %U and other arguments. */
				rest := strings.TrimPrefix(line, "Exec=")
				program, tail, _ := strings.Cut(rest, " ")
				line = "Exec=" + program + " " + args
				if tail != "" {
					line += " " + tail
				}
			}
			out.WriteString(line + "\n")
		}
	} else {
		out.WriteString("[Desktop Entry]\nType=Application\nName=Spotify\nIcon=spotify-client\nExec=spotify " + args + " %U\nTerminal=false\n" +
			"MimeType=x-scheme-handler/spotify;\nCategories=Audio;Music;Player;AudioVideo;\nStartupWMClass=spotify\n")
	}
	out.WriteString("X-Spot-Lyric=direct\n")
	path := c.desktopOverride()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(out.String()), 0o644); err != nil {
		return err
	}
	c.Say("已启用直连：应用菜单中的 Spotify 将以 %s --user-data-dir=%s 启动（%s）", directFlag, direct, path)
	c.Say("其它启动方式（自建快捷方式、AppImage、开机自启）请自行加上这两个参数")
	return nil
}

const windowsDirectScript = `
$flag = '(?:' + [regex]::Escape('--disable-web-security') + '|--user-data-dir="[^"]*DirectProfile")'
$enable = $env:SL_ENABLE -eq '1'
$shell = New-Object -ComObject WScript.Shell
$paths = @()
if ($env:APPDATA) { $paths += (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Spotify.lnk') }
try { $paths += (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Spotify.lnk') } catch { }
foreach ($path in $paths) {
  if (-not (Test-Path -LiteralPath $path)) { continue }
  try {
    $link = $shell.CreateShortcut($path)
    $arguments = (($link.Arguments -replace $flag, '') -replace '\s+', ' ').Trim()
    if ($enable) { $arguments = ($arguments + ' ' + $env:SL_ARGS).Trim() }
    $link.Arguments = $arguments
    $link.Save()
    Write-Output "LINK $path"
  } catch { Write-Output "WARN $path $($_.Exception.Message)" }
}
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$autostart = (Get-ItemProperty -Path $key -Name 'Spotify' -ErrorAction SilentlyContinue).Spotify
if ($autostart) {
  $value = ($autostart -replace (' ?' + $flag), '').TrimEnd()
  if ($enable) { $value = "$value $env:SL_ARGS" }
  Set-ItemProperty -Path $key -Name 'Spotify' -Value $value
  Write-Output 'AUTOSTART'
}
`

func (c *Ctx) windowsDirect(enable bool) error {
	flag := "0"
	if enable {
		flag = "1"
	}
	out, err := powershell(windowsDirectScript, "SL_ENABLE="+flag, "SL_ARGS="+directFlag+` --user-data-dir="`+c.directProfile()+`"`)
	if err != nil {
		return err
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "WARN ") {
			c.Warn("无法修改快捷方式 %s", strings.TrimPrefix(line, "WARN "))
		}
	}
	if enable {
		if err := os.MkdirAll(c.DataDir, 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(c.directMarker(), []byte(directFlag+"\n"), 0o644); err != nil {
			return err
		}
		c.Say("已启用直连：Spotify 快捷方式和开机自启将以 %s --user-data-dir=\"%s\" 启动", directFlag, c.directProfile())
		c.Warn("直连使用单独的配置目录，首次启动可能需要重新登录 Spotify；Spotify 更新重建快捷方式后请重新运行本程序")
	} else {
		os.Remove(c.directMarker())
		c.Say("已取消直连启动参数")
	}
	return nil
}
