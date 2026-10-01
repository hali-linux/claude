// Command modsec-spoa is a HAProxy SPOE agent (SPOA) that inspects HTTP
// requests with ModSecurity v3 (libmodsecurity) and the OWASP Core Rule Set.
//
// HAProxy sends each request (headers and the first part of the body) to the
// agent, the agent returns a verdict in HAProxy variables (txn.waf.*), and
// HAProxy enforces it, the same split of responsibilities as an AWS
// Application Load Balancer with an associated AWS WAF web ACL.
//
// Signals: SIGHUP reloads the rules (the old rules stay active if the new ones
// fail to load), SIGUSR1 reopens the WAF log, SIGTERM/SIGINT stop gracefully.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"modsec-spoa/internal/agent"
	"modsec-spoa/internal/modsec"
	"modsec-spoa/internal/spop"
)

var version = "1.0.0"

func main() {
	var (
		listen        = flag.String("listen", "127.0.0.1:12345", "listen address (host:port or unix:/path)")
		rules         = flag.String("rules", "/etc/modsec-spoa/main.conf", "ModSecurity rules file (Include directives allowed)")
		wafLog        = flag.String("waf-log", "/var/log/modsec-spoa/waf.log", `WAF event log, one JSON object per line ("-" = stdout, "" = disabled)`)
		logAllowed    = flag.Bool("waf-log-allowed", false, "also log requests that matched no rule")
		redact        = flag.String("redact-headers", "cookie,authorization,proxy-authorization,x-api-key,set-cookie", "headers whose values are masked in WAF logs")
		webACL        = flag.String("web-acl", "haproxy-modsecurity", "web ACL name written to WAF logs")
		concurrency   = flag.Int("max-concurrency", 2*runtime.NumCPU(), "requests evaluated in parallel")
		maxFrame      = flag.Uint("max-frame-size", 1<<20, "largest SPOP frame accepted (the smaller of this and HAProxy's value is used)")
		logLevel      = flag.String("log-level", "info", "debug | info | warn | error")
		test          = flag.Bool("t", false, "test the rules configuration and exit")
		showVersion   = flag.Bool("version", false, "print version and exit")
		shutdownGrace = flag.Duration("shutdown-timeout", 10*time.Second, "graceful shutdown timeout")
	)
	flag.Parse()

	var lvl slog.Level
	if err := lvl.UnmarshalText([]byte(*logLevel)); err != nil {
		fatal("invalid -log-level", err)
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lvl}))
	slog.SetDefault(logger)

	engine := modsec.NewEngine("modsec-spoa/" + version)
	if *showVersion {
		fmt.Printf("modsec-spoa %s (%s, %s)\n", version, engine.Version(), runtime.Version())
		return
	}

	start := time.Now()
	rs, err := modsec.LoadRules(modsec.RuleSource{Path: *rules})
	if err != nil {
		fatal("cannot load rules", err)
	}
	if *test {
		fmt.Printf("modsec-spoa: %s: %d rules loaded, configuration OK\n", *rules, rs.Count())
		rs.Close()
		return
	}
	engine.Reload(rs)
	logger.Info("rules loaded", "file", *rules, "rules", engine.RuleCount(), "took", time.Since(start).Round(time.Millisecond), "engine", engine.Version())

	var wlog *agent.WAFLog
	if *wafLog != "" {
		if wlog, err = agent.OpenWAFLog(*wafLog); err != nil {
			fatal("cannot open WAF log", err)
		}
		defer wlog.Close()
	}

	redactSet := map[string]bool{}
	for _, h := range strings.Split(*redact, ",") {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			redactSet[h] = true
		}
	}
	handler := agent.New(agent.Config{
		Engine:        engine,
		Log:           wlog,
		LogAllowed:    *logAllowed,
		RedactHeaders: redactSet,
		WebACLID:      *webACL,
		Logger:        logger,
	})

	ln, err := listenOn(*listen)
	if err != nil {
		fatal("cannot listen", err)
	}
	srv := &spop.Server{
		Handler:        handler.Handle,
		MaxFrameSize:   uint32(*maxFrame),
		MaxConcurrency: *concurrency,
		Logger:         logger,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()
	logger.Info("modsec-spoa started", "version", version, "listen", *listen, "max_concurrency", *concurrency)
	sdNotify("READY=1")

	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGHUP, syscall.SIGUSR1, syscall.SIGTERM, syscall.SIGINT)
	for {
		select {
		case err := <-serveErr:
			if !errors.Is(err, spop.ErrServerClosed) {
				fatal("server error", err)
			}
			return
		case sig := <-sigs:
			switch sig {
			case syscall.SIGHUP:
				sdNotify("RELOADING=1")
				t0 := time.Now()
				rs, err := modsec.LoadRules(modsec.RuleSource{Path: *rules})
				if err != nil {
					logger.Error("reload failed; keeping the current rules", "err", err)
				} else {
					engine.Reload(rs)
					logger.Info("rules reloaded", "rules", engine.RuleCount(), "took", time.Since(t0).Round(time.Millisecond))
				}
				sdNotify("READY=1")
			case syscall.SIGUSR1:
				if wlog != nil {
					if err := wlog.Reopen(); err != nil {
						logger.Error("cannot reopen WAF log", "err", err)
					}
				}
			default:
				logger.Info("shutting down", "signal", sig.String())
				sdNotify("STOPPING=1")
				ctx, cancel := context.WithTimeout(context.Background(), *shutdownGrace)
				err := srv.Shutdown(ctx)
				cancel()
				if err != nil {
					logger.Warn("forced shutdown", "err", err)
				}
				return
			}
		}
	}
}

func listenOn(addr string) (net.Listener, error) {
	if path, ok := strings.CutPrefix(addr, "unix:"); ok {
		_ = os.Remove(path)
		l, err := net.Listen("unix", path)
		if err != nil {
			return nil, err
		}
		// HAProxy runs as another user; the directory permissions restrict access.
		_ = os.Chmod(path, 0o666)
		return l, nil
	}
	return net.Listen("tcp", addr)
}

// sdNotify implements the systemd notification protocol (Type=notify).
func sdNotify(state string) {
	sock := os.Getenv("NOTIFY_SOCKET")
	if sock == "" {
		return
	}
	if strings.HasPrefix(sock, "@") {
		sock = "\x00" + sock[1:]
	}
	conn, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: sock, Net: "unixgram"})
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = conn.Write([]byte(state))
}

func fatal(msg string, err error) {
	fmt.Fprintf(os.Stderr, "modsec-spoa: %s: %v\n", msg, err)
	os.Exit(1)
}
