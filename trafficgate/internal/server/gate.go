package server

import (
	"encoding/json"
	"html/template"
	"net/http"
	"net/url"
	"strings"

	"github.com/hali-linux/claude/trafficgate/internal/queue"
)

// nginx 게이트 연동
//
//	location / {
//	    auth_request /__tg_auth;            # → GET /gate/auth  (204 통과 / 401 대기 필요)
//	    error_page 401 = @trafficgate_wait; # → 원래 요청을 X-TrafficGate-Wait 헤더와 함께 프록시
//	    proxy_pass http://backend;
//	}
//
// 대기 화면은 원래 URL 그대로 표시되며, 입장 차례가 되면 HttpOnly 통과 쿠키(tg_<세그먼트>)를 받고
// 같은 URL 을 다시 불러온다.

const (
	headerWait    = "X-TrafficGate-Wait"
	headerSegment = "X-TrafficGate-Segment"
	headerBase    = "X-TrafficGate-Base"
	headerOrigURI = "X-Original-URI"
)

// gateWaitMiddleware 는 nginx 가 X-TrafficGate-Wait 헤더를 붙여 넘긴 요청에 경로와 무관하게 대기 화면을 보여준다.
func (s *Server) gateWaitMiddleware(next http.Handler) http.Handler {
	waitHandler := s.instrument("gate_wait", func(w http.ResponseWriter, r *http.Request) {
		uri := r.Header.Get(headerOrigURI)
		if uri == "" {
			uri = r.URL.RequestURI()
		}
		s.serveWaitPage(w, r, r.Header.Get(headerSegment), uri)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(headerWait) != "" {
			waitHandler(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// resolveSegment 는 명시된 세그먼트 ID 또는 URL 패턴으로 세그먼트를 찾는다.
func (s *Server) resolveSegment(segID, uri string) (queue.Segment, bool) {
	if segID != "" {
		return s.engine.Segment(segID)
	}
	return s.engine.MatchURL(uri)
}

// handleGateAuth 는 nginx auth_request 서브요청을 처리한다.
//   - ?segment=ID 로 세그먼트를 지정하거나, 생략하면 X-Original-URI 를 세그먼트 url_patterns 와 매칭한다.
//   - 일치하는 세그먼트가 없거나 bypass 모드이면 204 (통과)
//   - 유효한 통과 쿠키가 있으면 204, 없으면 401 (대기 화면으로)
//   - block 모드이거나 종료 시각이 지났으면 쿠키와 무관하게 401 (대기 화면에서 안내)
func (s *Server) handleGateAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	segID := r.URL.Query().Get("segment")
	uri := r.Header.Get(headerOrigURI)
	if uri == "" {
		uri = "/"
	}
	seg, ok := s.resolveSegment(segID, uri)
	if !ok {
		if segID != "" {
			s.log.Warn("게이트: 알 수 없는 세그먼트 — 통과 처리", "segment", segID)
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set(headerSegment, seg.ID)
	now := s.now()
	switch {
	case seg.Mode == queue.ModeBlock || seg.Closed(now):
		w.WriteHeader(http.StatusUnauthorized)
		return
	case seg.Mode == queue.ModeBypass:
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if c, err := r.Cookie(CookieName(seg.ID)); err == nil {
		if _, err := s.signer.Verify(c.Value, seg.ID, now); err == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	w.WriteHeader(http.StatusUnauthorized)
}

// handleGateWait 는 명시적 대기 화면이다: /gate/wait?segment=ID&return=/path
func (s *Server) handleGateWait(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ret := q.Get("return")
	if !safeLocalPath(ret) {
		ret = "/"
	}
	s.serveWaitPage(w, r, q.Get("segment"), ret)
}

type waitPageConfig struct {
	Mode      string `json:"mode"`
	Server    string `json:"server"`
	Segment   string `json:"segment"`
	ReturnURL string `json:"returnURL"`
}

var waitPageTmpl = template.Must(template.New("wait").Parse(`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>{{.Title}}</title>
<script id="trafficgate-config" type="application/json">{{.Config}}</script>
<script src="{{.Base}}/trafficgate.js" defer></script>
</head>
<body>
<noscript>현재 접속자가 많아 대기 중입니다. 이 페이지는 JavaScript 를 사용해야 합니다.</noscript>
</body>
</html>
`))

func (s *Server) serveWaitPage(w http.ResponseWriter, r *http.Request, segID, returnURI string) {
	seg, ok := s.resolveSegment(segID, returnURI)
	if !ok {
		writeError(w, http.StatusNotFound, "segment_not_found", "대기실(세그먼트)을 찾을 수 없습니다")
		return
	}
	if !safeLocalPath(returnURI) {
		returnURI = "/"
	}
	base := s.cfg.Server.GateBasePath
	if b := r.Header.Get(headerBase); b != "" && safeLocalPath(b) {
		base = strings.TrimSuffix(b, "/")
	}
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Robots-Tag", "noindex, nofollow")
	h.Set(headerSegment, seg.ID)

	// API/XHR 요청에는 HTML 대신 JSON 으로 대기가 필요함을 알린다.
	if !acceptsHTML(r) {
		h.Set("Retry-After", "5")
		writeJSON(w, http.StatusTooManyRequests, map[string]string{
			"status":   "WAIT",
			"segment":  seg.ID,
			"wait_url": base + "/gate/wait?segment=" + url.QueryEscape(seg.ID) + "&return=" + url.QueryEscape(returnURI),
		})
		return
	}

	cfgJSON, _ := json.Marshal(waitPageConfig{Mode: "gate", Server: base, Segment: seg.ID, ReturnURL: returnURI})
	title := seg.Title
	if title == "" {
		title = "접속 대기 중"
	}
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "same-origin")
	h.Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; "+
		"connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	w.WriteHeader(http.StatusOK)
	_ = waitPageTmpl.Execute(w, map[string]any{
		"Title":  title,
		"Base":   base,
		"Config": template.JS(cfgJSON), // json.Marshal 은 <, >, & 를 \u 이스케이프하므로 script 안에서 안전
	})
}

// acceptsHTML 은 브라우저 페이지 이동 요청인지 판단한다. fetch/XHR(Accept: */* 또는 JSON)은 false.
func acceptsHTML(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Mode") == "navigate" {
		return true
	}
	accept := r.Header.Get("Accept")
	return accept == "" || strings.Contains(accept, "text/html")
}
