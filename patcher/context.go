/*
Package patcher installs the Spot-Lyric plugin into the Spotify desktop client
on Windows, macOS and Linux, and sets up how the plugin reaches NetEase / QQ
Music: through a lyrics server (cloud), directly (Spotify started with
--disable-web-security) or through the local service on 127.0.0.1.
One program, one set of commands and options on every system.
*/
package patcher

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	DefaultServer = "https://spo.564616.xyz"
	LocalURL      = "http://127.0.0.1:38917"
	Repo          = "dibin666/spotify-patch-lryic"
)

/* Usage modes. direct and local never contact a remote server. */
const (
	ModeCloud  = "cloud"  // lyrics server: shared matches + relay
	ModeDirect = "direct" // pure local, Spotify started with --disable-web-security
	ModeLocal  = "local"  // pure local, local service on 127.0.0.1:38917 relays
)

var modeNames = map[string]string{
	ModeCloud:  "云端服务器",
	ModeDirect: "纯本地 · 直连",
	ModeLocal:  "纯本地 · 本地服务",
}

/* Options from the command line ("" = not given). */
type Options struct {
	Command     string
	SpotifyPath string
	Mode        string
	Server      string
	Restart     string // auto | yes | no
	Hook        string // "" | on | off
	Yes         bool
	Quiet       bool
	Args        []string // positional arguments after the command (internal commands)
}

/* Config remembers the choices of the last install (per user). */
type Config struct {
	Mode   string `json:"mode,omitempty"`
	Server string `json:"server,omitempty"`
}

/* Ctx carries the environment of one run. */
type Ctx struct {
	OS      string // linux | macos | windows
	Arch    string
	Home    string
	DataDir string
	Version string
	Opts    Options
	Config  Config

	SpotifyDir string // install directory (Linux / Windows) or Spotify.app (macOS)
	Apps       string // directory holding xpui.spa

	out   io.Writer
	in    *bufio.Reader // nil: not interactive
	color bool
}

func NewCtx(version string, opts Options) *Ctx {
	c := &Ctx{Version: version, Opts: opts, Arch: runtime.GOARCH, out: os.Stdout}
	switch strings.ToLower(os.Getenv("SPOT_LYRIC_PLATFORM")) {
	case "macos", "darwin":
		c.OS = "macos"
	case "linux":
		c.OS = "linux"
	case "windows":
		c.OS = "windows"
	default:
		c.OS = map[string]string{"darwin": "macos", "windows": "windows"}[runtime.GOOS]
		if c.OS == "" {
			c.OS = "linux"
		}
	}
	c.Home, _ = os.UserHomeDir()
	c.DataDir = dataDir(c.OS, c.Home)
	c.color = enableColor()
	c.Config = c.loadConfig()
	return c
}

func dataDir(osName, home string) string {
	if d := os.Getenv("SPOT_LYRIC_DATA"); d != "" {
		return d
	}
	switch osName {
	case "windows":
		if d := os.Getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, "SpotLyric")
		}
		return filepath.Join(home, "AppData", "Local", "SpotLyric")
	case "macos":
		return filepath.Join(home, "Library", "Application Support", "SpotLyric")
	}
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "spot-lyric")
	}
	return filepath.Join(home, ".local", "share", "spot-lyric")
}

func (c *Ctx) OSName() string {
	return map[string]string{"linux": "Linux", "macos": "macOS", "windows": "Windows"}[c.OS]
}

/* ------------------------------------------------------------ output ---- */

func (c *Ctx) paint(code, text string) string {
	if !c.color {
		return text
	}
	return "\033[" + code + "m" + text + "\033[0m"
}

func (c *Ctx) Say(format string, a ...any) {
	if !c.Opts.Quiet {
		fmt.Fprintf(c.out, "%s %s\n", c.paint("1;32", "[spot-lyric]"), fmt.Sprintf(format, a...))
	}
}

func (c *Ctx) Warn(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "%s %s\n", c.paint("1;33", "[spot-lyric]"), fmt.Sprintf(format, a...))
}

func (c *Ctx) Fail(err error) {
	fmt.Fprintf(os.Stderr, "%s %s\n", c.paint("1;31", "[spot-lyric]"), err.Error())
}

/* Print writes plain text (status output, prompts). */
func (c *Ctx) Print(format string, a ...any) { fmt.Fprintf(c.out, format, a...) }

/* ------------------------------------------------------------ config ---- */

func (c *Ctx) configPath() string { return filepath.Join(c.DataDir, "config.json") }

func (c *Ctx) loadConfig() Config {
	var cfg Config
	if data, err := os.ReadFile(c.configPath()); err == nil {
		_ = json.Unmarshal(data, &cfg)
	}
	if _, ok := modeNames[cfg.Mode]; !ok {
		cfg.Mode = ""
	}
	return cfg
}

func (c *Ctx) saveConfig() {
	data, _ := json.MarshalIndent(c.Config, "", "  ")
	if err := os.MkdirAll(c.DataDir, 0o755); err == nil {
		_ = os.WriteFile(c.configPath(), append(data, '\n'), 0o644)
	}
}

/* errorf builds the user-facing error of a failed step. */
func errorf(format string, a ...any) error { return fmt.Errorf(format, a...) }
