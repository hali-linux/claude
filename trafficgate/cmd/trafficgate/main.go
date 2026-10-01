// trafficgate 는 가상 대기실(트래픽 제어) 서버이다.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/hali-linux/claude/trafficgate/internal/auth"
	"github.com/hali-linux/claude/trafficgate/internal/bench"
	"github.com/hali-linux/claude/trafficgate/internal/config"
	"github.com/hali-linux/claude/trafficgate/internal/queue"
	"github.com/hali-linux/claude/trafficgate/internal/server"
	"github.com/hali-linux/claude/trafficgate/internal/version"
)

const usage = `TrafficGate — 가상 대기실(트래픽 제어) 서버

사용법:
  trafficgate <명령> [옵션]

명령:
  serve          서버 실행
  init-config    설정 파일 생성 (비밀 키/관리자 비밀번호 자동 생성)
  hash-password  관리자 비밀번호 해시 생성
  check-config   설정 파일 검사
  bench          부하 테스트 (가상 사용자 시뮬레이션)
  version        버전 출력

각 명령의 옵션은 "trafficgate <명령> -h" 로 확인하세요.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	args := os.Args[2:]
	switch os.Args[1] {
	case "serve":
		err = cmdServe(args)
	case "init-config":
		err = cmdInitConfig(args)
	case "hash-password":
		err = cmdHashPassword(args)
	case "check-config":
		err = cmdCheckConfig(args)
	case "bench":
		err = cmdBench(args)
	case "version", "-v", "--version":
		fmt.Printf("trafficgate %s (commit %s, built %s)\n", version.Version, version.Commit, version.Date)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "알 수 없는 명령: %s\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "오류:", err)
		os.Exit(1)
	}
}

func newLogger(cfg config.LogConfig) *slog.Logger {
	var level slog.Level
	switch cfg.Level {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: level}
	// systemd(journald) 아래에서는 시각이 이미 기록되므로 생략한다.
	if os.Getenv("JOURNAL_STREAM") != "" {
		opts.ReplaceAttr = func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) == 0 && a.Key == slog.TimeKey {
				return slog.Attr{}
			}
			return a
		}
	}
	if cfg.Format == "json" {
		return slog.New(slog.NewJSONHandler(os.Stderr, opts))
	}
	return slog.New(slog.NewTextHandler(os.Stderr, opts))
}

func openStore(cfg config.Config) (queue.Store, error) {
	switch cfg.Store.Type {
	case "redis":
		r := cfg.Store.Redis
		return queue.NewRedisStore(queue.RedisOptions{
			Addrs: r.Addrs, MasterName: r.MasterName, Username: r.Username, Password: r.Password,
			DB: r.DB, TLS: r.TLS, KeyPrefix: r.KeyPrefix, PoolSize: r.PoolSize,
		})
	default:
		return queue.NewMemoryStore(cfg.Store.DataDir)
	}
}

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	path := fs.String("config", config.DefaultPath, "설정 파일 경로")
	_ = fs.Parse(args)

	cfg, err := config.Load(*path)
	if err != nil {
		return err
	}
	log := newLogger(cfg.Log)
	slog.SetDefault(log)
	log.Info("TrafficGate 시작", "version", version.Version, "config", *path, "store", cfg.Store.Type)

	store, err := openStore(cfg)
	if err != nil {
		return fmt.Errorf("저장소 초기화 실패: %w", err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			log.Error("저장소 종료 실패", "err", err)
		} else {
			log.Info("저장소 종료 완료")
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Redis 가 아직 준비되지 않았을 수 있으므로 잠시 재시도한다.
	var engine *queue.Engine
	for attempt := 1; ; attempt++ {
		pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		err = store.Ping(pingCtx)
		if err == nil {
			engine, err = queue.NewEngine(pingCtx, store, cfg.EngineConfig(), log)
		}
		cancel()
		if err == nil {
			break
		}
		if attempt >= 10 || ctx.Err() != nil {
			return fmt.Errorf("저장소 연결 실패: %w", err)
		}
		log.Warn("저장소 연결 재시도", "attempt", attempt, "err", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(attempt) * time.Second):
		}
	}
	if err := engine.Seed(ctx, cfg.Segments); err != nil {
		return err
	}

	srv, err := server.New(cfg, engine, log)
	if err != nil {
		return err
	}
	engineCtx, cancelEngine := context.WithCancel(context.Background())
	engineDone := make(chan struct{})
	go func() {
		engine.Run(engineCtx)
		close(engineDone)
	}()

	runErr := srv.Run(ctx)
	cancelEngine()
	<-engineDone
	log.Info("TrafficGate 종료")
	return runErr
}

func cmdInitConfig(args []string) error {
	fs := flag.NewFlagSet("init-config", flag.ExitOnError)
	out := fs.String("out", config.DefaultPath, "생성할 설정 파일 경로 (- 이면 표준 출력)")
	force := fs.Bool("force", false, "이미 있으면 덮어쓰기")
	ifMissing := fs.Bool("if-missing", false, "이미 있으면 아무것도 하지 않고 성공 처리 (패키지 설치 스크립트용)")
	listen := fs.String("listen", "0.0.0.0:8800", "공개 서버 주소")
	adminListen := fs.String("admin-listen", "127.0.0.1:8801", "관리 콘솔 주소 (빈 값이면 비활성)")
	storeType := fs.String("store", "memory", "저장소: memory | redis")
	dataDir := fs.String("data-dir", "/var/lib/trafficgate", "메모리 저장소 데이터 디렉터리")
	redisAddrs := fs.String("redis-addr", "127.0.0.1:6379", "Redis 주소 (쉼표로 여러 개)")
	user := fs.String("admin-user", "admin", "관리자 아이디")
	password := fs.String("admin-password", "", "관리자 비밀번호 (생략 시 무작위 생성)")
	passwordFile := fs.String("password-file", "", "생성된 관리자 비밀번호를 저장할 파일 (0600)")
	basePath := fs.String("gate-base-path", "/__tg", "nginx 게이트 공개 경로 접두사")
	_ = fs.Parse(args)

	if *out != "-" {
		if _, err := os.Stat(*out); err == nil {
			if *ifMissing {
				fmt.Fprintf(os.Stderr, "설정 파일이 이미 있어 건너뜁니다: %s\n", *out)
				return nil
			}
			if !*force {
				return fmt.Errorf("%s 가 이미 있습니다 (덮어쓰려면 -force)", *out)
			}
		}
	}
	pw := *password
	generated := pw == ""
	if generated {
		pw = auth.RandomPassword(16)
	}
	hash, err := auth.HashPassword(pw)
	if err != nil {
		return err
	}
	var addrs []string
	for _, a := range strings.Split(*redisAddrs, ",") {
		if a = strings.TrimSpace(a); a != "" {
			addrs = append(addrs, a)
		}
	}
	data, err := config.Render(config.TemplateData{
		Listen: *listen, AdminListen: *adminListen, GateBasePath: *basePath,
		StoreType: *storeType, DataDir: *dataDir, RedisAddrs: addrs,
		TokenSecret: auth.RandomString(32), SessionSecret: auth.RandomString(32),
		AdminUser: *user, AdminHash: hash,
	})
	if err != nil {
		return err
	}
	if _, err := config.Parse(data); err != nil {
		return fmt.Errorf("생성된 설정 검증 실패: %w", err)
	}
	if *out == "-" {
		_, err = os.Stdout.Write(data)
	} else {
		if err := os.MkdirAll(filepath.Dir(*out), 0o750); err != nil {
			return err
		}
		err = os.WriteFile(*out, data, 0o640)
	}
	if err != nil {
		return err
	}
	if *passwordFile != "" {
		content := fmt.Sprintf("TrafficGate 관리 콘솔 초기 계정\n아이디: %s\n비밀번호: %s\n\n로그인 후 비밀번호를 바꾸고(trafficgate hash-password) 이 파일을 삭제하세요.\n", *user, pw)
		if err := os.WriteFile(*passwordFile, []byte(content), 0o600); err != nil {
			return err
		}
	}
	if *out != "-" {
		fmt.Fprintf(os.Stderr, "설정 파일을 만들었습니다: %s\n", *out)
		if generated && *passwordFile == "" {
			fmt.Fprintf(os.Stderr, "관리자 계정: %s / %s  (지금 안전한 곳에 기록하세요)\n", *user, pw)
		} else if *passwordFile != "" {
			fmt.Fprintf(os.Stderr, "관리자 초기 비밀번호는 %s 에 저장했습니다.\n", *passwordFile)
		}
	}
	return nil
}

func cmdHashPassword(args []string) error {
	fs := flag.NewFlagSet("hash-password", flag.ExitOnError)
	stdin := fs.Bool("stdin", false, "표준 입력의 첫 줄을 비밀번호로 사용")
	_ = fs.Parse(args)
	var pw string
	if *stdin || !isTerminal(os.Stdin) {
		line, err := stdinReader.ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		pw = strings.TrimRight(line, "\r\n")
	} else {
		var err error
		if pw, err = readPassword("새 비밀번호: "); err != nil {
			return err
		}
		again, err := readPassword("비밀번호 확인: ")
		if err != nil {
			return err
		}
		if pw != again {
			return errors.New("비밀번호가 일치하지 않습니다")
		}
	}
	h, err := auth.HashPassword(pw)
	if err != nil {
		return err
	}
	fmt.Println(h)
	return nil
}

func cmdCheckConfig(args []string) error {
	fs := flag.NewFlagSet("check-config", flag.ExitOnError)
	path := fs.String("config", config.DefaultPath, "설정 파일 경로")
	quiet := fs.Bool("q", false, "성공 시 출력하지 않음")
	_ = fs.Parse(args)
	cfg, err := config.Load(*path)
	if err != nil {
		return err
	}
	if !*quiet {
		fmt.Printf("설정 OK: %s\n  공개 서버: %s\n  관리 콘솔: %s\n  저장소: %s\n  초기 세그먼트: %d개\n",
			*path, cfg.Server.Listen, orDash(cfg.Admin.Listen), cfg.Store.Type, len(cfg.Segments))
	}
	return nil
}

func orDash(s string) string {
	if s == "" {
		return "(비활성)"
	}
	return s
}

func cmdBench(args []string) error {
	fs := flag.NewFlagSet("bench", flag.ExitOnError)
	var o bench.Options
	fs.StringVar(&o.URL, "url", "http://127.0.0.1:8800", "TrafficGate 공개 주소")
	fs.StringVar(&o.Segment, "segment", "default", "세그먼트 ID")
	fs.IntVar(&o.Users, "users", 1000, "가상 사용자 수")
	fs.Float64Var(&o.ArrivalRate, "rate", 200, "초당 도착 사용자 수")
	fs.DurationVar(&o.Hold, "hold", 2*time.Second, "입장 후 머무는 시간 (이후 complete)")
	fs.Float64Var(&o.PollScale, "poll-scale", 1, "서버 권장 폴링 간격 배율 (작을수록 공격적)")
	fs.DurationVar(&o.Timeout, "timeout", 10*time.Minute, "전체 제한 시간")
	fs.IntVar(&o.Concurrency, "max-conns", 512, "최대 동시 연결 수")
	_ = fs.Parse(args)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	_, err := bench.Run(ctx, o, os.Stdout)
	return err
}
