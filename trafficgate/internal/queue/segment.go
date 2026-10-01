package queue

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Mode 는 세그먼트의 동작 방식이다.
type Mode string

const (
	// ModeQueue 는 진입 허용 수(max_active)를 넘는 사용자를 대기열에 세운다.
	ModeQueue Mode = "queue"
	// ModeBypass 는 대기 없이 모두 통과시킨다(트래픽 제어 해제).
	ModeBypass Mode = "bypass"
	// ModeBlock 은 모든 진입을 차단하고 차단 안내를 보여준다.
	ModeBlock Mode = "block"
)

// 세그먼트 기본값.
const (
	DefaultActiveTTL = 30  // 초
	DefaultPassTTL   = 600 // 초
)

var segmentIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

// ErrInvalidSegment 는 세그먼트 설정 검증 실패를 나타낸다.
var ErrInvalidSegment = errors.New("invalid segment")

// Segment 는 하나의 트래픽 제어 단위(가상 대기실)이다.
// NetFUNNEL 의 "세그먼트" 개념과 같다.
type Segment struct {
	ID   string `json:"id" yaml:"id"`
	Name string `json:"name" yaml:"name"`
	Mode Mode   `json:"mode" yaml:"mode"`

	// MaxActive 는 동시에 서비스에 진입해 있을 수 있는 사용자 수(진입 허용 수)이다.
	// 0 이면 아무도 입장시키지 않고 대기열만 유지한다(일시 정지).
	MaxActive int `json:"max_active" yaml:"max_active"`
	// ActiveTTL 은 입장한 사용자가 complete/alive 없이 슬롯을 점유할 수 있는 최대 시간(초)이다.
	// 이 시간이 지나면 슬롯이 자동 반환된다. 게이트(nginx) 모드에서는 입장 후 항상 이 시간만큼 점유한다.
	ActiveTTL int `json:"active_ttl_sec" yaml:"active_ttl_sec"`
	// PassTTL 은 통과 토큰(쿠키)의 유효 시간(초)이다.
	PassTTL int `json:"pass_ttl_sec" yaml:"pass_ttl_sec"`
	// MaxWaiting 은 대기열 최대 인원이다. 0 이면 무제한.
	MaxWaiting int `json:"max_waiting" yaml:"max_waiting"`

	// URLPatterns 는 게이트 모드에서 이 세그먼트로 제어할 URL 경로 패턴이다. 예: /event/*
	URLPatterns []string `json:"url_patterns" yaml:"url_patterns"`

	// OpenAt 이전에 도착한 사용자는 사전 대기실(카운트다운)에서 기다린다.
	OpenAt *time.Time `json:"open_at,omitempty" yaml:"open_at,omitempty"`
	// CloseAt 이후에는 종료 안내(사후 대기실)를 보여준다.
	CloseAt *time.Time `json:"close_at,omitempty" yaml:"close_at,omitempty"`
	// PreQueueRandom 이 true 이면 오픈 전에 도착한 사용자들의 순번을 무작위로 섞는다.
	PreQueueRandom bool `json:"pre_queue_random" yaml:"pre_queue_random"`

	Title         string `json:"title" yaml:"title"`
	Message       string `json:"message" yaml:"message"`
	BlockMessage  string `json:"block_message" yaml:"block_message"`
	ClosedMessage string `json:"closed_message" yaml:"closed_message"`
	ClosedURL     string `json:"closed_url" yaml:"closed_url"`

	UpdatedAt time.Time `json:"updated_at" yaml:"-"`
}

// Normalize 는 비어 있는 필드에 기본값을 채운다.
func (s *Segment) Normalize() {
	s.ID = strings.TrimSpace(s.ID)
	s.Name = strings.TrimSpace(s.Name)
	if s.Name == "" {
		s.Name = s.ID
	}
	if s.Mode == "" {
		s.Mode = ModeQueue
	}
	if s.ActiveTTL == 0 {
		s.ActiveTTL = DefaultActiveTTL
	}
	if s.PassTTL == 0 {
		s.PassTTL = DefaultPassTTL
	}
	patterns := make([]string, 0, len(s.URLPatterns))
	for _, p := range s.URLPatterns {
		if p = strings.TrimSpace(p); p != "" {
			patterns = append(patterns, p)
		}
	}
	s.URLPatterns = patterns
	if s.OpenAt != nil && s.OpenAt.IsZero() {
		s.OpenAt = nil
	}
	if s.CloseAt != nil && s.CloseAt.IsZero() {
		s.CloseAt = nil
	}
}

// Validate 는 세그먼트 설정을 검사한다.
func (s *Segment) Validate() error {
	bad := func(format string, args ...any) error {
		return fmt.Errorf("%w: %s", ErrInvalidSegment, fmt.Sprintf(format, args...))
	}
	if !segmentIDPattern.MatchString(s.ID) {
		return bad("id 는 영문/숫자/-/_ 로 1~64자여야 합니다 (%q)", s.ID)
	}
	if utf8.RuneCountInString(s.Name) > 100 {
		return bad("name 은 100자 이하여야 합니다")
	}
	switch s.Mode {
	case ModeQueue, ModeBypass, ModeBlock:
	default:
		return bad("mode 는 queue, bypass, block 중 하나여야 합니다 (%q)", s.Mode)
	}
	if s.MaxActive < 0 || s.MaxActive > 10_000_000 {
		return bad("max_active 는 0~10,000,000 이어야 합니다")
	}
	if s.ActiveTTL < 1 || s.ActiveTTL > 86400 {
		return bad("active_ttl_sec 는 1~86400 이어야 합니다")
	}
	if s.PassTTL < 10 || s.PassTTL > 7*86400 {
		return bad("pass_ttl_sec 는 10~604800 이어야 합니다")
	}
	if s.MaxWaiting < 0 {
		return bad("max_waiting 은 0 이상이어야 합니다")
	}
	if len(s.URLPatterns) > 100 {
		return bad("url_patterns 는 100개 이하여야 합니다")
	}
	for _, p := range s.URLPatterns {
		if !strings.HasPrefix(p, "/") || len(p) > 512 {
			return bad("url_patterns 항목은 / 로 시작하는 512자 이하 경로여야 합니다 (%q)", p)
		}
	}
	if s.OpenAt != nil && s.CloseAt != nil && !s.CloseAt.After(*s.OpenAt) {
		return bad("close_at 은 open_at 보다 뒤여야 합니다")
	}
	for name, v := range map[string]string{
		"title": s.Title, "message": s.Message, "block_message": s.BlockMessage, "closed_message": s.ClosedMessage,
	} {
		if utf8.RuneCountInString(v) > 2000 {
			return bad("%s 는 2000자 이하여야 합니다", name)
		}
	}
	if s.ClosedURL != "" {
		if !isSafeRedirect(s.ClosedURL) {
			return bad("closed_url 은 http(s) URL 이거나 / 로 시작하는 경로여야 합니다")
		}
	}
	return nil
}

func isSafeRedirect(raw string) bool {
	if len(raw) > 2048 {
		return false
	}
	if strings.HasPrefix(raw, "/") {
		return !strings.HasPrefix(raw, "//") && !strings.HasPrefix(raw, "/\\")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// PreOpen 은 아직 오픈 시각 전인지 알려준다.
func (s *Segment) PreOpen(now time.Time) bool {
	return s.OpenAt != nil && now.Before(*s.OpenAt)
}

// Closed 는 종료 시각이 지났는지 알려준다.
func (s *Segment) Closed(now time.Time) bool {
	return s.CloseAt != nil && !now.Before(*s.CloseAt)
}

// MatchPath 는 경로가 패턴과 일치하면 패턴 길이(구체성)를, 일치하지 않으면 -1 을 돌려준다.
func (s *Segment) MatchPath(path string) int {
	best := -1
	for _, p := range s.URLPatterns {
		if globMatch(p, path) && len(p) > best {
			best = len(p)
		}
	}
	return best
}

// MatchSegment 는 경로와 가장 구체적으로 일치하는 세그먼트를 찾는다.
// 쿼리 문자열은 무시한다.
func MatchSegment(segs []Segment, rawPath string) (Segment, bool) {
	path := rawPath
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	if path == "" {
		path = "/"
	}
	sorted := make([]Segment, len(segs))
	copy(sorted, segs)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })
	var (
		found Segment
		best  = -1
	)
	for _, s := range sorted {
		if score := s.MatchPath(path); score > best {
			best, found = score, s
		}
	}
	return found, best >= 0
}

// globMatch 는 '*' 가 '/' 를 포함한 임의 문자열과 일치하는 단순 와일드카드 매칭이다.
func globMatch(pattern, s string) bool {
	// 반복적 백트래킹 구현 (최악 O(n*m))
	p, i := 0, 0
	star, match := -1, 0
	for i < len(s) {
		switch {
		case p < len(pattern) && pattern[p] == '*':
			star, match = p, i
			p++
		case p < len(pattern) && pattern[p] == s[i]:
			p++
			i++
		case star >= 0:
			p = star + 1
			match++
			i = match
		default:
			return false
		}
	}
	for p < len(pattern) && pattern[p] == '*' {
		p++
	}
	return p == len(pattern)
}
