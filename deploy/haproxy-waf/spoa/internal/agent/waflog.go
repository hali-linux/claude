package agent

import (
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strings"
	"sync"
)

// WAFLog writes one JSON object per line, in a layout modeled on AWS WAF
// logs (terminatingRuleId, action, ruleGroupList, labels, httpRequest, ...).
type WAFLog struct {
	path string
	mu   sync.Mutex
	w    io.Writer
	f    *os.File
}

// OpenWAFLog opens path for appending ("-" means stdout).
func OpenWAFLog(path string) (*WAFLog, error) {
	l := &WAFLog{path: path}
	if err := l.Reopen(); err != nil {
		return nil, err
	}
	return l, nil
}

// Reopen reopens the log file (after logrotate moved it).
func (l *WAFLog) Reopen() error {
	if l.path == "-" {
		l.mu.Lock()
		l.w = os.Stdout
		l.mu.Unlock()
		return nil
	}
	f, err := os.OpenFile(l.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o640)
	if err != nil {
		return err
	}
	l.mu.Lock()
	old := l.f
	l.f, l.w = f, f
	l.mu.Unlock()
	if old != nil {
		old.Close()
	}
	return nil
}

// Write logs one entry. Each entry is written with a single write(2) so lines
// never interleave.
func (l *WAFLog) Write(entry any) error {
	b, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	l.mu.Lock()
	defer l.mu.Unlock()
	_, err = l.w.Write(b)
	return err
}

// Close closes the underlying file.
func (l *WAFLog) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f != nil {
		return l.f.Close()
	}
	return nil
}

type logEntry struct {
	Timestamp           int64        `json:"timestamp"`
	FormatVersion       int          `json:"formatVersion"`
	WebACLID            string       `json:"webaclId"`
	TerminatingRuleID   string       `json:"terminatingRuleId"`
	TerminatingRuleType string       `json:"terminatingRuleType"`
	Action              string       `json:"action"`
	Mode                string       `json:"mode"`
	HTTPSourceName      string       `json:"httpSourceName"`
	HTTPSourceID        string       `json:"httpSourceId"`
	RuleGroupList       []ruleGroupL `json:"ruleGroupList"`
	Labels              []labelL     `json:"labels,omitempty"`
	AnomalyScore        *int         `json:"anomalyScore,omitempty"`
	ResponseCodeSent    int          `json:"responseCodeSent,omitempty"`
	RequestBodySize     int64        `json:"requestBodySize"`
	BodyInspected       int          `json:"requestBodySizeInspectedByWAF"`
	BodyInspection      string       `json:"bodyInspection"`
	ProcessingMicros    int64        `json:"processingTimeMicros"`
	HTTPRequest         httpRequestL `json:"httpRequest"`
}

type ruleGroupL struct {
	RuleGroupID                 string  `json:"ruleGroupId"`
	TerminatingRule             *ruleL  `json:"terminatingRule"`
	NonTerminatingMatchingRules []ruleL `json:"nonTerminatingMatchingRules"`
}

type ruleL struct {
	RuleID   string   `json:"ruleId"`
	Action   string   `json:"action"`
	Msg      string   `json:"msg,omitempty"`
	Data     string   `json:"data,omitempty"`
	Severity string   `json:"severity,omitempty"`
	Tags     []string `json:"tags,omitempty"`
}

type labelL struct {
	Name string `json:"name"`
}

type httpRequestL struct {
	ClientIP    string   `json:"clientIp"`
	Country     string   `json:"country,omitempty"`
	Headers     []header `json:"headers"`
	URI         string   `json:"uri"`
	Args        string   `json:"args"`
	HTTPVersion string   `json:"httpVersion"`
	HTTPMethod  string   `json:"httpMethod"`
	RequestID   string   `json:"requestId"`
}

// sensitiveData matches ModSecurity "data" strings that quote values of
// variables which must never reach the logs (session cookies, credentials).
// It mirrors the key filter of the application logger (src/lib/logger.ts).
var sensitiveData = regexp.MustCompile(`(?i)REQUEST_COOKIES|REQUEST_HEADERS:(cookie|authorization|proxy-authorization|x-api-key)|ARGS(_NAMES|_POST|_GET)?:[^\s:]*(pass(word)?|secret|token|session|hash|key)`)

func redactHeaders(hs []header, redact map[string]bool) []header {
	out := make([]header, len(hs))
	for i, h := range hs {
		out[i] = h
		if redact[strings.ToLower(h.Name)] {
			out[i].Value = "[REDACTED]"
		}
	}
	return out
}

func redactData(s string) string {
	if s != "" && sensitiveData.MatchString(s) {
		return "[REDACTED]"
	}
	return s
}
