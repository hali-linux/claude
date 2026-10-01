package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"modsec-spoa/internal/modsec"
	"modsec-spoa/internal/spop"
)

const testRules = `
SecRuleEngine On
SecRequestBodyAccess On
SecRequestBodyLimit 131072
SecRequestBodyNoFilesLimit 131072
SecRequestBodyLimitAction ProcessPartial
SecRule REQUEST_HEADERS:Content-Type "^application/json" "id:200001,phase:1,t:none,t:lowercase,pass,nolog,ctl:requestBodyProcessor=JSON"
SecRule REQBODY_ERROR "!@eq 0" "id:200002,phase:2,t:none,log,deny,status:400,msg:'Failed to parse request body.'"
SecRule MULTIPART_STRICT_ERROR "!@eq 0" "id:200003,phase:2,t:none,log,deny,status:400,msg:'Multipart strict error'"
SecRule REQUEST_HEADERS:User-Agent "@contains badbot" "id:10001,phase:1,deny,status:403,log,msg:'Bad bot',tag:'attack-reputation-scanner'"
SecRule ARGS "@contains attack" "id:10002,phase:2,deny,status:403,log,msg:'Attack \"quoted\" in args',logdata:'%{MATCHED_VAR_NAME}=%{MATCHED_VAR}',tag:'attack-generic',tag:'label:Test:Attack'"
SecRule ARGS "@contains notice" "id:10003,phase:2,pass,log,msg:'Just a notice',logdata:'%{MATCHED_VAR_NAME}=%{MATCHED_VAR}',tag:'attack-other'"
SecRule REQUEST_URI "@beginsWith /moved" "id:10004,phase:1,redirect:https://example.com/new,status:302,log,msg:'moved'"
`

func newHandler(t *testing.T, logPath string) *Handler {
	t.Helper()
	e := modsec.NewEngine("test")
	rs, err := modsec.LoadRules(modsec.RuleSource{Inline: testRules})
	if err != nil {
		t.Fatal(err)
	}
	e.Reload(rs)
	var wl *WAFLog
	if logPath != "" {
		if wl, err = OpenWAFLog(logPath); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { wl.Close() })
	}
	return New(Config{Engine: e, Log: wl, RedactHeaders: map[string]bool{"cookie": true}})
}

func hdrsBin(kv ...string) []byte {
	var b []byte
	for _, s := range append(kv, "", "") {
		b = spop.AppendVarint(b, uint64(len(s)))
		b = append(b, s...)
	}
	return b
}

func msg(path, method string, headers []byte, extra ...spop.Arg) []spop.Message {
	args := []spop.Arg{
		{Name: "id", Value: "req-1"},
		{Name: "src_ip", Value: net.ParseIP("192.0.2.10").To4()},
		{Name: "src_port", Value: int64(50000)},
		{Name: "dst_ip", Value: net.ParseIP("192.0.2.1").To4()},
		{Name: "dst_port", Value: int64(443)},
		{Name: "method", Value: method},
		{Name: "path", Value: path},
		{Name: "version", Value: "1.1"},
		{Name: "headers", Value: headers},
		{Name: "mode", Value: "block"},
	}
	return []spop.Message{{Name: "modsec-request", Args: append(args, extra...)}}
}

func vars(actions []spop.Action) map[string]any {
	out := map[string]any{}
	for _, a := range actions {
		out[a.Name] = a.Value
	}
	return out
}

func TestAllowAndBlock(t *testing.T) {
	h := newHandler(t, "")
	hs := hdrsBin("Host", "photos.example.com", "User-Agent", "Mozilla/5.0")

	v := vars(h.Handle(context.Background(), msg("/api/photos?q=hello", "GET", hs)))
	if v["action"] != "allow" || v["body"] != "none" {
		t.Fatalf("clean request: %v", v)
	}

	v = vars(h.Handle(context.Background(), msg("/search?q=attack", "GET", hs)))
	if v["action"] != "block" || v["status"] != int64(403) || v["rule_id"] != "10002" {
		t.Fatalf("query attack: %v", v)
	}
	if v["labels"] != "attack-generic,Test:Attack" || v["rules"] != "10002" {
		t.Fatalf("labels/rules: %v", v)
	}

	bad := hdrsBin("Host", "photos.example.com", "User-Agent", "badbot/1.0")
	v = vars(h.Handle(context.Background(), msg("/", "GET", bad)))
	if v["action"] != "block" || v["rule_id"] != "10001" {
		t.Fatalf("phase 1 block: %v", v)
	}

	v = vars(h.Handle(context.Background(), msg("/moved/x", "GET", hs)))
	if v["action"] != "redirect" || v["redirect"] != "https://example.com/new" {
		t.Fatalf("redirect: %v", v)
	}

	v = vars(h.Handle(context.Background(), msg("/?a=notice", "GET", hs)))
	if v["action"] != "allow" || v["rules"] != "10003" {
		t.Fatalf("non-blocking match: %v", v)
	}
}

func TestJSONBody(t *testing.T) {
	h := newHandler(t, "")
	body := []byte(`{"description":"an attack here"}`)
	hs := hdrsBin("Host", "h", "Content-Type", "application/json", "Content-Length", "32")
	v := vars(h.Handle(context.Background(), msg("/api/photos/1", "PATCH", hs,
		spop.Arg{Name: "body", Value: body}, spop.Arg{Name: "body_size", Value: int64(len(body))})))
	if v["action"] != "block" || v["body"] != "inspected" {
		t.Fatalf("json attack: %v", v)
	}

	broken := []byte(`{"description":`)
	v = vars(h.Handle(context.Background(), msg("/api/photos/1", "PATCH", hs,
		spop.Arg{Name: "body", Value: broken}, spop.Arg{Name: "body_size", Value: int64(len(broken))})))
	if v["action"] != "block" || v["rule_id"] != "200002" || v["status"] != int64(400) {
		t.Fatalf("invalid json must be rejected: %v", v)
	}
}

func TestOversizeMultipartIsNotAFalsePositive(t *testing.T) {
	h := newHandler(t, "")
	hs := hdrsBin("Host", "h", "Content-Type", "multipart/form-data; boundary=XYZ", "Content-Length", "31457280")
	head := []byte("--XYZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n\xff\xd8\xff\xe0")

	// HAProxy skipped the body (oversize handling).
	v := vars(h.Handle(context.Background(), msg("/api/photos/upload", "POST", hs,
		spop.Arg{Name: "body_skipped", Value: true}, spop.Arg{Name: "body_size", Value: int64(31457280)})))
	if v["action"] != "allow" || v["body"] != "skipped" {
		t.Fatalf("skipped body: %v", v)
	}

	// HAProxy sent only the first bytes of a larger body.
	v = vars(h.Handle(context.Background(), msg("/api/photos/upload", "POST", hs,
		spop.Arg{Name: "body", Value: head}, spop.Arg{Name: "body_size", Value: int64(31457280)})))
	if v["action"] != "allow" || v["body"] != "partial" {
		t.Fatalf("partial body: %v", v)
	}

	// Query string attacks are still caught when the body is skipped.
	v = vars(h.Handle(context.Background(), msg("/api/photos/upload?x=attack", "POST", hs,
		spop.Arg{Name: "body_skipped", Value: true})))
	if v["action"] != "block" {
		t.Fatalf("args must still be inspected: %v", v)
	}
}

func TestWAFLogIsRedacted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "waf.log")
	h := newHandler(t, path)
	hs := hdrsBin("Host", "photos.example.com", "Cookie", "__Host-fp_session=SECRET", "User-Agent", "x")
	h.Handle(context.Background(), msg("/?q=attack&password=notice", "GET", hs, spop.Arg{Name: "mode", Value: "count"}))
	h.Handle(context.Background(), msg("/clean", "GET", hs)) // not logged by default

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(bytes.TrimSpace(raw), []byte("\n"))
	if len(lines) != 1 {
		t.Fatalf("want 1 log line, got %d:\n%s", len(lines), raw)
	}
	if strings.Contains(string(raw), "SECRET") {
		t.Fatalf("cookie leaked into WAF log: %s", raw)
	}
	var e logEntry
	if err := json.Unmarshal(lines[0], &e); err != nil {
		t.Fatal(err)
	}
	if e.Action != "COUNT" || e.TerminatingRuleID != "10002" || e.HTTPRequest.URI != "/" || e.HTTPRequest.RequestID != "req-1" {
		t.Fatalf("unexpected entry: %+v", e)
	}
	var data []string
	for _, g := range e.RuleGroupList {
		if g.TerminatingRule != nil {
			data = append(data, g.TerminatingRule.Data)
			// The message contains quotes; extraction must not stop at them.
			if !strings.HasPrefix(g.TerminatingRule.Msg, "Attack ") || !strings.HasSuffix(g.TerminatingRule.Msg, " in args") {
				t.Errorf("msg with quotes not parsed: %q", g.TerminatingRule.Msg)
			}
		}
		for _, r := range g.NonTerminatingMatchingRules {
			data = append(data, r.Data)
		}
	}
	joined := strings.Join(data, "|")
	if strings.Contains(joined, "notice") && !strings.Contains(joined, "[REDACTED]") {
		t.Fatalf("password argument value must be redacted: %v", data)
	}
}

func TestParseHeaders(t *testing.T) {
	hs, err := parseHeaders(hdrsBin("a", "1", "b", ""))
	if err != nil || len(hs) != 2 || hs[0] != (header{"a", "1"}) || hs[1] != (header{"b", ""}) {
		t.Fatalf("parseHeaders = %v, %v", hs, err)
	}
	if _, err := parseHeaders([]byte{5, 'a'}); err == nil {
		t.Fatal("expected error on truncated header block")
	}
}

func TestParseRuleMessage(t *testing.T) {
	line := `ModSecurity: Access denied with code 403 (phase 2). Matched "Operator ` + "`Ge'" + ` with parameter ` + "`5'" + ` against variable ` + "`TX:BLOCKING_INBOUND_ANOMALY_SCORE'" + ` (Value: ` + "`10'" + ` ) [file "/etc/crs/REQUEST-949-BLOCKING-EVALUATION.conf"] [line "222"] [id "949110"] [rev ""] [msg "Inbound Anomaly Score Exceeded (Total Score: 10)"] [data ""] [severity "0"] [ver "OWASP_CRS/4.25.0"] [maturity "0"] [accuracy "0"] [tag "anomaly-evaluation"] [tag "OWASP_CRS"] [hostname "192.0.2.1"] [uri "/"] [unique_id "abc"] [ref ""]`
	m, ok := parseRuleMessage(line)
	if !ok || m.ID != "949110" || !m.Disruptive || m.Severity != "EMERGENCY" || len(m.Tags) != 2 {
		t.Fatalf("parse = %+v, %v", m, ok)
	}
	if s := anomalyScore([]RuleMatch{m}); s != 10 {
		t.Fatalf("score = %d", s)
	}
}
