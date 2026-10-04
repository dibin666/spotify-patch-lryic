package patcher

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

/* linuxSpotifyPids lists this user's Spotify processes (/proc, no procps needed). */
func linuxSpotifyPids() []int {
	entries, _ := os.ReadDir("/proc")
	uid := os.Getuid()
	var pids []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		comm, err := os.ReadFile(filepath.Join("/proc", e.Name(), "comm"))
		if err != nil || strings.TrimSpace(string(comm)) != "spotify" {
			continue
		}
		if info, err := os.Stat(filepath.Join("/proc", e.Name())); err == nil && fileOwner(info) != uid {
			continue
		}
		pids = append(pids, pid)
	}
	return pids
}

func (c *Ctx) SpotifyRunning() bool {
	switch c.OS {
	case "windows":
		out, _ := run("tasklist", "/FI", "IMAGENAME eq Spotify.exe", "/NH")
		return strings.Contains(strings.ToLower(out), "spotify.exe")
	case "macos":
		return exec.Command("pgrep", "-x", "-u", strconv.Itoa(os.Getuid()), "Spotify").Run() == nil
	}
	return len(linuxSpotifyPids()) > 0
}

func (c *Ctx) StopSpotify() {
	switch c.OS {
	case "windows":
		_, _ = run("taskkill", "/F", "/T", "/IM", "Spotify.exe")
	case "macos":
		_ = exec.Command("pkill", "-x", "-u", strconv.Itoa(os.Getuid()), "Spotify").Run()
	default:
		for _, pid := range linuxSpotifyPids() {
			if p, err := os.FindProcess(pid); err == nil {
				_ = p.Signal(syscall.SIGTERM)
			}
		}
	}
	for i := 0; i < 40; i++ {
		if !c.SpotifyRunning() {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	if c.OS == "linux" {
		for _, pid := range linuxSpotifyPids() {
			if p, err := os.FindProcess(pid); err == nil {
				_ = p.Kill()
			}
		}
	}
}

func (c *Ctx) StartSpotify() {
	var cmd *exec.Cmd
	switch c.OS {
	case "macos":
		cmd = exec.Command("open", "-a", c.SpotifyDir)
	case "windows":
		args := []string{}
		if c.DirectEnabled() {
			args = c.directArgs()
		}
		cmd = exec.Command(filepath.Join(c.SpotifyDir, "Spotify.exe"), args...)
		detach(cmd)
	default:
		launcher, err := exec.LookPath("spotify")
		if err != nil {
			launcher = filepath.Join(c.SpotifyDir, "spotify")
		}
		args := []string{}
		if c.DirectEnabled() {
			args = c.directArgs()
		}
		cmd = exec.Command(launcher, args...)
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			cmd.Env = append(os.Environ(), "DISPLAY=:0")
		}
		detach(cmd)
	}
	if err := cmd.Start(); err != nil {
		c.Warn("请手动启动 Spotify（%v）", err)
		return
	}
	go cmd.Wait()
	/* Let a detached GUI launch get going before this program exits. */
	time.Sleep(300 * time.Millisecond)
}

/* Rewriting Contents/Resources breaks the signature; Ventura and later refuse to
 * start such an app. Re-sign ad hoc like SpotX. */
func (c *Ctx) macResign() {
	if c.OS != "macos" {
		return
	}
	if _, err := exec.LookPath("codesign"); err != nil {
		c.Warn("未找到 codesign，跳过重新签名（如 Spotify 无法启动，请安装 Xcode Command Line Tools：xcode-select --install）")
		return
	}
	sign := func(name string, args ...string) error {
		if writable(c.SpotifyDir) {
			_, err := run(name, args...)
			return err
		}
		_, err := c.privilegedOutput(name, args...)
		return err
	}
	_ = sign("xattr", "-cr", c.SpotifyDir)
	if sign("codesign", "-f", "--deep", "-s", "-", c.SpotifyDir) == nil &&
		exec.Command("codesign", "--verify", "--deep", "--strict", c.SpotifyDir).Run() == nil {
		c.Say("已重新签名 Spotify.app（ad-hoc）")
		return
	}
	c.Warn("重新签名失败。若 Spotify 打不开，请运行：codesign -f --deep -s - \"%s\"", c.SpotifyDir)
}
