package server

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/hali-linux/claude/trafficgate/internal/queue"
	"github.com/hali-linux/claude/trafficgate/internal/token"
	"github.com/hali-linux/claude/trafficgate/internal/version"
)

//go:embed web
var webFS embed.FS

var (
	agentJS   []byte
	agentETag string
)

func init() {
	var err error
	agentJS, err = webFS.ReadFile("web/trafficgate.js")
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(agentJS)
	agentETag = `"` + hex.EncodeToString(sum[:8]) + `"`
}

// CookieName 은 세그먼트별 통과 쿠키 이름이다.
func CookieName(segID string) string { return "tg_" + segID }

// PublicHandler 는 공개 서버 핸들러를 만든다.
func (s *Server) PublicHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/segments/{seg}/enter", s.instrument("enter", s.handleEnter))
	mux.HandleFunc("POST /api/v1/segments/{seg}/tickets/{ticket}/poll", s.instrument("poll", s.handlePoll))
	mux.HandleFunc("POST /api/v1/segments/{seg}/tickets/{ticket}/alive", s.instrument("alive", s.handleAlive))
	mux.HandleFunc("POST /api/v1/segments/{seg}/tickets/{ticket}/complete", s.instrument("complete", s.handleComplete))
	mux.HandleFunc("GET /api/v1/segments/{seg}", s.instrument("info", s.handleInfo))
	mux.HandleFunc("POST /api/v1/verify", s.instrument("verify", s.handleVerify))
	mux.HandleFunc("OPTIONS /api/", s.handlePreflight)
	mux.HandleFunc("GET /trafficgate.js", s.instrument("agent", s.handleAgent))
	mux.HandleFunc("GET /gate/auth", s.instrument("gate_auth", s.handleGateAuth))
	mux.HandleFunc("GET /gate/wait", s.instrument("gate_wait", s.handleGateWait))
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /readyz", s.handleReady)
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, "TrafficGate "+version.Version+"\n")
	})
	return s.gateWaitMiddleware(mux)
}

// cors 는 허용된 Origin 에 대해 CORS 헤더를 붙인다. 대기열 API 는 쿠키 없이 호출되므로 자격 증명은 허용하지 않는다.
func (s *Server) cors(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	h := w.Header()
	h.Add("Vary", "Origin")
	if slices.Contains(s.cfg.Server.CORSOrigins, "*") {
		h.Set("Access-Control-Allow-Origin", "*")
		return
	}
	if slices.Contains(s.cfg.Server.CORSOrigins, origin) {
		h.Set("Access-Control-Allow-Origin", origin)
	}
}

func (s *Server) handlePreflight(w http.ResponseWriter, r *http.Request) {
	s.cors(w, r)
	h := w.Header()
	h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type")
	h.Set("Access-Control-Max-Age", "86400")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) ctx(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), 5*time.Second)
}

func (s *Server) rateLimited(w http.ResponseWriter, r *http.Request, rl *rateLimiter) bool {
	if rl.Allow(clientIP(r, s.trusted), s.now()) {
		return false
	}
	s.limited.Add(1)
	w.Header().Set("Retry-After", "5")
	writeJSON(w, http.StatusTooManyRequests, map[string]any{
		"status": "RATE_LIMITED", "error": "rate_limited", "next_poll_ms": 5000,
	})
	return true
}

func (s *Server) queueError(w http.ResponseWriter, err error, seg string) {
	if errors.Is(err, queue.ErrNotFound) {
		writeError(w, http.StatusNotFound, "segment_not_found", "세그먼트를 찾을 수 없습니다: "+seg)
		return
	}
	s.log.Error("대기열 처리 실패", "segment", seg, "err", err)
	w.Header().Set("Retry-After", "2")
	writeError(w, http.StatusServiceUnavailable, "unavailable", "일시적으로 처리할 수 없습니다")
}

// finish 는 응답에 통과 토큰/쿠키/세그먼트 정보를 붙여 전송한다.
func (s *Server) finish(w http.ResponseWriter, r *http.Request, resp *queue.Response) {
	seg, _ := s.engine.Segment(resp.Segment)
	q := r.URL.Query()
	if resp.Status == queue.StatusPass {
		ttl := time.Duration(seg.PassTTL) * time.Second
		resp.Token = s.signer.Issue(seg.ID, resp.Ticket, s.now(), ttl)
		resp.TokenTTL = seg.PassTTL
		if q.Get("set_cookie") == "1" {
			s.setPassCookie(w, r, seg, resp.Token)
		}
	}
	if q.Get("info") == "1" {
		resp.Info = seg.Info()
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) setPassCookie(w http.ResponseWriter, r *http.Request, seg queue.Segment, tok string) {
	secure := false
	switch s.cfg.Server.CookieSecure {
	case "always":
		secure = true
	case "auto":
		secure = isHTTPS(r, s.trusted)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName(seg.ID),
		Value:    tok,
		Path:     "/",
		Domain:   s.cfg.Server.CookieDomain,
		MaxAge:   seg.PassTTL,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) handleEnter(w http.ResponseWriter, r *http.Request) {
	s.cors(w, r)
	if s.rateLimited(w, r, s.enterRL) {
		return
	}
	segID := r.PathValue("seg")
	ctx, cancel := s.ctx(r)
	defer cancel()
	resp, err := s.engine.Enter(ctx, segID)
	if err != nil {
		s.queueError(w, err, segID)
		return
	}
	s.finish(w, r, &resp)
}

func (s *Server) ticketParams(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	segID, ticket := r.PathValue("seg"), r.PathValue("ticket")
	if !queue.ValidTicketID(ticket) {
		writeError(w, http.StatusBadRequest, "invalid_ticket", "티켓 형식이 올바르지 않습니다")
		return "", "", false
	}
	return segID, ticket, true
}

func (s *Server) handlePoll(w http.ResponseWriter, r *http.Request) {
	s.cors(w, r)
	if s.rateLimited(w, r, s.pollRL) {
		return
	}
	segID, ticket, ok := s.ticketParams(w, r)
	if !ok {
		return
	}
	ctx, cancel := s.ctx(r)
	defer cancel()
	resp, err := s.engine.Poll(ctx, segID, ticket)
	if err != nil {
		s.queueError(w, err, segID)
		return
	}
	s.finish(w, r, &resp)
}

func (s *Server) handleAlive(w http.ResponseWriter, r *http.Request) {
	s.cors(w, r)
	if s.rateLimited(w, r, s.pollRL) {
		return
	}
	segID, ticket, ok := s.ticketParams(w, r)
	if !ok {
		return
	}
	ctx, cancel := s.ctx(r)
	defer cancel()
	alive, err := s.engine.Alive(ctx, segID, ticket)
	if err != nil {
		s.queueError(w, err, segID)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": alive})
}

func (s *Server) handleComplete(w http.ResponseWriter, r *http.Request) {
	s.cors(w, r)
	segID, ticket, ok := s.ticketParams(w, r)
	if !ok {
		return
	}
	ctx, cancel := s.ctx(r)
	defer cancel()
	done, err := s.engine.Complete(ctx, segID, ticket)
	if err != nil {
		s.queueError(w, err, segID)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": done})
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	s.cors(w, r)
	seg, ok := s.engine.Segment(r.PathValue("seg"))
	if !ok {
		writeError(w, http.StatusNotFound, "segment_not_found", "")
		return
	}
	writeJSON(w, http.StatusOK, seg.Info())
}

type verifyResponse struct {
	Valid     bool   `json:"valid"`
	Segment   string `json:"segment,omitempty"`
	Ticket    string `json:"ticket,omitempty"`
	ExpiresAt int64  `json:"expires_at,omitempty"`
	Error     string `json:"error,omitempty"`
}

// handleVerify 는 백엔드 서버가 통과 토큰을 검증할 때 사용한다.
// 본문: {"token":"...","segment":"..."} (JSON) 또는 token=...&segment=... (폼)
// 유효하면 200, 아니면 401.
func (s *Server) handleVerify(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req struct {
		Token   string `json:"token"`
		Segment string `json:"segment"`
	}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_json", "")
			return
		}
	} else {
		if err := r.ParseForm(); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_form", "")
			return
		}
		req.Token, req.Segment = r.Form.Get("token"), r.Form.Get("segment")
	}
	c, err := s.signer.Verify(req.Token, req.Segment, s.now())
	if err != nil {
		code := "invalid"
		switch {
		case errors.Is(err, token.ErrExpired):
			code = "expired"
		case errors.Is(err, token.ErrSegment):
			code = "segment_mismatch"
		}
		writeJSON(w, http.StatusUnauthorized, verifyResponse{Valid: false, Error: code})
		return
	}
	writeJSON(w, http.StatusOK, verifyResponse{Valid: true, Segment: c.Segment, Ticket: c.Ticket, ExpiresAt: c.Expires})
}

func (s *Server) handleAgent(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "application/javascript; charset=utf-8")
	h.Set("Cache-Control", "public, max-age=300")
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("ETag", agentETag)
	if r.Header.Get("If-None-Match") == agentETag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = w.Write(agentJS)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": version.Version})
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if !s.ready.Load() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "stopping"})
		return
	}
	if err := s.engine.Store().Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "store_unavailable", "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}
