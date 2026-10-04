package patcher

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

/* run executes a command and returns its trimmed combined output. */
func run(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

/*
powershell runs a script with Windows PowerShell. Values are passed as
environment variables ("NAME=value") and read as $env:NAME, so paths and
arguments never need quoting inside the script.
*/
func powershell(script string, env ...string) (string, error) {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
		"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; "+script)
	cmd.Env = append(os.Environ(), env...)
	hideWindow(cmd)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	text := strings.TrimSpace(out.String())
	if err != nil && text != "" {
		err = fmt.Errorf("%s", text)
	}
	return text, err
}

/* psQuote quotes a value for a single-quoted PowerShell string. */
func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

/* privileged runs a command as root (sudo when needed) with the terminal attached. */
func (c *Ctx) privileged(name string, args ...string) error {
	var cmd *exec.Cmd
	if os.Geteuid() == 0 {
		cmd = exec.Command(name, args...)
	} else {
		if _, err := exec.LookPath("sudo"); err != nil {
			return errorf("需要管理员权限，但没有找到 sudo：请以 root 身份运行")
		}
		cmd = exec.Command("sudo", append([]string{name}, args...)...)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if tty := openTTY(); tty != nil && !isTerminal(os.Stdin) {
		defer tty.Close()
		cmd.Stdin = tty
	}
	return cmd.Run()
}

/* privilegedOutput is privileged() capturing stdout (the password prompt still reaches the terminal). */
func (c *Ctx) privilegedOutput(name string, args ...string) (string, error) {
	var cmd *exec.Cmd
	if os.Geteuid() == 0 {
		cmd = exec.Command(name, args...)
	} else {
		cmd = exec.Command("sudo", append([]string{name}, args...)...)
	}
	var out bytes.Buffer
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, &out, os.Stderr
	if tty := openTTY(); tty != nil && !isTerminal(os.Stdin) {
		defer tty.Close()
		cmd.Stdin = tty
	}
	err := cmd.Run()
	return strings.TrimSpace(out.String()), err
}

/* writeRootFile writes a file owned by root (via a temporary file and install(1)). */
func (c *Ctx) writeRootFile(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp("", "spot-lyric-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	tmp.Close()
	_ = os.Chmod(tmp.Name(), 0o644)
	return c.privileged("install", "-D", "-m", fmt.Sprintf("%o", mode), tmp.Name(), path)
}

func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

/* self is the path of the running program. */
func self() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	return exe, nil
}

func fileSum(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	_, _ = io.Copy(h, f)
	return fmt.Sprintf("%x", h.Sum(nil))
}

/*
installSelf copies this program into the data directory, where the local
service and the re-patch hooks run it from. A running copy (the local service on
Windows) cannot be overwritten but can be renamed out of the way.
*/
func (c *Ctx) installSelf() (string, error) {
	exe, err := self()
	if err != nil {
		return "", err
	}
	dest := c.binaryPath()
	if same, _ := filepath.EvalSymlinks(dest); same == exe || fileSum(dest) == fileSum(exe) {
		return dest, nil
	}
	if err := os.MkdirAll(c.DataDir, 0o755); err != nil {
		return "", err
	}
	if isFile(dest) {
		old := fmt.Sprintf("%s.old-%d", dest, time.Now().UnixNano())
		if err := os.Rename(dest, old); err == nil {
			defer os.Remove(old) // fails while the old service still runs; cleaned up next time
		}
	}
	if err := copyFile(exe, dest); err != nil {
		return "", errorf("无法复制程序到 %s：%v", dest, err)
	}
	_ = os.Chmod(dest, 0o755)
	olds, _ := filepath.Glob(dest + ".old-*")
	for _, o := range olds {
		os.Remove(o)
	}
	return dest, nil
}

func (c *Ctx) binaryPath() string {
	if c.OS == "windows" {
		return filepath.Join(c.DataDir, "spot-lyric.exe")
	}
	return filepath.Join(c.DataDir, "spot-lyric")
}

/* httpGet fetches a small body with a timeout. */
func httpGet(url string, timeout time.Duration) (string, error) {
	client := &http.Client{Timeout: timeout}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != 200 {
		return string(data), fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return string(data), nil
}
