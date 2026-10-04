package patcher

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

func (c *Ctx) appsOf(dir string) string {
	if c.OS == "macos" {
		return filepath.Join(dir, "Contents", "Resources", "Apps")
	}
	return filepath.Join(dir, "Apps")
}

func isFile(path string) bool { info, err := os.Stat(path); return err == nil && !info.IsDir() }
func isDir(path string) bool  { info, err := os.Stat(path); return err == nil && info.IsDir() }

func (c *Ctx) validInstall(dir string) bool {
	if dir == "" {
		return false
	}
	apps := c.appsOf(dir)
	return isFile(filepath.Join(apps, "xpui.spa")) || isFile(filepath.Join(apps, "xpui", "index.html"))
}

func (c *Ctx) setSpotify(dir string) {
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		dir = resolved
	}
	c.SpotifyDir, c.Apps = dir, c.appsOf(dir)
}

/* DetectSpotify finds the Spotify installation (or uses --spotify-path). */
func (c *Ctx) DetectSpotify() error {
	if c.SpotifyDir != "" {
		return nil
	}
	if p := c.Opts.SpotifyPath; p != "" {
		dir := strings.TrimRight(p, `/\`)
		if c.OS == "macos" {
			dir = strings.TrimSuffix(strings.TrimSuffix(dir, "/Contents/Resources"), "/Contents")
		}
		if abs, err := filepath.Abs(dir); err == nil {
			dir = abs
		}
		if !c.validInstall(dir) {
			return errorf("指定位置不是 Spotify：%s", p)
		}
		c.setSpotify(dir)
		return nil
	}
	for _, dir := range c.candidates() {
		if c.validInstall(dir) {
			c.setSpotify(dir)
			return nil
		}
	}
	if c.OS == "windows" {
		if matches, _ := filepath.Glob(filepath.Join(os.Getenv("LOCALAPPDATA"), "Packages", "SpotifyAB.SpotifyMusic_*")); len(matches) > 0 {
			return errorf("检测到 Microsoft Store 版 Spotify：它安装在只读的 WindowsApps 目录，无法注入。\n" +
				"请在「设置 > 应用」中卸载它，然后从 https://www.spotify.com/download 安装普通版本后重试。")
		}
		return errorf("没有找到 Spotify，请从 https://www.spotify.com/download 安装，或用 --spotify-path 指定目录")
	}
	if c.OS == "macos" {
		return errorf("没有找到 Spotify.app，请用 --spotify-path 指定（例如 /Applications/Spotify.app）")
	}
	return errorf("没有找到 Spotify，请用 --spotify-path 指定（含 Apps/xpui.spa 的目录）")
}

func (c *Ctx) candidates() []string {
	switch c.OS {
	case "windows":
		var out []string
		for _, env := range []string{"APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"} {
			if v := os.Getenv(env); v != "" {
				out = append(out, filepath.Join(v, "Spotify"))
			}
		}
		return out
	case "macos":
		return []string{filepath.Join(c.Home, "Applications", "Spotify.app"), "/Applications/Spotify.app"}
	}
	var out []string
	if bin, err := exec.LookPath("spotify"); err == nil {
		if real, err := filepath.EvalSymlinks(bin); err == nil {
			out = append(out, filepath.Dir(real))
		}
	}
	if data, err := exec.Command("dpkg", "-L", "spotify-client").Output(); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasSuffix(line, "/Apps/xpui.spa") {
				out = append(out, strings.TrimSuffix(line, "/Apps/xpui.spa"))
				break
			}
		}
	}
	return append(out, "/usr/share/spotify", "/opt/spotify", "/usr/lib/spotify", "/usr/local/share/spotify", "/usr/lib64/spotify-client",
		filepath.Join(c.Home, ".local/share/spotify"),
		filepath.Join(c.Home, ".local/share/flatpak/app/com.spotify.Client/current/active/files/extra/share/spotify"),
		"/var/lib/flatpak/app/com.spotify.Client/current/active/files/extra/share/spotify",
		"/snap/spotify/current/usr/share/spotify")
}

var linuxVersionRe = regexp.MustCompile(`\b[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.g[0-9a-f]+`)

/* SpotifyVersion reads the installed client version ("unknown" when it cannot). */
func (c *Ctx) SpotifyVersion() string {
	switch c.OS {
	case "windows":
		exe := filepath.Join(c.SpotifyDir, "Spotify.exe")
		if isFile(exe) {
			if out, err := powershell(`(Get-Item -LiteralPath $env:SL_EXE).VersionInfo.FileVersion`, "SL_EXE="+exe); err == nil && out != "" {
				return out
			}
		}
	case "macos":
		plist := filepath.Join(c.SpotifyDir, "Contents", "Info.plist")
		if out, err := exec.Command("plutil", "-extract", "CFBundleShortVersionString", "raw", plist).Output(); err == nil {
			if v := strings.TrimSpace(string(out)); v != "" {
				return v
			}
		}
		if data, err := os.ReadFile(plist); err == nil {
			if m := regexp.MustCompile(`<key>CFBundleShortVersionString</key>\s*<string>([^<]+)</string>`).FindSubmatch(data); m != nil {
				return string(m[1])
			}
		}
	default:
		/* The deb package version, when this installation is the one dpkg owns. */
		if exec.Command("dpkg", "-S", filepath.Join(c.Apps, "xpui.spa")).Run() == nil {
			if out, err := exec.Command("dpkg-query", "-W", "-f=${Version}", "spotify-client").Output(); err == nil && len(out) > 0 {
				return strings.TrimSpace(string(out))
			}
		}
		/* Other packages: the version string is embedded in the binary. */
		if f, err := os.Open(filepath.Join(c.SpotifyDir, "spotify")); err == nil {
			defer f.Close()
			reader := bufio.NewReaderSize(f, 1<<20)
			var carry []byte
			buf := make([]byte, 1<<20)
			for read := 0; read < 400<<20; {
				n, err := reader.Read(buf)
				read += n
				chunk := append(carry, buf[:n]...)
				if m := linuxVersionRe.Find(chunk); m != nil {
					return string(m)
				}
				if len(chunk) > 64 {
					carry = bytes.Clone(chunk[len(chunk)-64:])
				}
				if err != nil {
					break
				}
			}
		}
	}
	return "unknown"
}
