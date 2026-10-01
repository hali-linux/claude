package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hali-linux/claude/trafficgate/internal/auth"
	"github.com/hali-linux/claude/trafficgate/internal/config"
	"github.com/hali-linux/claude/trafficgate/internal/queue"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type env struct {
	t      *testing.T
	srv    *Server
	engine *queue.Engine
	clock  *fakeClock
	pub    http.Handler
	adm    http.Handler
	cfg    config.Config
}

var testHash = func() string {
	h, err := auth.HashPassword("s3cret-password")
	if err != nil {
		panic(err)
	}
	return h
}()

func newEnv(t *testing.T, mutate func(*config.Config)) *env {
	t.Helper()
	cfg := config.Default()
	cfg.Security.TokenSecret = strings.Repeat("t", 40)
	cfg.Security.SessionSecret = strings.Repeat("s", 40)
	cfg.Admin.Users = []config.AdminUser{{Username: "admin", PasswordHash: testHash}}
	cfg.Admin.APITokens = []string{strings.Repeat("a", 32)}
	cfg.Store.DataDir = ""
	if mutate != nil {
		mutate(&cfg)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	st, err := queue.NewMemoryStore("")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	eng, err := queue.NewEngine(context.Background(), st, cfg.EngineConfig(), log)
	if err != nil {
		t.Fatal(err)
	}
	clk := &fakeClock{t: time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)}
	eng.SetClock(clk.now)
	srv, err := New(cfg, eng, log)
	if err != nil {
		t.Fatal(err)
	}
	srv.SetClock(clk.now)
	return &env{t: t, srv: srv, engine: eng, clock: clk, pub: srv.PublicHandler(), adm: srv.AdminHandler(), cfg: cfg}
}

func (e *env) segment(s queue.Segment) queue.Segment {
	e.t.Helper()
	saved, err := e.engine.SaveSegment(context.Background(), s)
	if err != nil {
		e.t.Fatal(err)
	}
	return saved
}

type req struct {
	method, path, body string
	headers            map[string]string
	cookies            []*http.Cookie
	remote             string
}

func do(h http.Handler, r req) *httptest.ResponseRecorder {
	var body io.Reader
	if r.body != "" {
		body = strings.NewReader(r.body)
	}
	hr := httptest.NewRequest(r.method, r.path, body)
	if r.remote != "" {
		hr.RemoteAddr = r.remote
	}
	for k, v := range r.headers {
		hr.Header.Set(k, v)
	}
	for _, c := range r.cookies {
		hr.AddCookie(c)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, hr)
	return w
}

func decode[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %q: %v", w.Body.String(), err)
	}
	return v
}

func cookieNamed(w *httptest.ResponseRecorder, name string) *http.Cookie {
	for _, c := range w.Result().Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func TestQueueFlowAndVerify(t *testing.T) {
	e := newEnv(t, nil)
	e.segment(queue.Segment{ID: "sale", MaxActive: 1, Title: "세일 대기실"})

	w := do(e.pub, req{method: "POST", path: "/api/v1/segments/sale/enter?info=1"})
	if w.Code != 200 {
		t.Fatalf("enter status %d: %s", w.Code, w.Body)
	}
	first := decode[queue.Response](t, w)
	if first.Status != queue.StatusPass || first.Token == "" || first.TokenTTL != 600 || first.Info == nil || first.Info.Title != "세일 대기실" {
		t.Fatalf("first = %+v", first)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("API responses must not be cached")
	}

	second := decode[queue.Response](t, do(e.pub, req{method: "POST", path: "/api/v1/segments/sale/enter"}))
	if second.Status != queue.StatusWait || second.Position != 1 || second.Token != "" || second.Info != nil {
		t.Fatalf("second = %+v", second)
	}

	w = do(e.pub, req{method: "POST", path: "/api/v1/segments/sale/tickets/" + first.Ticket + "/complete"})
	if ok := decode[map[string]bool](t, w)["ok"]; !ok {
		t.Fatalf("complete failed: %s", w.Body)
	}
	polled := decode[queue.Response](t, do(e.pub, req{method: "POST", path: "/api/v1/segments/sale/tickets/" + second.Ticket + "/poll"}))
	if polled.Status != queue.StatusPass || polled.Token == "" {
		t.Fatalf("poll = %+v", polled)
	}
	w = do(e.pub, req{method: "POST", path: "/api/v1/segments/sale/tickets/" + second.Ticket + "/alive"})
	if !decode[map[string]bool](t, w)["ok"] {
		t.Fatalf("alive failed: %s", w.Body)
	}

	// 토큰 검증 API (JSON / 폼)
	w = do(e.pub, req{method: "POST", path: "/api/v1/verify", body: `{"token":"` + polled.Token + `","segment":"sale"}`,
		headers: map[string]string{"Content-Type": "application/json"}})
	v := decode[verifyResponse](t, w)
	if w.Code != 200 || !v.Valid || v.Ticket != second.Ticket {
		t.Fatalf("verify = %d %+v", w.Code, v)
	}
	w = do(e.pub, req{method: "POST", path: "/api/v1/verify", body: "token=" + url.QueryEscape(polled.Token) + "&segment=other",
		headers: map[string]string{"Content-Type": "application/x-www-form-urlencoded"}})
	if w.Code != 401 || decode[verifyResponse](t, w).Error != "segment_mismatch" {
		t.Fatalf("verify mismatch = %d %s", w.Code, w.Body)
	}
	e.clock.add(11 * time.Minute)
	w = do(e.pub, req{method: "POST", path: "/api/v1/verify", body: `{"token":"` + polled.Token + `"}`,
		headers: map[string]string{"Content-Type": "application/json"}})
	if w.Code != 401 || decode[verifyResponse](t, w).Error != "expired" {
		t.Fatalf("verify expired = %d %s", w.Code, w.Body)
	}
}

func TestPublicErrors(t *testing.T) {
	e := newEnv(t, nil)
	e.segment(queue.Segment{ID: "s", MaxActive: 1})
	if w := do(e.pub, req{method: "POST", path: "/api/v1/segments/nope/enter"}); w.Code != 404 {
		t.Fatalf("unknown segment: %d", w.Code)
	}
	if w := do(e.pub, req{method: "POST", path: "/api/v1/segments/s/tickets/bad!/poll"}); w.Code != 400 {
		t.Fatalf("bad ticket: %d", w.Code)
	}
	expired := decode[queue.Response](t, do(e.pub, req{method: "POST", path: "/api/v1/segments/s/tickets/" + queue.NewTicketID() + "/poll"}))
	if expired.Status != queue.StatusExpired {
		t.Fatalf("unknown ticket = %+v", expired)
	}
	if w := do(e.pub, req{method: "GET", path: "/api/v1/segments/s/enter"}); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET enter: %d", w.Code)
	}
	if w := do(e.pub, req{method: "GET", path: "/healthz"}); w.Code != 200 {
		t.Fatalf("healthz %d", w.Code)
	}
	if w := do(e.pub, req{method: "GET", path: "/readyz"}); w.Code != 200 {
		t.Fatalf("readyz %d", w.Code)
	}
	info := do(e.pub, req{method: "GET", path: "/api/v1/segments/s"})
	if info.Code != 200 || decode[queue.PublicInfo](t, info).ID != "s" {
		t.Fatalf("info: %d %s", info.Code, info.Body)
	}
}

func TestCORS(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.Server.CORSOrigins = []string{"https://shop.example.com"} })
	e.segment(queue.Segment{ID: "s", MaxActive: 1})
	w := do(e.pub, req{method: "POST", path: "/api/v1/segments/s/enter", headers: map[string]string{"Origin": "https://shop.example.com"}})
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://shop.example.com" {
		t.Fatalf("allowed origin header = %q", got)
	}
	w = do(e.pub, req{method: "POST", path: "/api/v1/segments/s/enter", headers: map[string]string{"Origin": "https://evil.example"}})
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("disallowed origin got header %q", got)
	}
	w = do(e.pub, req{method: "OPTIONS", path: "/api/v1/segments/s/enter", headers: map[string]string{"Origin": "https://shop.example.com"}})
	if w.Code != 204 || w.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Fatalf("preflight %d %v", w.Code, w.Header())
	}
}

func TestRateLimit(t *testing.T) {
	e := newEnv(t, func(c *config.Config) {
		c.RateLimit.EnterPerMinute = 1
		c.RateLimit.EnterBurst = 2
	})
	e.segment(queue.Segment{ID: "s", MaxActive: 100})
	for i := 0; i < 2; i++ {
		if w := do(e.pub, req{method: "POST", path: "/api/v1/segments/s/enter", remote: "203.0.113.9:1234"}); w.Code != 200 {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
	w := do(e.pub, req{method: "POST", path: "/api/v1/segments/s/enter", remote: "203.0.113.9:1234"})
	if w.Code != 429 || decode[map[string]any](t, w)["status"] != "RATE_LIMITED" {
		t.Fatalf("3rd request: %d %s", w.Code, w.Body)
	}
	// 다른 IP 는 영향 없음
	if w := do(e.pub, req{method: "POST", path: "/api/v1/segments/s/enter", remote: "203.0.113.10:1234"}); w.Code != 200 {
		t.Fatalf("other ip: %d", w.Code)
	}
	// 신뢰 프록시(127.0.0.1) 뒤의 실제 IP 기준으로 제한
	hdr := map[string]string{"X-Forwarded-For": "203.0.113.9"}
	if w := do(e.pub, req{method: "POST", path: "/api/v1/segments/s/enter", remote: "127.0.0.1:5555", headers: hdr}); w.Code != 429 {
		t.Fatalf("via proxy: %d", w.Code)
	}
	e.clock.add(time.Minute)
	if w := do(e.pub, req{method: "POST", path: "/api/v1/segments/s/enter", remote: "203.0.113.9:1234"}); w.Code != 200 {
		t.Fatalf("after refill: %d", w.Code)
	}
}

func TestClientIP(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8")}
	cases := []struct {
		remote, xff, want string
	}{
		{"198.51.100.1:1", "1.2.3.4", "198.51.100.1"},            // 신뢰하지 않는 직접 연결은 XFF 무시
		{"127.0.0.1:1", "1.2.3.4", "1.2.3.4"},                    // nginx 뒤
		{"127.0.0.1:1", "6.6.6.6, 1.2.3.4, 10.0.0.5", "1.2.3.4"}, // 위조된 왼쪽 값 무시
		{"127.0.0.1:1", "", "127.0.0.1"},
		{"[::ffff:127.0.0.1]:1", "1.2.3.4", "1.2.3.4"},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.remote
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := clientIP(r, trusted).String(); got != c.want {
			t.Errorf("clientIP(%s, %q) = %s, want %s", c.remote, c.xff, got, c.want)
		}
	}
}

func TestGateFlow(t *testing.T) {
	e := newEnv(t, nil)
	e.segment(queue.Segment{ID: "evt", MaxActive: 1, URLPatterns: []string{"/event/*"}, Title: "이벤트 대기"})

	auth := func(uri string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
		return do(e.pub, req{method: "GET", path: "/gate/auth", headers: map[string]string{"X-Original-URI": uri}, cookies: cookies})
	}
	if w := auth("/other"); w.Code != 204 {
		t.Fatalf("unprotected path: %d", w.Code)
	}
	w := auth("/event/1?x=1")
	if w.Code != 401 || w.Header().Get("X-TrafficGate-Segment") != "evt" {
		t.Fatalf("protected without cookie: %d %v", w.Code, w.Header())
	}

	// nginx 가 원래 요청을 대기 헤더와 함께 넘기면 대기 화면 HTML
	page := do(e.pub, req{method: "GET", path: "/event/1?x=1", headers: map[string]string{
		"X-TrafficGate-Wait": "1", "X-Original-URI": "/event/1?x=1", "Accept": "text/html,application/xhtml+xml",
	}})
	body := page.Body.String()
	if page.Code != 200 || !strings.Contains(body, `src="/__tg/trafficgate.js"`) ||
		!strings.Contains(body, `"segment":"evt"`) || !strings.Contains(body, `"returnURL":"/event/1?x=1"`) ||
		!strings.Contains(body, "<title>이벤트 대기</title>") {
		t.Fatalf("wait page %d: %s", page.Code, body)
	}
	if !strings.Contains(page.Header().Get("Content-Security-Policy"), "script-src 'self'") {
		t.Fatal("wait page must send CSP")
	}
	// XHR 요청에는 JSON 429
	api := do(e.pub, req{method: "GET", path: "/event/api", headers: map[string]string{"X-TrafficGate-Wait": "1", "Accept": "application/json"}})
	if api.Code != 429 || decode[map[string]string](t, api)["status"] != "WAIT" {
		t.Fatalf("xhr wait: %d %s", api.Code, api.Body)
	}

	// 대기 화면 JS 와 같은 흐름: set_cookie=1 로 진입 → HttpOnly 통과 쿠키 발급
	w = do(e.pub, req{method: "POST", path: "/api/v1/segments/evt/enter?set_cookie=1", remote: "127.0.0.1:9",
		headers: map[string]string{"X-Forwarded-Proto": "https"}})
	c := cookieNamed(w, "tg_evt")
	if c == nil || !c.HttpOnly || !c.Secure || c.Path != "/" || c.MaxAge != 600 || c.SameSite != http.SameSiteLaxMode {
		t.Fatalf("pass cookie = %+v", c)
	}
	if w := auth("/event/1", c); w.Code != 204 {
		t.Fatalf("with cookie: %d", w.Code)
	}
	// 다른 세그먼트 쿠키는 통하지 않음
	forged := &http.Cookie{Name: "tg_evt", Value: e.srv.signer.Issue("other", "", e.clock.now(), time.Hour)}
	if w := auth("/event/1", forged); w.Code != 401 {
		t.Fatalf("cross-segment cookie accepted: %d", w.Code)
	}
	// 대기 상태에서는 쿠키 없음
	w = do(e.pub, req{method: "POST", path: "/api/v1/segments/evt/enter?set_cookie=1"})
	if cookieNamed(w, "tg_evt") != nil {
		t.Fatal("cookie set while waiting")
	}

	// 차단 모드는 쿠키가 있어도 401, 제어 해제는 쿠키 없이도 204
	s, _ := e.engine.Segment("evt")
	s.Mode = queue.ModeBlock
	e.segment(s)
	if w := auth("/event/1", c); w.Code != 401 {
		t.Fatalf("block with cookie: %d", w.Code)
	}
	s.Mode = queue.ModeBypass
	e.segment(s)
	if w := auth("/event/1"); w.Code != 204 {
		t.Fatalf("bypass: %d", w.Code)
	}
	// 명시적 세그먼트 지정
	if w := do(e.pub, req{method: "GET", path: "/gate/auth?segment=missing"}); w.Code != 204 {
		t.Fatalf("unknown explicit segment should fail open: %d", w.Code)
	}
}

func TestGateWaitReturnURLIsSafe(t *testing.T) {
	e := newEnv(t, nil)
	e.segment(queue.Segment{ID: "s", MaxActive: 1})
	for _, ret := range []string{"//evil.example/x", "https://evil.example", "/\\evil", "javascript:alert(1)"} {
		w := do(e.pub, req{method: "GET", path: "/gate/wait?segment=s&return=" + url.QueryEscape(ret), headers: map[string]string{"Accept": "text/html"}})
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"returnURL":"/"`) {
			t.Errorf("return %q not neutralized: %s", ret, w.Body)
		}
	}
	w := do(e.pub, req{method: "GET", path: "/gate/wait?segment=s&return=/ok%3Fa%3D%3Cb%3E", headers: map[string]string{"Accept": "text/html"}})
	escaped := `"returnURL":"/ok?a=\u003cb\u003e"`
	if !strings.Contains(w.Body.String(), escaped) || strings.Contains(w.Body.String(), "<b>") {
		t.Errorf("html in return url must be escaped: %s", w.Body)
	}
}

func TestAgentAndRoot(t *testing.T) {
	e := newEnv(t, nil)
	w := do(e.pub, req{method: "GET", path: "/trafficgate.js"})
	if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Type"), "javascript") || !strings.Contains(w.Body.String(), "TrafficGate") {
		t.Fatalf("agent: %d %v", w.Code, w.Header())
	}
	etag := w.Header().Get("ETag")
	if w := do(e.pub, req{method: "GET", path: "/trafficgate.js", headers: map[string]string{"If-None-Match": etag}}); w.Code != 304 {
		t.Fatalf("etag: %d", w.Code)
	}
	if w := do(e.pub, req{method: "GET", path: "/"}); w.Code != 200 || !strings.HasPrefix(w.Body.String(), "TrafficGate") {
		t.Fatalf("root: %d", w.Code)
	}
}

func login(t *testing.T, e *env) *http.Cookie {
	t.Helper()
	w := do(e.adm, req{method: "POST", path: "/api/login", body: `{"username":"admin","password":"s3cret-password"}`,
		headers: map[string]string{"Content-Type": "application/json"}})
	if w.Code != 200 {
		t.Fatalf("login: %d %s", w.Code, w.Body)
	}
	c := cookieNamed(w, adminCookie)
	if c == nil || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode {
		t.Fatalf("admin cookie = %+v", c)
	}
	return c
}

func TestAdminAuthAndCSRF(t *testing.T) {
	e := newEnv(t, nil)
	if w := do(e.adm, req{method: "GET", path: "/api/segments"}); w.Code != 401 {
		t.Fatalf("unauthenticated: %d", w.Code)
	}
	w := do(e.adm, req{method: "POST", path: "/api/login", body: `{"username":"admin","password":"wrong"}`})
	if w.Code != 401 {
		t.Fatalf("wrong password: %d", w.Code)
	}
	if w := do(e.adm, req{method: "POST", path: "/api/login", body: `{"username":"ghost","password":"x"}`}); w.Code != 401 {
		t.Fatalf("unknown user: %d", w.Code)
	}
	c := login(t, e)
	if w := do(e.adm, req{method: "GET", path: "/api/me", cookies: []*http.Cookie{c}}); w.Code != 200 || decode[map[string]string](t, w)["username"] != "admin" {
		t.Fatalf("me: %d %s", w.Code, w.Body)
	}
	body := `{"id":"new","max_active":10}`
	// X-Requested-With 없는 쿠키 기반 변경 요청은 거부 (CSRF)
	if w := do(e.adm, req{method: "POST", path: "/api/segments", body: body, cookies: []*http.Cookie{c}}); w.Code != 403 {
		t.Fatalf("csrf not blocked: %d", w.Code)
	}
	// 다른 출처
	if w := do(e.adm, req{method: "POST", path: "/api/segments", body: body, cookies: []*http.Cookie{c},
		headers: map[string]string{"X-Requested-With": "TrafficGate", "Origin": "https://evil.example"}}); w.Code != 403 {
		t.Fatalf("cross-origin not blocked: %d", w.Code)
	}
	if w := do(e.adm, req{method: "POST", path: "/api/segments", body: body, cookies: []*http.Cookie{c},
		headers: map[string]string{"X-Requested-With": "TrafficGate"}}); w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	// API 토큰은 CSRF 헤더 없이 사용 가능
	bearer := map[string]string{"Authorization": "Bearer " + strings.Repeat("a", 32)}
	if w := do(e.adm, req{method: "PATCH", path: "/api/segments/new", body: `{"max_active":42}`, headers: bearer}); w.Code != 200 ||
		decode[queue.Segment](t, w).MaxActive != 42 {
		t.Fatalf("patch via token: %d %s", w.Code, w.Body)
	}
	if w := do(e.adm, req{method: "GET", path: "/api/segments", headers: map[string]string{"Authorization": "Bearer wrong-token-wrong-token-wrong"}}); w.Code != 401 {
		t.Fatalf("bad token: %d", w.Code)
	}
	// 세션 위조/만료
	if w := do(e.adm, req{method: "GET", path: "/api/me", cookies: []*http.Cookie{{Name: adminCookie, Value: c.Value + "x"}}}); w.Code != 401 {
		t.Fatalf("tampered session: %d", w.Code)
	}
	e.clock.add(13 * time.Hour)
	if w := do(e.adm, req{method: "GET", path: "/api/me", cookies: []*http.Cookie{c}}); w.Code != 401 {
		t.Fatalf("expired session: %d", w.Code)
	}
	// 보안 헤더
	w = do(e.adm, req{method: "GET", path: "/"})
	if w.Code != 200 || w.Header().Get("X-Frame-Options") != "DENY" || !strings.Contains(w.Body.String(), "TrafficGate") {
		t.Fatalf("admin index: %d %v", w.Code, w.Header())
	}
}

func TestSessionInvalidatedOnPasswordChange(t *testing.T) {
	e := newEnv(t, nil)
	c := login(t, e)
	newHash, _ := auth.HashPassword("another-password")
	e.srv.cfg.Admin.Users[0].PasswordHash = newHash
	if w := do(e.adm, req{method: "GET", path: "/api/me", cookies: []*http.Cookie{c}}); w.Code != 401 {
		t.Fatalf("old session should be invalid: %d", w.Code)
	}
}

func TestAdminSegmentCRUD(t *testing.T) {
	e := newEnv(t, nil)
	h := map[string]string{"Authorization": "Bearer " + strings.Repeat("a", 32)}
	w := do(e.adm, req{method: "POST", path: "/api/segments", headers: h,
		body: `{"id":"evt","name":"이벤트","max_active":5,"url_patterns":["/event/*"],"open_at":"2026-10-01T10:00:00+09:00"}`})
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	created := decode[queue.Segment](t, w)
	if created.Mode != queue.ModeQueue || created.ActiveTTL != 30 || created.OpenAt == nil {
		t.Fatalf("created = %+v", created)
	}
	if w := do(e.adm, req{method: "POST", path: "/api/segments", headers: h, body: `{"id":"evt","max_active":1}`}); w.Code != 409 {
		t.Fatalf("duplicate: %d", w.Code)
	}
	if w := do(e.adm, req{method: "POST", path: "/api/segments", headers: h, body: `{"id":"bad id","max_active":1}`}); w.Code != 400 {
		t.Fatalf("invalid: %d", w.Code)
	}
	if w := do(e.adm, req{method: "POST", path: "/api/segments", headers: h, body: `{"id":"x","unknown":1}`}); w.Code != 400 {
		t.Fatalf("unknown field: %d", w.Code)
	}
	// PATCH 는 보낸 필드만 변경, open_at 을 null 로 지울 수 있음
	w = do(e.adm, req{method: "PATCH", path: "/api/segments/evt", headers: h, body: `{"mode":"block","open_at":null}`})
	p := decode[queue.Segment](t, w)
	if w.Code != 200 || p.Mode != queue.ModeBlock || p.MaxActive != 5 || p.Name != "이벤트" || p.OpenAt != nil || len(p.URLPatterns) != 1 {
		t.Fatalf("patch: %d %+v", w.Code, p)
	}
	// PUT 은 전체 교체
	w = do(e.adm, req{method: "PUT", path: "/api/segments/evt", headers: h, body: `{"max_active":7}`})
	p = decode[queue.Segment](t, w)
	if w.Code != 200 || p.Mode != queue.ModeQueue || p.Name != "evt" || len(p.URLPatterns) != 0 {
		t.Fatalf("put: %d %+v", w.Code, p)
	}
	if w := do(e.adm, req{method: "PUT", path: "/api/segments/none", headers: h, body: `{}`}); w.Code != 404 {
		t.Fatalf("put missing: %d", w.Code)
	}

	do(e.pub, req{method: "POST", path: "/api/v1/segments/evt/enter"})
	e.engine.Tick(context.Background())
	w = do(e.adm, req{method: "GET", path: "/api/stats", headers: h})
	stats := decode[struct {
		Segments []queue.SegmentStats `json:"segments"`
	}](t, w)
	if len(stats.Segments) != 1 || stats.Segments[0].Active != 1 || len(stats.Segments[0].Series) == 0 {
		t.Fatalf("stats: %s", w.Body)
	}
	if w := do(e.adm, req{method: "POST", path: "/api/segments/evt/reset", headers: h}); w.Code != 200 {
		t.Fatalf("reset: %d", w.Code)
	}
	e.engine.Tick(context.Background())
	st, _ := e.engine.StatsFor("evt", false)
	if st.Active != 0 {
		t.Fatalf("active after reset = %d", st.Active)
	}

	m := do(e.adm, req{method: "GET", path: "/metrics"})
	if m.Code != 200 || !strings.Contains(m.Body.String(), `trafficgate_max_active{segment="evt"} 7`) ||
		!strings.Contains(m.Body.String(), `trafficgate_admitted_total{segment="evt"} 1`) ||
		!strings.Contains(m.Body.String(), `trafficgate_http_requests_total{route="enter",code="200"} 1`) {
		t.Fatalf("metrics: %s", m.Body)
	}
	if w := do(e.adm, req{method: "GET", path: "/api/system", headers: h}); w.Code != 200 || decode[map[string]any](t, w)["store"] != "memory" {
		t.Fatalf("system: %d %s", w.Code, w.Body)
	}

	if w := do(e.adm, req{method: "DELETE", path: "/api/segments/evt", headers: h}); w.Code != 200 {
		t.Fatalf("delete: %d", w.Code)
	}
	if w := do(e.adm, req{method: "DELETE", path: "/api/segments/evt", headers: h}); w.Code != 404 {
		t.Fatalf("delete again: %d", w.Code)
	}
}

func TestMetricsAuth(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.Admin.MetricsPublic = false })
	if w := do(e.adm, req{method: "GET", path: "/metrics"}); w.Code != 401 {
		t.Fatalf("metrics without auth: %d", w.Code)
	}
	if w := do(e.adm, req{method: "GET", path: "/metrics", headers: map[string]string{"Authorization": "Bearer " + strings.Repeat("a", 32)}}); w.Code != 200 {
		t.Fatalf("metrics with token: %d", w.Code)
	}
}
