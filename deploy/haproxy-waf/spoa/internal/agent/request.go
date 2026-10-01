package agent

import (
	"errors"
	"fmt"
	"net"
	"strconv"

	"modsec-spoa/internal/spop"
)

// Names of the spoe-message arguments sent by HAProxy (see waf-spoe.conf).
const (
	argID          = "id"
	argSrcIP       = "src_ip"
	argSrcPort     = "src_port"
	argDstIP       = "dst_ip"
	argDstPort     = "dst_port"
	argMethod      = "method"
	argPath        = "path"
	argVersion     = "version"
	argHeaders     = "headers"
	argBody        = "body"
	argBodySize    = "body_size"
	argBodySkipped = "body_skipped"
	argMode        = "mode"
	argCountry     = "country"
)

type header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// request is the HTTP request as seen by HAProxy.
type request struct {
	id          string
	clientIP    string
	clientPort  int
	serverIP    string
	serverPort  int
	method      string
	uri         string // path + query string, as received
	version     string // "1.1", "2.0", ...
	headers     []header
	host        string
	body        []byte
	bodySize    int64 // advertised size (Content-Length), -1 if unknown
	bodySkipped bool  // HAProxy did not send the body (oversize handling)
	mode        string
	country     string
}

var errNotRequest = errors.New("message has no path argument")

func parseRequest(m *spop.Message) (*request, error) {
	r := &request{bodySize: -1, version: "1.1", method: "GET", mode: "block"}
	if _, ok := m.Get(argPath); !ok {
		return nil, errNotRequest
	}
	for _, a := range m.Args {
		switch a.Name {
		case argID:
			r.id = asString(a.Value)
		case argSrcIP:
			r.clientIP = asIP(a.Value)
		case argSrcPort:
			r.clientPort = int(asInt(a.Value, 0))
		case argDstIP:
			r.serverIP = asIP(a.Value)
		case argDstPort:
			r.serverPort = int(asInt(a.Value, 0))
		case argMethod:
			if s := asString(a.Value); s != "" {
				r.method = s
			}
		case argPath:
			r.uri = asString(a.Value)
		case argVersion:
			if s := asString(a.Value); s != "" {
				r.version = s
			}
		case argHeaders:
			hb, _ := a.Value.([]byte)
			hs, err := parseHeaders(hb)
			if err != nil {
				return nil, fmt.Errorf("headers: %w", err)
			}
			r.headers = hs
		case argBody:
			r.body, _ = a.Value.([]byte)
			if r.body == nil {
				if s, ok := a.Value.(string); ok {
					r.body = []byte(s)
				}
			}
		case argBodySize:
			r.bodySize = asInt(a.Value, -1)
		case argBodySkipped:
			r.bodySkipped = asBool(a.Value)
		case argMode:
			if s := asString(a.Value); s != "" {
				r.mode = s
			}
		case argCountry:
			r.country = asString(a.Value)
		}
	}
	if r.uri == "" {
		r.uri = "/"
	}
	if r.clientIP == "" {
		r.clientIP = "0.0.0.0"
	}
	if r.serverIP == "" {
		r.serverIP = "0.0.0.0"
	}
	for _, h := range r.headers {
		if equalFold(h.Name, "host") {
			r.host = h.Value
			break
		}
	}
	return r, nil
}

// parseHeaders decodes HAProxy's req.hdrs_bin format:
//
//	*(<str:name><str:value>) <empty string><empty string>
//
// where str is <varint:length><bytes>.
func parseHeaders(b []byte) ([]header, error) {
	var out []header
	off := 0
	read := func() (string, error) {
		n, k, err := spop.ReadVarint(b[off:])
		if err != nil {
			return "", err
		}
		off += k
		if n > uint64(len(b)-off) {
			return "", errors.New("truncated header block")
		}
		s := string(b[off : off+int(n)])
		off += int(n)
		return s, nil
	}
	for off < len(b) {
		name, err := read()
		if err != nil {
			return nil, err
		}
		value, err := read()
		if err != nil {
			return nil, err
		}
		if name == "" && value == "" {
			break
		}
		out = append(out, header{Name: name, Value: value})
	}
	return out, nil
}

func asString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	case net.IP:
		return x.String()
	case int64:
		return strconv.FormatInt(x, 10)
	case uint64:
		return strconv.FormatUint(x, 10)
	}
	return ""
}

func asIP(v any) string {
	switch x := v.(type) {
	case net.IP:
		if v4 := x.To4(); v4 != nil {
			return v4.String()
		}
		return x.String()
	case string:
		if ip := net.ParseIP(x); ip != nil {
			return asIP(ip)
		}
	}
	return ""
}

func asInt(v any, def int64) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case uint64:
		return int64(x)
	case string:
		if n, err := strconv.ParseInt(x, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func asBool(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case int64:
		return x != 0
	case uint64:
		return x != 0
	case string:
		return x == "1" || x == "true"
	}
	return false
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if 'A' <= ca && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if 'A' <= cb && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}
