package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	env := os.LookupEnv
	cfg := loadConfig(env)

	/* `spot-lyric-server healthcheck`: used by the container HEALTHCHECK (the image has no shell / wget). */
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		client := &http.Client{Timeout: 5 * time.Second}
		resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/health", cfg.Port))
		if err != nil || resp.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}

	log.SetFlags(0)
	log.SetFlags(log.LstdFlags | log.LUTC)
	app := NewApp(cfg, newBucket(cfg, env), nil)
	srv := newServer(app)

	storage, relay := "local directory (no R2 configured)", "off"
	if app.storage == "r2" {
		storage = "R2"
	}
	if cfg.Relay {
		relay = "on"
	}
	log.Printf("spot-lyric-server v%s listening on %s · storage: %s · relay: %s", version, srv.Addr, storage, relay)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
