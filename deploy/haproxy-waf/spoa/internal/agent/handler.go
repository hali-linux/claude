// Package agent evaluates HTTP requests received from HAProxy (SPOE) with
// ModSecurity and turns the outcome into HAProxy variables, the way AWS WAF
// returns a verdict to an Application Load Balancer.
package agent

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"modsec-spoa/internal/modsec"
	"modsec-spoa/internal/spop"
)

// Verdict variable names (HAProxy prefixes them, e.g. txn.waf.action). They
// must be listed in "register-var-names" in the SPOE configuration.
const (
	VarAction  = "action"   // allow | block | redirect | error
	VarStatus  = "status"   // HTTP status requested by the rules
	VarRuleID  = "rule_id"  // terminating rule
	VarRules   = "rules"    // all matching rule ids, comma separated
	VarLabels  = "labels"   // attack-* / label:* tags, comma separated
	VarScore   = "score"    // CRS inbound anomaly score
	VarBody    = "body"     // inspected | skipped | partial | none
	VarRedir   = "redirect" // redirect URL, when action=redirect
	maxVarSize = 1024
)

// Config configures a Handler.
type Config struct {
	Engine *modsec.Engine
	// Log receives one JSON line per request that matched at least one rule
	// (or per request when LogAllowed is true). Nil disables WAF logs.
	Log        *WAFLog
	LogAllowed bool
	// RedactHeaders lists header names (lower case) whose values are
	// replaced by "[REDACTED]" in WAF logs.
	RedactHeaders map[string]bool
	WebACLID      string
	Logger        *slog.Logger
}

// Handler implements spop.Handler.
type Handler struct {
	cfg Config
}

// New returns a Handler.
func New(cfg Config) *Handler {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.WebACLID == "" {
		cfg.WebACLID = "haproxy-modsecurity"
	}
	return &Handler{cfg: cfg}
}

// Result is the outcome of one evaluation.
type Result struct {
	Action      string
	Status      int
	RuleID      string
	RedirectURL string
	Matches     []RuleMatch
	Score       int
	Body        string
	BodyBytes   int
	Elapsed     time.Duration
}

// Handle is the spop.Handler.
func (h *Handler) Handle(_ context.Context, msgs []spop.Message) []spop.Action {
	for i := range msgs {
		req, err := parseRequest(&msgs[i])
		if err == errNotRequest {
			continue
		}
		if err != nil {
			h.cfg.Logger.Warn("invalid request message", "message", msgs[i].Name, "err", err)
			return []spop.Action{setVar(VarAction, "error")}
		}
		res := h.Evaluate(req)
		h.log(req, res)
		return res.actions()
	}
	return nil
}

// Evaluate runs the request through ModSecurity phases 1, 2 and 5.
func (h *Handler) Evaluate(r *request) *Result {
	start := time.Now()
	res := &Result{Action: "allow", Score: -1, Body: "none"}
	defer func() { res.Elapsed = time.Since(start) }()

	tx, err := h.cfg.Engine.NewTransaction(r.id)
	if err != nil {
		h.cfg.Logger.Error("cannot start ModSecurity transaction", "err", err)
		res.Action = "error"
		return res
	}
	defer tx.Close()

	tx.ProcessConnection(r.clientIP, r.clientPort, r.serverIP, r.serverPort)
	tx.ProcessURI(r.uri, r.method, r.version)
	for _, hd := range r.headers {
		tx.AddRequestHeader([]byte(hd.Name), []byte(hd.Value))
	}
	tx.ProcessRequestHeaders()
	it := tx.Intervention()

	if it == nil {
		switch {
		case r.bodySkipped:
			// Oversize body that HAProxy chose not to send: headers, URI
			// and query arguments are still inspected in phase 2.
			res.Body = "skipped"
		case len(r.body) == 0:
		case r.bodySize > int64(len(r.body)):
			// Body was cut by HAProxy's buffer. A truncated multipart or
			// JSON body would fail to parse (REQBODY_ERROR → false
			// positive), so it is not fed to ModSecurity at all.
			res.Body = "partial"
		default:
			tx.AppendRequestBody(r.body)
			res.Body = "inspected"
			res.BodyBytes = len(r.body)
		}
		// Phase 2 must run even without a body: most CRS rules live there.
		tx.ProcessRequestBody()
		it = tx.Intervention()
	}
	tx.ProcessLogging()

	// The log callback only receives non-disruptive matches; the rule that
	// triggered the intervention is described by the intervention log.
	for _, line := range tx.Logs {
		if m, ok := parseRuleMessage(line); ok {
			res.Matches = append(res.Matches, m)
		}
	}
	if it != nil {
		if m, ok := parseRuleMessage(it.Log); ok {
			m.Disruptive = true
			res.Matches = append(res.Matches, m)
			res.RuleID = m.ID
		}
	}
	res.Score = anomalyScore(res.Matches)

	if it != nil {
		res.Status = it.Status
		switch {
		case it.URL != "" && it.Status >= 300 && it.Status < 400:
			res.Action, res.RedirectURL = "redirect", it.URL
		case it.Status == 0 || it.Status == 200:
			// Non-blocking interventions (e.g. "pause") are ignored.
		default:
			res.Action = "block"
		}
	}
	return res
}

func setVar(name string, value any) spop.Action {
	if s, ok := value.(string); ok && len(s) > maxVarSize {
		value = s[:maxVarSize]
	}
	return spop.SetVar(spop.ScopeTransaction, name, value)
}

func (r *Result) actions() []spop.Action {
	acts := []spop.Action{
		setVar(VarAction, r.Action),
		setVar(VarBody, r.Body),
	}
	if r.Status != 0 {
		acts = append(acts, setVar(VarStatus, int64(r.Status)))
	}
	if r.RuleID != "" {
		acts = append(acts, setVar(VarRuleID, r.RuleID))
	}
	if ids := r.matchingRuleIDs(); len(ids) > 0 {
		acts = append(acts, setVar(VarRules, strings.Join(ids, ",")))
	}
	if ls := labels(r.Matches); len(ls) > 0 {
		acts = append(acts, setVar(VarLabels, strings.Join(ls, ",")))
	}
	if r.Score >= 0 {
		acts = append(acts, setVar(VarScore, int64(r.Score)))
	}
	if r.RedirectURL != "" {
		acts = append(acts, setVar(VarRedir, r.RedirectURL))
	}
	return acts
}

// matchingRuleIDs returns the ids of the rules that matched, without the
// CRS evaluation/reporting rules, in order and without duplicates.
func (r *Result) matchingRuleIDs() []string {
	var ids []string
	seen := map[string]bool{}
	for _, m := range r.Matches {
		if isReportingRule(m.ID) || seen[m.ID] {
			continue
		}
		seen[m.ID] = true
		ids = append(ids, m.ID)
	}
	return ids
}

func (h *Handler) log(r *request, res *Result) {
	if h.cfg.Log == nil {
		return
	}
	if len(res.Matches) == 0 && res.Action == "allow" && !h.cfg.LogAllowed {
		return
	}

	action := "ALLOW"
	switch {
	case res.Action == "error":
		action = "ERROR"
	case res.Action != "allow" && r.mode == "count":
		action = "COUNT" // would have been blocked; HAProxy only counts
	case res.Action == "block":
		action = "BLOCK"
	case res.Action == "redirect":
		action = "REDIRECT"
	}

	groups := map[string]*ruleGroupL{}
	var order []string
	group := func(id string) *ruleGroupL {
		name := ruleGroup(id)
		g, ok := groups[name]
		if !ok {
			g = &ruleGroupL{RuleGroupID: name, NonTerminatingMatchingRules: []ruleL{}}
			groups[name] = g
			order = append(order, name)
		}
		return g
	}
	for _, m := range res.Matches {
		rl := ruleL{RuleID: m.ID, Action: "COUNT", Msg: m.Msg, Data: redactData(m.Data), Severity: m.Severity, Tags: m.Tags}
		if m.ID == res.RuleID && res.Action != "allow" {
			rl.Action = action
			rule := rl
			group(m.ID).TerminatingRule = &rule
			continue
		}
		if isReportingRule(m.ID) {
			continue
		}
		g := group(m.ID)
		g.NonTerminatingMatchingRules = append(g.NonTerminatingMatchingRules, rl)
	}
	entry := logEntry{
		Timestamp:           time.Now().UnixMilli(),
		FormatVersion:       1,
		WebACLID:            h.cfg.WebACLID,
		TerminatingRuleID:   "Default_Action",
		TerminatingRuleType: "REGULAR",
		Action:              action,
		Mode:                r.mode,
		HTTPSourceName:      "HAPROXY",
		HTTPSourceID:        r.host,
		RuleGroupList:       []ruleGroupL{},
		RequestBodySize:     r.bodySize,
		BodyInspected:       res.BodyBytes,
		BodyInspection:      res.Body,
		ProcessingMicros:    res.Elapsed.Microseconds(),
		HTTPRequest: httpRequestL{
			ClientIP:    r.clientIP,
			Country:     r.country,
			Headers:     redactHeaders(r.headers, h.cfg.RedactHeaders),
			HTTPVersion: "HTTP/" + r.version,
			HTTPMethod:  r.method,
			RequestID:   r.id,
		},
	}
	entry.HTTPRequest.URI, entry.HTTPRequest.Args, _ = strings.Cut(r.uri, "?")
	if res.RuleID != "" && res.Action != "allow" {
		entry.TerminatingRuleID = res.RuleID
		entry.TerminatingRuleType = "MANAGED_RULE_GROUP"
		if ruleGroup(res.RuleID) == "LocalRules" {
			entry.TerminatingRuleType = "REGULAR"
		}
		if action == "BLOCK" {
			entry.ResponseCodeSent = 403
		}
	}
	if res.Action == "error" {
		entry.TerminatingRuleID = "WAF_Error"
	}
	for _, name := range order {
		entry.RuleGroupList = append(entry.RuleGroupList, *groups[name])
	}
	for _, l := range labels(res.Matches) {
		entry.Labels = append(entry.Labels, labelL{Name: l})
	}
	if res.Score >= 0 {
		score := res.Score
		entry.AnomalyScore = &score
	}
	if err := h.cfg.Log.Write(entry); err != nil {
		h.cfg.Logger.Error("cannot write WAF log", "err", err)
	}
}
