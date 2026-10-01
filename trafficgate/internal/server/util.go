package server

import (
	"encoding/json"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(true)
	_ = enc.Encode(v)
}

type apiError struct {
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, apiError{Error: code, Message: msg})
}

// clientIP 는 신뢰할 프록시를 고려해 실제 클라이언트 IP 를 구한다.
// 직접 연결한 주소가 신뢰 대역이면 X-Forwarded-For 를 오른쪽부터 따라가며
// 처음 만나는 신뢰하지 않는 주소를 클라이언트로 본다.
func clientIP(r *http.Request, trusted []netip.Prefix) netip.Addr {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	remote, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	remote = remote.Unmap()
	if !isTrusted(remote, trusted) {
		return remote
	}
	xff := r.Header.Values("X-Forwarded-For")
	var hops []string
	for _, v := range xff {
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				hops = append(hops, p)
			}
		}
	}
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(hops[i])
		if err != nil {
			break
		}
		a = a.Unmap()
		if !isTrusted(a, trusted) {
			return a
		}
		remote = a
	}
	if xr := r.Header.Get("X-Real-IP"); xr != "" && len(hops) == 0 {
		if a, err := netip.ParseAddr(strings.TrimSpace(xr)); err == nil {
			return a.Unmap()
		}
	}
	return remote
}

func isTrusted(a netip.Addr, trusted []netip.Prefix) bool {
	for _, p := range trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// isHTTPS 는 요청이 HTTPS 로 들어왔는지(신뢰 프록시의 X-Forwarded-Proto 포함) 판단한다.
func isHTTPS(r *http.Request, trusted []netip.Prefix) bool {
	if r.TLS != nil {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	remote, err := netip.ParseAddr(host)
	if err != nil || !isTrusted(remote.Unmap(), trusted) {
		return false
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// safeLocalPath 는 오픈 리다이렉트를 막기 위해 같은 사이트 내 경로인지 확인한다.
func safeLocalPath(p string) bool {
	if p == "" || len(p) > 4096 || !strings.HasPrefix(p, "/") {
		return false
	}
	if strings.HasPrefix(p, "//") || strings.HasPrefix(p, "/\\") {
		return false
	}
	for i := 0; i < len(p); i++ {
		if c := p[i]; c < 0x20 || c == 0x7f || c == '\\' {
			return false
		}
	}
	return true
}

// statusRecorder 는 응답 상태 코드를 기록한다.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(b)
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }
