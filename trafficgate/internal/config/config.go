// Package config 는 TrafficGate 설정 파일(YAML)을 읽고 검증한다.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/hali-linux/claude/trafficgate/internal/auth"
	"github.com/hali-linux/claude/trafficgate/internal/queue"
)

// DefaultPath 는 기본 설정 파일 경로이다.
const DefaultPath = "/etc/trafficgate/config.yaml"

// Config 는 전체 설정이다.
type Config struct {
	Server    ServerConfig    `yaml:"server"`
	Admin     AdminConfig     `yaml:"admin"`
	Security  SecurityConfig  `yaml:"security"`
	Store     StoreConfig     `yaml:"store"`
	Queue     QueueConfig     `yaml:"queue"`
	RateLimit RateLimitConfig `yaml:"rate_limit"`
	Log       LogConfig       `yaml:"log"`
	// Segments 는 저장소에 세그먼트가 하나도 없을 때(최초 기동) 등록할 초기 세그먼트이다.
	Segments []queue.Segment `yaml:"segments"`
}

// ServerConfig 는 공개(대기열 API/대기 화면) 서버 설정이다.
type ServerConfig struct {
	Listen         string   `yaml:"listen"`
	TLSCert        string   `yaml:"tls_cert"`
	TLSKey         string   `yaml:"tls_key"`
	TrustedProxies []string `yaml:"trusted_proxies"`
	CORSOrigins    []string `yaml:"cors_origins"`
	// GateBasePath 는 nginx 게이트 연동 시 TrafficGate 를 노출하는 공개 경로 접두사이다(예: /__tg).
	GateBasePath string `yaml:"gate_base_path"`
	// CookieSecure: auto(HTTPS 요청일 때만), always, never
	CookieSecure string `yaml:"cookie_secure"`
	// CookieDomain 을 지정하면 통과 쿠키를 하위 도메인 전체에서 공유한다(예: .example.com).
	CookieDomain string `yaml:"cookie_domain"`
}

// AdminConfig 는 관리 콘솔/관리 API 설정이다.
type AdminConfig struct {
	// Listen 이 비어 있으면 관리 콘솔을 띄우지 않는다.
	Listen        string        `yaml:"listen"`
	TLSCert       string        `yaml:"tls_cert"`
	TLSKey        string        `yaml:"tls_key"`
	Users         []AdminUser   `yaml:"users"`
	APITokens     []string      `yaml:"api_tokens"`
	SessionTTL    time.Duration `yaml:"session_ttl"`
	MetricsPublic bool          `yaml:"metrics_public"`
}

// AdminUser 는 관리자 계정이다.
type AdminUser struct {
	Username     string `yaml:"username"`
	PasswordHash string `yaml:"password_hash"`
}

// SecurityConfig 는 서명 키 설정이다.
type SecurityConfig struct {
	// TokenSecret 은 통과 토큰 HMAC 키이다. 클러스터의 모든 노드와 토큰을 검증하는 백엔드가 같은 값을 써야 한다.
	TokenSecret string `yaml:"token_secret"`
	// PreviousTokenSecrets 는 키 교체 중 아직 유효한 이전 키 목록이다(검증에만 사용).
	PreviousTokenSecrets []string `yaml:"previous_token_secrets"`
	// SessionSecret 은 관리 콘솔 세션 쿠키 서명 키이다.
	SessionSecret string `yaml:"session_secret"`
}

// StoreConfig 는 저장소 설정이다.
type StoreConfig struct {
	Type    string      `yaml:"type"` // memory | redis
	DataDir string      `yaml:"data_dir"`
	Redis   RedisConfig `yaml:"redis"`
}

// RedisConfig 는 Redis 연결 설정이다.
type RedisConfig struct {
	Addrs      []string `yaml:"addrs"`
	MasterName string   `yaml:"master_name"`
	Username   string   `yaml:"username"`
	Password   string   `yaml:"password"`
	DB         int      `yaml:"db"`
	TLS        bool     `yaml:"tls"`
	KeyPrefix  string   `yaml:"key_prefix"`
	PoolSize   int      `yaml:"pool_size"`
}

// QueueConfig 는 대기열 동작 설정이다.
type QueueConfig struct {
	LiveWindow     time.Duration `yaml:"live_window"`
	WaitTTL        time.Duration `yaml:"wait_ttl"`
	MinPoll        time.Duration `yaml:"min_poll_interval"`
	MaxPoll        time.Duration `yaml:"max_poll_interval"`
	SweepInterval  time.Duration `yaml:"sweep_interval"`
	SegmentRefresh time.Duration `yaml:"segment_refresh"`
}

// RateLimitConfig 는 IP 별 요청 제한 설정이다.
type RateLimitConfig struct {
	Enabled        bool `yaml:"enabled"`
	EnterPerMinute int  `yaml:"enter_per_minute"`
	EnterBurst     int  `yaml:"enter_burst"`
	PollPerMinute  int  `yaml:"poll_per_minute"`
	PollBurst      int  `yaml:"poll_burst"`
}

// LogConfig 는 로그 설정이다.
type LogConfig struct {
	Level  string `yaml:"level"`  // debug | info | warn | error
	Format string `yaml:"format"` // text | json
	Access bool   `yaml:"access"` // 요청별 접근 로그
}

// Default 는 기본값이 채워진 설정을 돌려준다.
func Default() Config {
	return Config{
		Server: ServerConfig{
			Listen:         "0.0.0.0:8800",
			TrustedProxies: []string{"127.0.0.1/32", "::1/128"},
			CORSOrigins:    []string{"*"},
			GateBasePath:   "/__tg",
			CookieSecure:   "auto",
		},
		Admin: AdminConfig{
			Listen:        "127.0.0.1:8801",
			SessionTTL:    12 * time.Hour,
			MetricsPublic: true,
		},
		Store: StoreConfig{
			Type:    "memory",
			DataDir: "/var/lib/trafficgate",
			Redis: RedisConfig{
				Addrs:     []string{"127.0.0.1:6379"},
				KeyPrefix: "tg:",
			},
		},
		Queue: QueueConfig{
			LiveWindow:     30 * time.Second,
			WaitTTL:        5 * time.Minute,
			MinPoll:        time.Second,
			MaxPoll:        10 * time.Second,
			SweepInterval:  time.Second,
			SegmentRefresh: 2 * time.Second,
		},
		RateLimit: RateLimitConfig{
			Enabled:        true,
			EnterPerMinute: 120,
			EnterBurst:     60,
			PollPerMinute:  600,
			PollBurst:      120,
		},
		Log: LogConfig{Level: "info", Format: "text"},
	}
}

// Load 는 설정 파일을 읽고 환경 변수 재정의를 적용한 뒤 검증한다.
//
// 환경 변수(파일보다 우선):
//
//	TRAFFICGATE_TOKEN_SECRET, TRAFFICGATE_SESSION_SECRET, TRAFFICGATE_REDIS_PASSWORD
func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("설정 파일을 읽을 수 없습니다: %w", err)
	}
	cfg, err := Parse(data)
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", path, err)
	}
	return cfg, nil
}

// Parse 는 YAML 설정을 해석하고 검증한다.
func Parse(data []byte) (Config, error) {
	cfg := Default()
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	// 빈 파일(io.EOF)은 기본값만 사용하는 것으로 본다.
	if err := dec.Decode(&cfg); err != nil && !errors.Is(err, io.EOF) {
		return Config{}, fmt.Errorf("설정 형식 오류: %w", err)
	}
	cfg.applyEnv()
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c *Config) applyEnv() {
	if v := os.Getenv("TRAFFICGATE_TOKEN_SECRET"); v != "" {
		c.Security.TokenSecret = v
	}
	if v := os.Getenv("TRAFFICGATE_SESSION_SECRET"); v != "" {
		c.Security.SessionSecret = v
	}
	if v := os.Getenv("TRAFFICGATE_REDIS_PASSWORD"); v != "" {
		c.Store.Redis.Password = v
	}
}

// Validate 는 설정 값을 검사한다.
func (c *Config) Validate() error {
	var errs []string
	add := func(format string, args ...any) { errs = append(errs, fmt.Sprintf(format, args...)) }

	if _, _, err := net.SplitHostPort(c.Server.Listen); err != nil {
		add("server.listen 형식 오류(%q): 예) 0.0.0.0:8800", c.Server.Listen)
	}
	if (c.Server.TLSCert == "") != (c.Server.TLSKey == "") {
		add("server.tls_cert 와 server.tls_key 는 함께 지정해야 합니다")
	}
	if _, err := c.TrustedPrefixes(); err != nil {
		add("server.trusted_proxies: %v", err)
	}
	if c.Server.GateBasePath != "" && (!strings.HasPrefix(c.Server.GateBasePath, "/") || strings.HasSuffix(c.Server.GateBasePath, "/")) {
		add("server.gate_base_path 는 / 로 시작하고 / 로 끝나지 않아야 합니다 (예: /__tg)")
	}
	switch c.Server.CookieSecure {
	case "auto", "always", "never":
	default:
		add("server.cookie_secure 는 auto, always, never 중 하나여야 합니다")
	}

	if c.Admin.Listen != "" {
		if _, _, err := net.SplitHostPort(c.Admin.Listen); err != nil {
			add("admin.listen 형식 오류(%q)", c.Admin.Listen)
		}
		if c.Admin.Listen == c.Server.Listen {
			add("admin.listen 은 server.listen 과 달라야 합니다")
		}
		if len(c.Admin.Users) == 0 && len(c.Admin.APITokens) == 0 {
			add("admin.users 또는 admin.api_tokens 가 하나 이상 필요합니다 (trafficgate init-config 로 생성)")
		}
		if (c.Admin.TLSCert == "") != (c.Admin.TLSKey == "") {
			add("admin.tls_cert 와 admin.tls_key 는 함께 지정해야 합니다")
		}
	}
	seen := map[string]bool{}
	for i, u := range c.Admin.Users {
		if u.Username == "" || seen[u.Username] {
			add("admin.users[%d]: username 이 비어 있거나 중복입니다", i)
		}
		seen[u.Username] = true
		if !auth.ValidHash(u.PasswordHash) {
			add("admin.users[%d] (%s): password_hash 형식 오류 — trafficgate hash-password 로 생성하세요", i, u.Username)
		}
	}
	for i, t := range c.Admin.APITokens {
		if len(t) < 24 {
			add("admin.api_tokens[%d]: 토큰은 24자 이상이어야 합니다", i)
		}
	}
	if c.Admin.SessionTTL < time.Minute {
		add("admin.session_ttl 은 1m 이상이어야 합니다")
	}

	if len(c.Security.TokenSecret) < 32 {
		add("security.token_secret 은 32자 이상이어야 합니다")
	}
	if c.Admin.Listen != "" && len(c.Security.SessionSecret) < 32 {
		add("security.session_secret 은 32자 이상이어야 합니다")
	}

	switch c.Store.Type {
	case "memory":
	case "redis":
		if len(c.Store.Redis.Addrs) == 0 {
			add("store.redis.addrs 가 비어 있습니다")
		}
	default:
		add("store.type 은 memory 또는 redis 여야 합니다 (%q)", c.Store.Type)
	}

	q := c.Queue
	if q.MinPoll < 200*time.Millisecond || q.MaxPoll < q.MinPoll || q.MaxPoll > time.Minute {
		add("queue.min_poll_interval(>=200ms) <= queue.max_poll_interval(<=1m) 이어야 합니다")
	}
	if q.LiveWindow < 2*q.MaxPoll {
		add("queue.live_window 는 max_poll_interval 의 2배 이상이어야 합니다 (현재 %s < 2×%s)", q.LiveWindow, q.MaxPoll)
	}
	if q.WaitTTL < q.LiveWindow {
		add("queue.wait_ttl 은 live_window 이상이어야 합니다")
	}
	if q.SweepInterval < 100*time.Millisecond || q.SweepInterval > 10*time.Second {
		add("queue.sweep_interval 은 100ms~10s 여야 합니다")
	}
	if q.SegmentRefresh < 500*time.Millisecond {
		add("queue.segment_refresh 는 500ms 이상이어야 합니다")
	}

	if c.RateLimit.Enabled && (c.RateLimit.EnterPerMinute <= 0 || c.RateLimit.PollPerMinute <= 0 ||
		c.RateLimit.EnterBurst <= 0 || c.RateLimit.PollBurst <= 0) {
		add("rate_limit 값은 모두 1 이상이어야 합니다")
	}

	switch c.Log.Level {
	case "debug", "info", "warn", "error":
	default:
		add("log.level 은 debug, info, warn, error 중 하나여야 합니다")
	}
	switch c.Log.Format {
	case "text", "json":
	default:
		add("log.format 은 text 또는 json 이어야 합니다")
	}

	ids := map[string]bool{}
	for i := range c.Segments {
		s := c.Segments[i]
		s.Normalize()
		if err := s.Validate(); err != nil {
			add("segments[%d]: %v", i, err)
		}
		if ids[s.ID] {
			add("segments[%d]: id %q 중복", i, s.ID)
		}
		ids[s.ID] = true
	}

	if len(errs) > 0 {
		return errors.New("설정 오류:\n  - " + strings.Join(errs, "\n  - "))
	}
	return nil
}

// TrustedPrefixes 는 신뢰할 프록시 대역을 해석한다.
func (c *Config) TrustedPrefixes() ([]netip.Prefix, error) {
	out := make([]netip.Prefix, 0, len(c.Server.TrustedProxies))
	for _, s := range c.Server.TrustedProxies {
		if !strings.Contains(s, "/") {
			a, err := netip.ParseAddr(s)
			if err != nil {
				return nil, fmt.Errorf("%q: %w", s, err)
			}
			out = append(out, netip.PrefixFrom(a, a.BitLen()))
			continue
		}
		p, err := netip.ParsePrefix(s)
		if err != nil {
			return nil, fmt.Errorf("%q: %w", s, err)
		}
		out = append(out, p.Masked())
	}
	return out, nil
}

// EngineConfig 는 대기열 엔진 설정으로 변환한다.
func (c *Config) EngineConfig() queue.EngineConfig {
	return queue.EngineConfig{
		LiveWindow:     c.Queue.LiveWindow,
		WaitTTL:        c.Queue.WaitTTL,
		MinPoll:        c.Queue.MinPoll,
		MaxPoll:        c.Queue.MaxPoll,
		SweepInterval:  c.Queue.SweepInterval,
		SegmentRefresh: c.Queue.SegmentRefresh,
	}
}
