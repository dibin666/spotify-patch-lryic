package server

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

/* LocalPort is where the per-user local service listens (pure local mode). */
const LocalPort = 38917

/* SetVersion records the program version reported by /health. */
func SetVersion(v string) { version = v }

/* Version is the version reported by /health. */
func Version() string { return version }

/*
LocalEnv returns the configuration of the per-user local service: loopback only,
relay on, matches kept in dataDir, no R2 and no proxy headers trusted. Anything
else falls back to the process environment.
*/
func LocalEnv(dataDir string) func(string) (string, bool) {
	fixed := map[string]string{
		"HOST": "127.0.0.1", "PORT": fmt.Sprint(LocalPort), "DATA_DIR": dataDir,
		"RELAY": "1", "TRUST_PROXY": "0", "API_TOKEN": "", "LOG_REQUESTS": "0",
	}
	return func(k string) (string, bool) {
		if v, ok := fixed[k]; ok {
			return v, true
		}
		if strings.HasPrefix(k, "R2_") {
			return "", false
		}
		return os.LookupEnv(k)
	}
}

/* Healthcheck exits 0 when the server configured by env answers /health (used by the container HEALTHCHECK: the image has no shell). */
func Healthcheck(env func(string) (string, bool)) int {
	cfg := loadConfig(env)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/health", cfg.Port))
	if err != nil || resp.StatusCode != 200 {
		return 1
	}
	return 0
}

/* Run serves until SIGINT / SIGTERM. */
func Run(env func(string) (string, bool)) error {
	cfg := loadConfig(env)
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
		return err
	}
	return nil
}
