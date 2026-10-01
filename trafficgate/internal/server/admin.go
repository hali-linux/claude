package server

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"time"

	"github.com/hali-linux/claude/trafficgate/internal/auth"
	"github.com/hali-linux/claude/trafficgate/internal/config"
	"github.com/hali-linux/claude/trafficgate/internal/queue"
	"github.com/hali-linux/claude/trafficgate/internal/version"
)

const adminCookie = "tg_admin"

type ctxKey int

const ctxUser ctxKey = 1

// AdminHandler 는 관리 콘솔/관리 API/메트릭 핸들러를 만든다.
func (s *Server) AdminHandler() http.Handler {
	mux := http.NewServeMux()
	static, err := fs.Sub(webFS, "web/admin")
	if err != nil {
		panic(err)
	}
	files := http.FileServer(http.FS(static))
	mux.Handle("GET /", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	}))

	mux.HandleFunc("POST /api/login", s.instrument("admin_login", s.handleLogin))
	mux.HandleFunc("POST /api/logout", s.instrument("admin_logout", s.handleLogout))
	mux.HandleFunc("GET /api/me", s.admin(s.handleMe))
	mux.HandleFunc("GET /api/system", s.admin(s.handleSystem))
	mux.HandleFunc("GET /api/stats", s.admin(s.handleStats))
	mux.HandleFunc("GET /api/segments", s.admin(s.handleListSegments))
	mux.HandleFunc("POST /api/segments", s.admin(s.handleCreateSegment))
	mux.HandleFunc("GET /api/segments/{id}", s.admin(s.handleGetSegment))
	mux.HandleFunc("PUT /api/segments/{id}", s.admin(s.handleUpdateSegment(false)))
	mux.HandleFunc("PATCH /api/segments/{id}", s.admin(s.handleUpdateSegment(true)))
	mux.HandleFunc("DELETE /api/segments/{id}", s.admin(s.handleDeleteSegment))
	mux.HandleFunc("POST /api/segments/{id}/reset", s.admin(s.handleResetSegment))
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	mux.HandleFunc("GET /healthz", s.handleHealth)
	return adminHeaders(mux)
}

func adminHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "+
			"connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		next.ServeHTTP(w, r)
	})
}

// authenticate 는 Bearer 토큰 또는 세션 쿠키로 관리자를 확인한다. viaCookie 는 쿠키 인증 여부이다.
func (s *Server) authenticate(r *http.Request) (user string, viaCookie bool, ok bool) {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		tok := strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
		for _, t := range s.cfg.Admin.APITokens {
			if subtle.ConstantTimeCompare([]byte(tok), []byte(t)) == 1 {
				return "api-token", false, true
			}
		}
		return "", false, false
	}
	c, err := r.Cookie(adminCookie)
	if err != nil || s.sessions == nil {
		return "", false, false
	}
	claims, err := s.sessions.Verify(c.Value, s.now())
	if err != nil {
		return "", false, false
	}
	u, found := s.findUser(claims.User)
	if !found || auth.Fingerprint(u.PasswordHash) != claims.HashFP {
		return "", false, false
	}
	return u.Username, true, true
}

func (s *Server) findUser(name string) (config.AdminUser, bool) {
	for _, u := range s.cfg.Admin.Users {
		if u.Username == name {
			return u, true
		}
	}
	return config.AdminUser{}, false
}

// admin 은 관리자 인증과 CSRF 방어를 적용한다.
// 쿠키로 인증된 변경 요청(POST/PUT/PATCH/DELETE)은 X-Requested-With 헤더와 같은 출처(Origin)를 요구한다.
func (s *Server) admin(h http.HandlerFunc) http.HandlerFunc {
	return s.instrument("admin_api", func(w http.ResponseWriter, r *http.Request) {
		user, viaCookie, ok := s.authenticate(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized", "로그인이 필요합니다")
			return
		}
		if viaCookie && r.Method != http.MethodGet && r.Method != http.MethodHead {
			if r.Header.Get("X-Requested-With") != "TrafficGate" || !sameOrigin(r) {
				writeError(w, http.StatusForbidden, "csrf", "허용되지 않은 요청입니다")
				return
			}
		}
		h(w, r.WithContext(context.WithValue(r.Context(), ctxUser, user)))
	})
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && u.Host == r.Host
}

func userOf(r *http.Request) string {
	u, _ := r.Context().Value(ctxUser).(string)
	return u
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !s.loginRL.Allow(clientIP(r, s.trusted), s.now()) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요")
		return
	}
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "csrf", "")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "")
		return
	}
	u, found := s.findUser(req.Username)
	if !found {
		auth.DummyCheck(req.Password)
	}
	if !found || !auth.CheckPassword(u.PasswordHash, req.Password) {
		s.log.Warn("관리자 로그인 실패", "user", req.Username, "ip", clientIP(r, s.trusted).String())
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "아이디 또는 비밀번호가 올바르지 않습니다")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     adminCookie,
		Value:    s.sessions.Issue(u.Username, u.PasswordHash, s.now()),
		Path:     "/",
		MaxAge:   int(s.cfg.Admin.SessionTTL / time.Second),
		HttpOnly: true,
		Secure:   r.TLS != nil || isHTTPS(r, s.trusted),
		SameSite: http.SameSiteStrictMode,
	})
	s.log.Info("관리자 로그인", "user", u.Username, "ip", clientIP(r, s.trusted).String())
	writeJSON(w, http.StatusOK, map[string]string{"username": u.Username})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: adminCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"username": userOf(r)})
}

func (s *Server) handleSystem(w http.ResponseWriter, r *http.Request) {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	storeOK := s.engine.Store().Ping(ctx) == nil
	writeJSON(w, http.StatusOK, map[string]any{
		"version":        version.Version,
		"commit":         version.Commit,
		"build_date":     version.Date,
		"go_version":     runtime.Version(),
		"store":          s.cfg.Store.Type,
		"store_ok":       storeOK,
		"public_listen":  s.cfg.Server.Listen,
		"gate_base_path": s.cfg.Server.GateBasePath,
		"uptime_sec":     int64(s.now().Sub(s.started).Seconds()),
		"goroutines":     runtime.NumGoroutine(),
		"heap_bytes":     ms.HeapAlloc,
		"live_window":    s.cfg.Queue.LiveWindow.String(),
		"wait_ttl":       s.cfg.Queue.WaitTTL.String(),
		"rate_limited":   s.limited.Load(),
	})
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"now":      s.now().UnixMilli(),
		"segments": s.engine.Stats(r.URL.Query().Get("series") != "0"),
	})
}

func (s *Server) handleListSegments(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.engine.Segments())
}

func (s *Server) handleGetSegment(w http.ResponseWriter, r *http.Request) {
	seg, ok := s.engine.Segment(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "segment_not_found", "")
		return
	}
	writeJSON(w, http.StatusOK, seg)
}

func decodeStrict(r io.Reader, v any) error {
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func (s *Server) saveSegment(w http.ResponseWriter, r *http.Request, seg queue.Segment, status int, action string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	saved, err := s.engine.SaveSegment(ctx, seg)
	if err != nil {
		if errors.Is(err, queue.ErrInvalidSegment) {
			writeError(w, http.StatusBadRequest, "invalid_segment", err.Error())
			return
		}
		s.log.Error("세그먼트 저장 실패", "segment", seg.ID, "err", err)
		writeError(w, http.StatusInternalServerError, "store_error", "저장소 오류")
		return
	}
	s.log.Info("세그먼트 변경", "action", action, "segment", saved.ID, "user", userOf(r),
		"mode", saved.Mode, "max_active", saved.MaxActive)
	writeJSON(w, status, saved)
}

func (s *Server) handleCreateSegment(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var seg queue.Segment
	if err := decodeStrict(r.Body, &seg); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	if _, exists := s.engine.Segment(strings.TrimSpace(seg.ID)); exists {
		writeError(w, http.StatusConflict, "segment_exists", "이미 존재하는 세그먼트 ID 입니다")
		return
	}
	s.saveSegment(w, r, seg, http.StatusCreated, "create")
}

// handleUpdateSegment 는 PUT(전체 교체) 또는 PATCH(보낸 필드만 변경)를 처리한다.
func (s *Server) handleUpdateSegment(partial bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		cur, ok := s.engine.Segment(id)
		if !ok {
			writeError(w, http.StatusNotFound, "segment_not_found", "")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_body", "")
			return
		}
		var seg queue.Segment
		if partial {
			seg = cur
			seg.URLPatterns = append([]string(nil), cur.URLPatterns...)
		}
		if err := decodeStrict(bytes.NewReader(body), &seg); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
			return
		}
		seg.ID = id
		action := "update"
		if partial {
			action = "patch"
		}
		s.saveSegment(w, r, seg, http.StatusOK, action)
	}
}

func (s *Server) handleDeleteSegment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.engine.DeleteSegment(ctx, id); err != nil {
		if errors.Is(err, queue.ErrNotFound) {
			writeError(w, http.StatusNotFound, "segment_not_found", "")
			return
		}
		writeError(w, http.StatusInternalServerError, "store_error", "저장소 오류")
		return
	}
	s.log.Info("세그먼트 삭제", "segment", id, "user", userOf(r))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleResetSegment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.engine.ResetSegment(ctx, id); err != nil {
		if errors.Is(err, queue.ErrNotFound) {
			writeError(w, http.StatusNotFound, "segment_not_found", "")
			return
		}
		writeError(w, http.StatusInternalServerError, "store_error", "저장소 오류")
		return
	}
	s.log.Warn("세그먼트 대기열 초기화", "segment", id, "user", userOf(r))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
