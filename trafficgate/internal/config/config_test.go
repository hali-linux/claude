package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hali-linux/claude/trafficgate/internal/auth"
)

func testHash(t *testing.T) string {
	t.Helper()
	h, err := auth.HashPassword("admin-password")
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func renderDefault(t *testing.T) []byte {
	t.Helper()
	data, err := Render(TemplateData{
		Listen: "0.0.0.0:8800", AdminListen: "127.0.0.1:8801", GateBasePath: "/__tg",
		StoreType: "memory", DataDir: "/var/lib/trafficgate",
		TokenSecret: strings.Repeat("t", 43), SessionSecret: strings.Repeat("s", 43),
		AdminUser: "admin", AdminHash: testHash(t),
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestRenderedTemplateIsValid(t *testing.T) {
	cfg, err := Parse(renderDefault(t))
	if err != nil {
		t.Fatalf("rendered config invalid: %v", err)
	}
	if cfg.Server.Listen != "0.0.0.0:8800" || cfg.Admin.Users[0].Username != "admin" {
		t.Fatalf("unexpected cfg: %+v", cfg)
	}
	if cfg.Queue.LiveWindow != 30*time.Second || cfg.Queue.WaitTTL != 5*time.Minute {
		t.Fatalf("durations not parsed: %+v", cfg.Queue)
	}
	if len(cfg.Segments) != 1 || cfg.Segments[0].MaxActive != 100 || cfg.Segments[0].Title == "" {
		t.Fatalf("segments = %+v", cfg.Segments)
	}
	if cfg.Store.Redis.Addrs[0] != "127.0.0.1:6379" {
		t.Fatalf("redis addrs = %v", cfg.Store.Redis.Addrs)
	}
}

func TestLoadFileAndEnvOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, renderDefault(t), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TRAFFICGATE_TOKEN_SECRET", strings.Repeat("e", 40))
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Security.TokenSecret != strings.Repeat("e", 40) {
		t.Fatal("env override not applied")
	}
	if _, err := Load(filepath.Join(t.TempDir(), "missing.yaml")); err == nil {
		t.Fatal("missing file accepted")
	}
}

func TestValidationErrors(t *testing.T) {
	base := string(renderDefault(t))
	cases := map[string]string{
		"unknown field":   base + "\nunknown_key: 1\n",
		"bad store":       strings.Replace(base, `type: "memory"`, `type: "mysql"`, 1),
		"short secret":    strings.Replace(base, strings.Repeat("t", 43), "short", 1),
		"bad listen":      strings.Replace(base, `listen: "0.0.0.0:8800"`, `listen: "8800"`, 1),
		"same listen":     strings.Replace(base, `listen: "127.0.0.1:8801"`, `listen: "0.0.0.0:8800"`, 1),
		"live < 2xpoll":   strings.Replace(base, "live_window: 30s", "live_window: 5s", 1),
		"bad hash":        strings.Replace(base, `password_hash: "pbkdf2`, `password_hash: "plain`, 1),
		"bad segment":     strings.Replace(base, "max_active: 100", "max_active: -5", 1),
		"bad proxy":       strings.Replace(base, `"127.0.0.1/32"`, `"not-an-ip"`, 1),
		"bad base path":   strings.Replace(base, `gate_base_path: "/__tg"`, `gate_base_path: "__tg/"`, 1),
		"bad log level":   strings.Replace(base, "level: info", "level: verbose", 1),
		"bad cookie mode": strings.Replace(base, `cookie_secure: "auto"`, `cookie_secure: "yes"`, 1),
	}
	for name, doc := range cases {
		if doc == base {
			t.Fatalf("%s: replacement did not apply", name)
		}
		if _, err := Parse([]byte(doc)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestTrustedPrefixes(t *testing.T) {
	c := Default()
	c.Server.TrustedProxies = []string{"10.0.0.0/8", "192.168.1.10", "::1/128"}
	ps, err := c.TrustedPrefixes()
	if err != nil || len(ps) != 3 || ps[1].Bits() != 32 {
		t.Fatalf("prefixes = %v err=%v", ps, err)
	}
}
