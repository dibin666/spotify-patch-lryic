/*
spot-lyric-server: the Spot-Lyric lyrics server (shared matches + relay) and, with
--local, the per-user local service of pure local mode.

	spot-lyric-server serve                    configured by the environment (docker, see server/.env.example)
	spot-lyric-server serve --local [--data D] 127.0.0.1:38917, relay only, installed by patch.sh / patch.ps1
	spot-lyric-server healthcheck              container health check
	spot-lyric-server version
*/
package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"

	spotlyric "github.com/dibin666/spotify-patch-lryic"
	"github.com/dibin666/spotify-patch-lryic/server"
)

func main() {
	server.SetVersion(spotlyric.Version())
	args := os.Args[1:]
	command := "serve"
	if len(args) > 0 {
		command, args = args[0], args[1:]
	}
	switch command {
	case "serve":
		os.Exit(serve(args))
	case "healthcheck":
		os.Exit(server.Healthcheck(os.LookupEnv))
	case "version", "--version", "-v":
		fmt.Println(spotlyric.Version())
	default:
		fmt.Fprintln(os.Stderr, "用法：spot-lyric-server serve [--local [--data DIR]] | healthcheck | version")
		os.Exit(2)
	}
}

/* defaultDataDir is where patch.sh / patch.ps1 install the local service. */
func defaultDataDir() string {
	if d := os.Getenv("SPOT_LYRIC_DATA"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		if d := os.Getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, "SpotLyric")
		}
		return filepath.Join(home, "AppData", "Local", "SpotLyric")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "SpotLyric")
	}
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "spot-lyric")
	}
	return filepath.Join(home, ".local", "share", "spot-lyric")
}

func serve(args []string) int {
	local, dir := false, ""
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--local", "-local":
			local = true
		case "--data", "-data":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "--data 需要一个目录")
				return 2
			}
			i++
			dir = args[i]
		default:
			fmt.Fprintf(os.Stderr, "未知参数：%s（用法：spot-lyric-server serve [--local [--data DIR]]）\n", args[i])
			return 2
		}
	}
	env := os.LookupEnv
	if local {
		if dir == "" {
			dir = defaultDataDir()
		}
		data := filepath.Join(dir, "data")
		if err := os.MkdirAll(data, 0o755); err != nil {
			log.Print(err)
			return 1
		}
		/* Started hidden (Windows) or by launchd / systemd: keep a small log next to the data. */
		if f, err := os.OpenFile(filepath.Join(dir, "local.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
			if info, err := f.Stat(); err == nil && info.Size() > 1<<20 {
				_ = f.Truncate(0)
			}
			log.SetOutput(io.MultiWriter(os.Stderr, f))
			defer f.Close()
		}
		env = server.LocalEnv(data)
	}
	if err := server.Run(env); err != nil {
		log.Print(err)
		return 1
	}
	return 0
}
