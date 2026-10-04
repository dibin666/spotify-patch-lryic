//go:build !windows

package patcher

import (
	"os"
	"os/exec"
	"syscall"
)

/* detach lets a started program outlive this one (own session, no terminal). */
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

/* hideWindow is a no-op outside Windows. */
func hideWindow(cmd *exec.Cmd) {}

func enableColor() bool {
	if os.Getenv("NO_COLOR") != "" || os.Getenv("TERM") == "dumb" {
		return false
	}
	info, err := os.Stdout.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

/* writable reports whether this process may write path (access(2), W_OK). */
func writable(path string) bool { return syscall.Access(path, 2) == nil }

/* fileOwner is the uid owning a file. */
func fileOwner(info os.FileInfo) int {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return int(st.Uid)
	}
	return -1
}

/* openTTY opens the controlling terminal when stdin is a pipe (curl ... | bash). */
func openTTY() *os.File {
	f, err := os.Open("/dev/tty")
	if err != nil {
		return nil
	}
	return f
}
