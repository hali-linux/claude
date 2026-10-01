// Package server 는 TrafficGate 의 HTTP 서버(공개 대기열 API, nginx 게이트, 관리 콘솔)이다.
package server

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hali-linux/claude/trafficgate/internal/auth"
	"github.com/hali-linux/claude/trafficgate/internal/config"
	"github.com/hali-linux/claude/trafficgate/internal/queue"
	"github.com/hali-linux/claude/trafficgate/internal/token"
)

// Server 는 공개 서버와 관리 서버를 함께 관리한다.
type Server struct {
	cfg      config.Config
	engine   *queue.Engine
	signer   *token.Signer
	sessions *auth.Sessions
	log      *slog.Logger
	trusted  []netip.Prefix
	now      func() time.Time
	started  time.Time

	enterRL *rateLimiter
	pollRL  *rateLimiter
	loginRL *rateLimiter

	reqMu    sync.Mutex
	requests map[reqKey]*atomic.Int64
	limited  atomic.Int64

	ready atomic.Bool
}

type reqKey struct {
	route string
	code  int
}

// New 는 서버를 만든다.
func New(cfg config.Config, engine *queue.Engine, log *slog.Logger) (*Server, error) {
	signer, err := token.NewSigner(cfg.Security.TokenSecret, cfg.Security.PreviousTokenSecrets...)
	if err != nil {
		return nil, err
	}
	trusted, err := cfg.TrustedPrefixes()
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg:      cfg,
		engine:   engine,
		signer:   signer,
		log:      log,
		trusted:  trusted,
		now:      time.Now,
		requests: make(map[reqKey]*atomic.Int64),
		loginRL:  newRateLimiter(10, 5),
	}
	s.started = s.now()
	if cfg.Admin.Listen != "" {
		if s.sessions, err = auth.NewSessions(cfg.Security.SessionSecret, cfg.Admin.SessionTTL); err != nil {
			return nil, err
		}
	}
	if cfg.RateLimit.Enabled {
		s.enterRL = newRateLimiter(cfg.RateLimit.EnterPerMinute, cfg.RateLimit.EnterBurst)
		s.pollRL = newRateLimiter(cfg.RateLimit.PollPerMinute, cfg.RateLimit.PollBurst)
	}
	s.ready.Store(true)
	return s, nil
}

// SetClock 은 테스트용 시계를 설정한다.
func (s *Server) SetClock(now func() time.Time) { s.now = now }

func (s *Server) countRequest(route string, code int) {
	k := reqKey{route, code}
	s.reqMu.Lock()
	c := s.requests[k]
	if c == nil {
		c = new(atomic.Int64)
		s.requests[k] = c
	}
	s.reqMu.Unlock()
	c.Add(1)
}

// instrument 는 요청 수/상태 코드를 집계하고, 설정 시 접근 로그를 남긴다.
func (s *Server) instrument(route string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		defer func() {
			if v := recover(); v != nil {
				s.log.Error("핸들러 패닉", "route", route, "panic", v)
				if rec.status == 0 {
					writeError(rec, http.StatusInternalServerError, "internal_error", "")
				}
			}
			if rec.status == 0 {
				rec.status = http.StatusOK
			}
			s.countRequest(route, rec.status)
			if s.cfg.Log.Access {
				s.log.Info("access", "route", route, "method", r.Method, "path", r.URL.Path,
					"status", rec.status, "ip", clientIP(r, s.trusted).String(), "dur_ms", time.Since(start).Milliseconds())
			}
		}()
		h(rec, r)
	}
}

// Run 은 공개/관리 서버를 띄우고 ctx 가 끝나면 정상 종료한다.
func (s *Server) Run(ctx context.Context) error {
	type srvDef struct {
		name, addr, cert, key string
		handler               http.Handler
	}
	defs := []srvDef{{"public", s.cfg.Server.Listen, s.cfg.Server.TLSCert, s.cfg.Server.TLSKey, s.PublicHandler()}}
	if s.cfg.Admin.Listen != "" {
		defs = append(defs, srvDef{"admin", s.cfg.Admin.Listen, s.cfg.Admin.TLSCert, s.cfg.Admin.TLSKey, s.AdminHandler()})
	}

	var (
		servers []*http.Server
		errc    = make(chan error, len(defs))
	)
	for _, d := range defs {
		ln, err := net.Listen("tcp", d.addr)
		if err != nil {
			for _, srv := range servers {
				_ = srv.Close()
			}
			return fmt.Errorf("%s 서버 %s 바인드 실패: %w", d.name, d.addr, err)
		}
		srv := &http.Server{
			Handler:           d.handler,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       15 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       120 * time.Second,
			MaxHeaderBytes:    64 << 10,
			ErrorLog:          slog.NewLogLogger(s.log.Handler(), slog.LevelWarn),
		}
		if d.cert != "" {
			srv.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		}
		servers = append(servers, srv)
		s.log.Info("서버 시작", "name", d.name, "addr", ln.Addr().String(), "tls", d.cert != "")
		go func(d srvDef, srv *http.Server, ln net.Listener) {
			var err error
			if d.cert != "" {
				err = srv.ServeTLS(ln, d.cert, d.key)
			} else {
				err = srv.Serve(ln)
			}
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				errc <- fmt.Errorf("%s 서버 오류: %w", d.name, err)
			}
		}(d, srv, ln)
	}
	sdNotify("READY=1\nSTATUS=TrafficGate 서비스 중")

	cleanup := time.NewTicker(time.Minute)
	defer cleanup.Stop()
	var runErr error
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case err := <-errc:
			runErr = err
			break loop
		case now := <-cleanup.C:
			s.enterRL.Cleanup(now)
			s.pollRL.Cleanup(now)
			s.loginRL.Cleanup(now)
		}
	}

	s.ready.Store(false)
	sdNotify("STOPPING=1")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, srv := range servers {
		if err := srv.Shutdown(shutdownCtx); err != nil {
			s.log.Warn("서버 종료 중 오류", "err", err)
		}
	}
	return runErr
}

// sdNotify 는 systemd(Type=notify)에 상태를 알린다. NOTIFY_SOCKET 이 없으면 아무것도 하지 않는다.
func sdNotify(state string) {
	sock := os.Getenv("NOTIFY_SOCKET")
	if sock == "" {
		return
	}
	if sock[0] == '@' {
		sock = "\x00" + sock[1:]
	}
	conn, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: sock, Net: "unixgram"})
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = conn.Write([]byte(state))
}
