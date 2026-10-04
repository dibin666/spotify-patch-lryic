/*
spot-lyric: one program for every system.

	spot-lyric [install|apply|status|restore|uninstall|hook|unhook]   patch Spotify (see --help)
	spot-lyric serve [--local]                                         lyrics server / local service
	spot-lyric healthcheck                                             container health check
*/
package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"

	spotlyric "github.com/dibin666/spotify-patch-lryic"
	"github.com/dibin666/spotify-patch-lryic/patcher"
	"github.com/dibin666/spotify-patch-lryic/server"
)

func main() {
	version := spotlyric.Version()
	server.SetVersion(version)
	args := os.Args[1:]
	if len(args) > 0 {
		switch args[0] {
		case "serve":
			os.Exit(serve(args[1:]))
		case "healthcheck":
			os.Exit(server.Healthcheck(os.LookupEnv))
		}
	}
	os.Exit(patcher.Main(version, args))
}

/* serve runs the lyrics server; --local runs the per-user local service on 127.0.0.1:38917. */
func serve(args []string) int {
	local := false
	for _, a := range args {
		switch a {
		case "--local", "-local":
			local = true
		default:
			fmt.Fprintf(os.Stderr, "未知参数：%s（用法：spot-lyric serve [--local]）\n", a)
			return 2
		}
	}
	env := os.LookupEnv
	if local {
		ctx := patcher.NewCtx(spotlyric.Version(), patcher.Options{Quiet: true})
		data := filepath.Join(ctx.DataDir, "data")
		if err := os.MkdirAll(data, 0o755); err != nil {
			log.Print(err)
			return 1
		}
		/* Started hidden on Windows / by launchd: keep a small log next to the data. */
		if f, err := os.OpenFile(filepath.Join(ctx.DataDir, "local.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
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
