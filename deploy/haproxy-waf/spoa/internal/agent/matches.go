package agent

import (
	"regexp"
	"strconv"
	"strings"
)

// RuleMatch is one rule match reported by ModSecurity's log callback.
type RuleMatch struct {
	ID         string   `json:"ruleId"`
	Msg        string   `json:"msg,omitempty"`
	Data       string   `json:"data,omitempty"`
	Severity   string   `json:"severity,omitempty"`
	Tags       []string `json:"tags,omitempty"`
	Disruptive bool     `json:"-"`
}

var (
	reTag         = regexp.MustCompile(`\[tag "([^"]*)"\]`)
	reScore       = regexp.MustCompile(`(?:Total Score: |Inbound Scores: blocking=)(\d+)`)
	severityNames = []string{"EMERGENCY", "ALERT", "CRITICAL", "ERROR", "WARNING", "NOTICE", "INFO", "DEBUG"}
)

// between returns the text between start and end markers. Fields are
// extracted by their fixed position in ModSecurity's message
// ([file] [line] [id] [rev] [msg] [data] [severity] [ver] ... [tag]*) because
// [msg "..."] is not quote-escaped.
func between(s, start, end string) (string, bool) {
	i := strings.Index(s, start)
	if i < 0 {
		return "", false
	}
	s = s[i+len(start):]
	j := strings.Index(s, end)
	if j < 0 {
		return "", false
	}
	return s[:j], true
}

// parseRuleMessage parses one "ModSecurity: Warning. ..." or
// "ModSecurity: Access denied with code 403 (phase 2). ..." line.
func parseRuleMessage(line string) (RuleMatch, bool) {
	id, ok := between(line, `[id "`, `"]`)
	if !ok || id == "" || id == "0" {
		return RuleMatch{}, false
	}
	m := RuleMatch{ID: id, Disruptive: strings.HasPrefix(line, "ModSecurity: Access denied")}
	m.Msg, _ = between(line, `[msg "`, `"] [data "`)
	m.Data, _ = between(line, `[data "`, `"] [severity "`)
	if sev, ok := between(line, `[severity "`, `"]`); ok {
		if n, err := strconv.Atoi(sev); err == nil && n >= 0 && n < len(severityNames) {
			m.Severity = severityNames[n]
		}
	}
	for _, t := range reTag.FindAllStringSubmatch(line, -1) {
		m.Tags = append(m.Tags, t[1])
	}
	return m, true
}

// anomalyScore returns the CRS inbound anomaly score found in the matches
// (rule 949110 when blocking, 980170 in the logging phase), or -1.
func anomalyScore(matches []RuleMatch) int {
	score := -1
	for _, m := range matches {
		if sm := reScore.FindStringSubmatch(m.Msg); sm != nil {
			if n, err := strconv.Atoi(sm[1]); err == nil && n > score {
				score = n
			}
		}
	}
	return score
}

// labels derives AWS-WAF-like labels from rule tags: CRS "attack-*" tags and
// custom "label:<name>" tags.
func labels(matches []RuleMatch) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range matches {
		for _, t := range m.Tags {
			var l string
			switch {
			case strings.HasPrefix(t, "attack-"):
				l = t
			case strings.HasPrefix(t, "label:"):
				l = strings.TrimPrefix(t, "label:")
			default:
				continue
			}
			if l != "" && !seen[l] {
				seen[l] = true
				out = append(out, l)
			}
		}
	}
	return out
}

// ruleGroup classifies a rule id the way AWS WAF reports rule groups.
func ruleGroup(id string) string {
	n, err := strconv.Atoi(id)
	switch {
	case err != nil:
		return "Unknown"
	case n >= 900000 && n <= 999999:
		return "OWASP_CRS"
	case n >= 200000 && n <= 200999:
		return "ModSecurityCore"
	case n < 100000:
		return "LocalRules"
	default:
		return "Other"
	}
}

// isReportingRule reports CRS rules that only summarize other matches
// (blocking evaluation / correlation); they are not "matching rules".
func isReportingRule(id string) bool {
	switch id {
	case "949110", "949111", "959100", "959101", "980170", "980099", "980130", "980140":
		return true
	}
	return false
}
