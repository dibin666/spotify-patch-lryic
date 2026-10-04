//go:build windows

package patcher

import (
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

const (
	createNoWindow        = 0x08000000
	createNewProcessGroup = 0x00000200
	detachedProcess       = 0x00000008
)

/* detach starts a GUI program (Spotify) independent of this console. */
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachedProcess | createNewProcessGroup}
}

/* hideWindow runs a console helper (powershell, wscript) without flashing a window. */
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

/* enableColor turns on ANSI escape processing in the Windows console (10 and later). */
func enableColor() bool {
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	getMode, setMode := kernel32.NewProc("GetConsoleMode"), kernel32.NewProc("SetConsoleMode")
	handle := syscall.Handle(os.Stdout.Fd())
	var mode uint32
	if r, _, _ := getMode.Call(uintptr(handle), uintptr(unsafe.Pointer(&mode))); r == 0 {
		return false
	}
	const enableVirtualTerminalProcessing = 0x0004
	r, _, _ := setMode.Call(uintptr(handle), uintptr(mode|enableVirtualTerminalProcessing))
	return r != 0
}

/* writable: Windows ACLs are not checked up front; a failed write reports itself. */
func writable(path string) bool { return true }

func fileOwner(info os.FileInfo) int { return -1 }

func openTTY() *os.File {
	f, err := os.OpenFile("CONIN$", os.O_RDWR, 0)
	if err != nil {
		return nil
	}
	return f
}
