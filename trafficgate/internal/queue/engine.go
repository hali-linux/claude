package queue

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Status 는 클라이언트에게 전달되는 대기 상태이다.
type Status string

const (
	StatusPass    Status = "PASS"     // 입장 허용
	StatusWait    Status = "WAIT"     // 대기 중
	StatusPreWait Status = "PRE_WAIT" // 오픈 전 사전 대기
	StatusBlocked Status = "BLOCKED"  // 차단됨
	StatusClosed  Status = "CLOSED"   // 종료됨
	StatusFull    Status = "FULL"     // 대기열이 가득 참
	StatusExpired Status = "EXPIRED"  // 티켓 만료(다시 진입 필요)
)

// EngineConfig 는 대기열 전역 설정이다.
type EngineConfig struct {
	// LiveWindow 동안 폴링하지 않은 대기자는 "stale" 로 간주되어 다른 사람의 입장을 막지 않는다
	// (순번은 유지되며, 다시 폴링하면 원래 자리로 복귀한다).
	LiveWindow time.Duration
	// WaitTTL 동안 폴링하지 않은 대기자는 이탈로 간주하고 대기열에서 제거한다.
	WaitTTL time.Duration
	// 클라이언트 폴링 간격 범위.
	MinPoll time.Duration
	MaxPoll time.Duration
	// SweepInterval 마다 만료 슬롯/이탈 대기자를 정리하고 통계를 갱신한다.
	SweepInterval time.Duration
	// SegmentRefresh 마다 저장소의 세그먼트 설정 변경을 확인한다(클러스터 동기화).
	SegmentRefresh time.Duration
}

func (c *EngineConfig) setDefaults() {
	if c.LiveWindow <= 0 {
		c.LiveWindow = 30 * time.Second
	}
	if c.WaitTTL <= 0 {
		c.WaitTTL = 5 * time.Minute
	}
	if c.MinPoll <= 0 {
		c.MinPoll = time.Second
	}
	if c.MaxPoll <= 0 {
		c.MaxPoll = 10 * time.Second
	}
	if c.SweepInterval <= 0 {
		c.SweepInterval = time.Second
	}
	if c.SegmentRefresh <= 0 {
		c.SegmentRefresh = 2 * time.Second
	}
}

// Response 는 대기열 API 응답이다.
type Response struct {
	Status      Status      `json:"status"`
	Segment     string      `json:"segment"`
	Ticket      string      `json:"ticket,omitempty"`
	Position    int64       `json:"position,omitempty"`     // 내 대기 순번(1부터)
	Behind      int64       `json:"behind,omitempty"`       // 내 뒤의 대기자 수
	Waiting     int64       `json:"waiting"`                // 현재 대기자 수
	ETASec      int64       `json:"eta_sec"`                // 예상 대기 시간(초), -1 이면 계산 불가
	NextPollMs  int64       `json:"next_poll_ms,omitempty"` // 다음 폴링까지 권장 대기 시간
	OpenInMs    int64       `json:"open_in_ms,omitempty"`   // 오픈까지 남은 시간
	ActiveTTL   int         `json:"active_ttl_sec,omitempty"`
	WaitedMs    int64       `json:"waited_ms,omitempty"`
	Bypass      bool        `json:"bypass,omitempty"`
	Message     string      `json:"message,omitempty"`
	RedirectURL string      `json:"redirect_url,omitempty"`
	Token       string      `json:"token,omitempty"`
	TokenTTL    int         `json:"token_ttl_sec,omitempty"`
	Info        *PublicInfo `json:"info,omitempty"`
}

// PublicInfo 는 대기 화면에 표시할 세그먼트 정보이다.
type PublicInfo struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	Title          string     `json:"title,omitempty"`
	Message        string     `json:"message,omitempty"`
	Mode           Mode       `json:"mode"`
	OpenAt         *time.Time `json:"open_at,omitempty"`
	CloseAt        *time.Time `json:"close_at,omitempty"`
	PreQueueRandom bool       `json:"pre_queue_random,omitempty"`
}

// Info 는 세그먼트의 공개 정보를 만든다.
func (s *Segment) Info() *PublicInfo {
	return &PublicInfo{
		ID: s.ID, Name: s.Name, Title: s.Title, Message: s.Message, Mode: s.Mode,
		OpenAt: s.OpenAt, CloseAt: s.CloseAt, PreQueueRandom: s.PreQueueRandom,
	}
}

// Point 는 대시보드 그래프용 시계열 한 점이다.
type Point struct {
	T         int64   `json:"t"`
	Waiting   int64   `json:"waiting"`
	Active    int64   `json:"active"`
	AdmitRate float64 `json:"admit_rate"`
}

// SegmentStats 는 관리 콘솔/메트릭용 세그먼트 상태이다.
type SegmentStats struct {
	Segment    Segment  `json:"segment"`
	Waiting    int64    `json:"waiting"`      // 전체 대기자(live + stale)
	Live       int64    `json:"live"`         // 최근 폴링한 대기자
	Active     int64    `json:"active"`       // 입장해 있는 사용자
	AdmitRate  float64  `json:"admit_rate"`   // 초당 입장 수(최근 60초 평균)
	EnterRate  float64  `json:"enter_rate"`   // 초당 신규 진입 수
	AvgWaitSec float64  `json:"avg_wait_sec"` // 최근 60초 입장자의 평균 대기 시간
	ETASec     int64    `json:"eta_sec"`      // 지금 진입하는 사용자의 예상 대기 시간
	PreOpen    bool     `json:"pre_open"`
	Closed     bool     `json:"closed"`
	Totals     Counters `json:"totals"`
	Blocked    int64    `json:"blocked"`     // (이 서버) 차단 응답 수
	ClosedHits int64    `json:"closed_hits"` // (이 서버) 종료 응답 수
	Series     []Point  `json:"series"`
	Recent     []Bucket `json:"recent"`
	UpdatedAt  int64    `json:"updated_at"`
}

const historyLen = 300 // 대시보드 그래프 보관 길이(초)

type segRuntime struct {
	stats   SegmentStats
	history []Point
	blocked atomic.Int64
	closed  atomic.Int64
}

// Engine 은 세그먼트 설정 캐시와 저장소를 묶어 대기열 정책을 적용한다.
type Engine struct {
	store Store
	cfg   EngineConfig
	log   *slog.Logger
	now   func() time.Time
	start time.Time

	mu       sync.RWMutex
	segs     map[string]Segment
	segList  []Segment
	segVer   int64
	runtimes map[string]*segRuntime
}

// NewEngine 은 엔진을 만들고 저장소에서 세그먼트를 불러온다.
func NewEngine(ctx context.Context, store Store, cfg EngineConfig, log *slog.Logger) (*Engine, error) {
	cfg.setDefaults()
	if log == nil {
		log = slog.Default()
	}
	e := &Engine{
		store:    store,
		cfg:      cfg,
		log:      log,
		now:      time.Now,
		segs:     map[string]Segment{},
		runtimes: map[string]*segRuntime{},
	}
	e.start = e.now()
	if err := e.refreshSegments(ctx, true); err != nil {
		return nil, err
	}
	return e, nil
}

// SetClock 은 테스트용 시계를 설정한다.
func (e *Engine) SetClock(now func() time.Time) {
	e.now = now
	e.start = now()
}

// Config 는 엔진 설정을 돌려준다.
func (e *Engine) Config() EngineConfig { return e.cfg }

// Store 는 저장소를 돌려준다.
func (e *Engine) Store() Store { return e.store }

// Run 은 정리/통계/설정 동기화 루프를 ctx 가 끝날 때까지 실행한다.
func (e *Engine) Run(ctx context.Context) {
	sweep := time.NewTicker(e.cfg.SweepInterval)
	refresh := time.NewTicker(e.cfg.SegmentRefresh)
	defer sweep.Stop()
	defer refresh.Stop()
	e.Tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-sweep.C:
			e.Tick(ctx)
		case <-refresh.C:
			if err := e.refreshSegments(ctx, false); err != nil {
				e.log.Warn("세그먼트 동기화 실패", "err", err)
			}
		}
	}
}

// Tick 은 모든 세그먼트를 정리하고 통계를 갱신한다.
func (e *Engine) Tick(ctx context.Context) {
	for _, s := range e.Segments() {
		p := e.params(s, e.now())
		if err := e.store.Sweep(ctx, s.ID, p); err != nil {
			e.log.Warn("대기열 정리 실패", "segment", s.ID, "err", err)
			continue
		}
		if err := e.updateStats(ctx, s); err != nil {
			e.log.Warn("통계 갱신 실패", "segment", s.ID, "err", err)
		}
	}
}

func (e *Engine) refreshSegments(ctx context.Context, force bool) error {
	ver, err := e.store.SegmentsVersion(ctx)
	if err != nil {
		return err
	}
	e.mu.RLock()
	same := ver == e.segVer
	e.mu.RUnlock()
	if same && !force {
		return nil
	}
	list, err := e.store.ListSegments(ctx)
	if err != nil {
		return err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.segVer = ver
	e.segs = make(map[string]Segment, len(list))
	for _, s := range list {
		e.segs[s.ID] = s
		if e.runtimes[s.ID] == nil {
			e.runtimes[s.ID] = &segRuntime{}
		}
	}
	for id := range e.runtimes {
		if _, ok := e.segs[id]; !ok {
			delete(e.runtimes, id)
		}
	}
	e.segList = list
	return nil
}

// Segments 는 모든 세그먼트(ID 순)를 돌려준다.
func (e *Engine) Segments() []Segment {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make([]Segment, len(e.segList))
	copy(out, e.segList)
	return out
}

// Segment 는 세그먼트 하나를 돌려준다.
func (e *Engine) Segment(id string) (Segment, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	s, ok := e.segs[id]
	return s, ok
}

// MatchURL 은 경로와 일치하는 세그먼트를 찾는다.
func (e *Engine) MatchURL(path string) (Segment, bool) {
	e.mu.RLock()
	list := e.segList
	e.mu.RUnlock()
	return MatchSegment(list, path)
}

// SaveSegment 는 세그먼트를 검증 후 저장한다.
func (e *Engine) SaveSegment(ctx context.Context, s Segment) (Segment, error) {
	s.Normalize()
	if err := s.Validate(); err != nil {
		return Segment{}, err
	}
	s.UpdatedAt = e.now().UTC().Truncate(time.Second)
	if err := e.store.SaveSegment(ctx, s); err != nil {
		return Segment{}, err
	}
	return s, e.refreshSegments(ctx, true)
}

// DeleteSegment 는 세그먼트와 대기열 데이터를 삭제한다.
func (e *Engine) DeleteSegment(ctx context.Context, id string) error {
	if err := e.store.DeleteSegment(ctx, id); err != nil {
		return err
	}
	return e.refreshSegments(ctx, true)
}

// ResetSegment 는 세그먼트의 대기열과 활성 슬롯을 모두 비운다(누적 통계는 유지).
func (e *Engine) ResetSegment(ctx context.Context, id string) error {
	if _, ok := e.Segment(id); !ok {
		return ErrNotFound
	}
	return e.store.Reset(ctx, id)
}

// Seed 는 저장소에 세그먼트가 하나도 없을 때 초기 세그먼트를 등록한다.
func (e *Engine) Seed(ctx context.Context, segs []Segment) error {
	if len(segs) == 0 || len(e.Segments()) > 0 {
		return nil
	}
	for _, s := range segs {
		if _, err := e.SaveSegment(ctx, s); err != nil {
			return fmt.Errorf("초기 세그먼트 %q 등록 실패: %w", s.ID, err)
		}
		e.log.Info("초기 세그먼트 등록", "segment", s.ID)
	}
	return nil
}

func (e *Engine) params(s Segment, now time.Time) Params {
	p := Params{
		Now:        now,
		MaxActive:  s.MaxActive,
		ActiveTTL:  time.Duration(s.ActiveTTL) * time.Second,
		LiveWindow: e.cfg.LiveWindow,
		WaitTTL:    e.cfg.WaitTTL,
		MaxWaiting: s.MaxWaiting,
		PreOpen:    s.PreOpen(now),
	}
	if p.PreOpen && s.PreQueueRandom {
		p.Shuffle = true
		p.RandomScore = randomScore()
	}
	return p
}

func randomScore() int64 {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return int64(binary.BigEndian.Uint64(b[:]) & uint64(scoreBase-1))
}

// NewTicketID 는 추측 불가능한 128비트 티켓 ID 를 만든다.
func NewTicketID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// ValidTicketID 는 티켓 ID 형식을 검사한다.
func ValidTicketID(id string) bool {
	if len(id) != 22 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (e *Engine) runtime(id string) *segRuntime {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.runtimes[id]
}

// gateStatus 는 모드/일정에 따라 대기열을 거치지 않는 응답을 만든다.
func (e *Engine) gateStatus(s Segment, now time.Time) (Response, bool) {
	switch {
	case s.Mode == ModeBlock:
		if rt := e.runtime(s.ID); rt != nil {
			rt.blocked.Add(1)
		}
		msg := s.BlockMessage
		return Response{Status: StatusBlocked, Segment: s.ID, ETASec: -1, Message: msg, NextPollMs: e.cfg.MaxPoll.Milliseconds()}, true
	case s.Closed(now):
		if rt := e.runtime(s.ID); rt != nil {
			rt.closed.Add(1)
		}
		return Response{Status: StatusClosed, Segment: s.ID, ETASec: -1, Message: s.ClosedMessage, RedirectURL: s.ClosedURL}, true
	case s.Mode == ModeBypass:
		return Response{Status: StatusPass, Segment: s.ID, Bypass: true, ETASec: 0}, true
	}
	return Response{}, false
}

// Enter 는 새 티켓을 발급한다(빈 자리가 있으면 바로 입장).
func (e *Engine) Enter(ctx context.Context, segID string) (Response, error) {
	s, ok := e.Segment(segID)
	if !ok {
		return Response{}, ErrNotFound
	}
	now := e.now()
	if r, done := e.gateStatus(s, now); done {
		return r, nil
	}
	p := e.params(s, now)
	var (
		id  string
		out Outcome
		err error
	)
	for attempt := 0; attempt < 3; attempt++ {
		id = NewTicketID()
		out, err = e.store.Enter(ctx, segID, id, p)
		if !errors.Is(err, ErrDuplicateTicket) {
			break
		}
	}
	if err != nil {
		return Response{}, err
	}
	if out.Code == CodeFull {
		return Response{Status: StatusFull, Segment: segID, Waiting: out.Live, ETASec: -1, NextPollMs: e.cfg.MaxPoll.Milliseconds()}, nil
	}
	return e.respond(s, id, out, now), nil
}

// Poll 은 티켓의 대기 상태를 확인한다(차례가 되면 입장).
func (e *Engine) Poll(ctx context.Context, segID, ticketID string) (Response, error) {
	s, ok := e.Segment(segID)
	if !ok {
		return Response{}, ErrNotFound
	}
	now := e.now()
	if r, done := e.gateStatus(s, now); done {
		// 대기열을 거치지 않게 되었으므로 남아 있는 티켓은 정리한다.
		if _, err := e.store.Complete(ctx, segID, ticketID, e.params(s, now)); err != nil {
			return Response{}, err
		}
		return r, nil
	}
	out, err := e.store.Poll(ctx, segID, ticketID, e.params(s, now))
	if err != nil {
		return Response{}, err
	}
	return e.respond(s, ticketID, out, now), nil
}

// Alive 는 입장한 사용자의 슬롯 점유 시간을 연장한다(구간 제어 중 하트비트).
func (e *Engine) Alive(ctx context.Context, segID, ticketID string) (bool, error) {
	s, ok := e.Segment(segID)
	if !ok {
		return false, ErrNotFound
	}
	return e.store.Alive(ctx, segID, ticketID, e.params(s, e.now()))
}

// Complete 는 입장한 사용자의 슬롯을 반환하거나 대기를 취소한다.
func (e *Engine) Complete(ctx context.Context, segID, ticketID string) (bool, error) {
	s, ok := e.Segment(segID)
	if !ok {
		return false, ErrNotFound
	}
	return e.store.Complete(ctx, segID, ticketID, e.params(s, e.now()))
}

func (e *Engine) respond(s Segment, ticketID string, out Outcome, now time.Time) Response {
	r := Response{Segment: s.ID, Ticket: ticketID, Waiting: out.Live, ETASec: -1}
	switch out.Code {
	case CodePass:
		r.Status = StatusPass
		r.ActiveTTL = s.ActiveTTL
		r.WaitedMs = out.WaitedMs
		r.ETASec = 0
	case CodeWait:
		r.Status = StatusWait
		r.Position = out.Rank + 1
		r.Behind = max(out.Live-r.Position, 0)
		r.ETASec = e.eta(s.ID, r.Position)
		r.NextPollMs = e.nextPoll(s, r.Position, r.ETASec).Milliseconds()
	case CodePreWait:
		r.Status = StatusPreWait
		r.Position = out.Rank + 1
		r.Behind = max(out.Live-r.Position, 0)
		openIn := time.Duration(0)
		if s.OpenAt != nil {
			openIn = s.OpenAt.Sub(now)
		}
		r.OpenInMs = max(openIn.Milliseconds(), 0)
		next := min(max(openIn, e.cfg.MinPoll), e.cfg.MaxPoll)
		r.NextPollMs = next.Milliseconds()
	case CodeExpired:
		r.Status = StatusExpired
		r.Ticket = ""
	default:
		r.Status = StatusExpired
	}
	return r
}

// eta 는 순번과 최근 입장 속도로 예상 대기 시간을 계산한다.
func (e *Engine) eta(segID string, position int64) int64 {
	rt := e.runtime(segID)
	if rt == nil {
		return -1
	}
	e.mu.RLock()
	rate := rt.stats.AdmitRate
	e.mu.RUnlock()
	if rate <= 0 {
		return -1
	}
	return int64(float64(position)/rate + 0.5)
}

// nextPoll 은 순번이 앞일수록 자주, 뒤일수록 드물게 폴링하도록 권장 간격을 정한다.
// 입장은 대기자가 폴링할 때 이루어지므로, 곧 차례가 올 사용자는 최소 간격으로 폴링해 빈 슬롯이 놀지 않게 한다.
func (e *Engine) nextPoll(s Segment, position, eta int64) time.Duration {
	var d time.Duration
	switch {
	case eta >= 0:
		d = time.Duration(eta) * time.Second / 4
	case s.MaxActive > 0 && position <= int64(s.MaxActive):
		// 입장 속도를 아직 모를 때(이벤트 시작 직전 등): 한 바퀴(진입 허용 수) 안의 순번은 곧 입장한다.
		d = e.cfg.MinPoll
	case s.MaxActive > 0:
		d = time.Duration(position/int64(s.MaxActive)) * e.cfg.MinPoll
	default:
		// 진입 허용 수 0(일시 정지): 재개될 때까지 천천히 폴링
		d = e.cfg.MaxPoll
	}
	return min(max(d, e.cfg.MinPoll), e.cfg.MaxPoll)
}

// rateWindow 는 입장 속도를 계산하는 기간(초)이다. 짧을수록 변화에 빨리 반응한다.
const rateWindow = 30

// rates 는 최근 초당 통계로 입장/진입 속도와 평균 대기 시간을 계산한다.
// 진행 중인 현재 초는 제외하며, 흐름이 막 시작된 경우(이벤트 오픈 직후 등)에는
// 첫 활동 시점부터의 기간으로 나누어 속도를 과소평가하지 않는다.
func rates(series []Bucket) (admitRate, enterRate, avgWaitSec float64) {
	if len(series) < 2 {
		return 0, 0, 0
	}
	recent := series[:len(series)-1]
	if len(recent) > rateWindow {
		recent = recent[len(recent)-rateWindow:]
	}
	firstAdmit, firstEnter := -1, -1
	var sum Counters
	for i, b := range recent {
		if firstAdmit < 0 && b.Admitted > 0 {
			firstAdmit = i
		}
		if firstEnter < 0 && b.Entered > 0 {
			firstEnter = i
		}
		sum.Add(b.Counters)
	}
	if firstAdmit >= 0 {
		admitRate = float64(sum.Admitted) / float64(len(recent)-firstAdmit)
		avgWaitSec = float64(sum.WaitMsSum) / float64(sum.Admitted) / 1000
	}
	if firstEnter >= 0 {
		enterRate = float64(sum.Entered) / float64(len(recent)-firstEnter)
	}
	return admitRate, enterRate, avgWaitSec
}

func (e *Engine) updateStats(ctx context.Context, s Segment) error {
	now := e.now()
	raw, err := e.store.Stats(ctx, s.ID, now)
	if err != nil {
		return err
	}
	admitRate, enterRate, avgWait := rates(raw.Series)
	st := SegmentStats{
		Segment:    s,
		Waiting:    raw.Live + raw.Stale,
		Live:       raw.Live,
		Active:     raw.Active,
		AdmitRate:  admitRate,
		EnterRate:  enterRate,
		AvgWaitSec: avgWait,
		PreOpen:    s.PreOpen(now),
		Closed:     s.Closed(now),
		Totals:     raw.Totals,
		Recent:     raw.Series,
		UpdatedAt:  now.UnixMilli(),
	}
	switch {
	case s.Mode == ModeBypass:
		st.ETASec = 0
	case st.AdmitRate > 0:
		st.ETASec = int64(float64(raw.Live+1)/st.AdmitRate + 0.5)
	case raw.Live == 0 && raw.Active < int64(s.MaxActive):
		st.ETASec = 0
	default:
		st.ETASec = -1
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	rt := e.runtimes[s.ID]
	if rt == nil {
		return nil
	}
	rt.history = append(rt.history, Point{T: now.Unix(), Waiting: st.Waiting, Active: st.Active, AdmitRate: st.AdmitRate})
	if len(rt.history) > historyLen {
		rt.history = append(rt.history[:0], rt.history[len(rt.history)-historyLen:]...)
	}
	st.Blocked = rt.blocked.Load()
	st.ClosedHits = rt.closed.Load()
	rt.stats = st
	return nil
}

// Stats 는 모든 세그먼트의 최신 통계를 돌려준다. withSeries 가 true 이면 그래프용 시계열을 포함한다.
func (e *Engine) Stats(withSeries bool) []SegmentStats {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make([]SegmentStats, 0, len(e.segList))
	for _, s := range e.segList {
		rt := e.runtimes[s.ID]
		if rt == nil {
			continue
		}
		st := rt.stats
		st.Segment = s
		st.Blocked = rt.blocked.Load()
		st.ClosedHits = rt.closed.Load()
		if withSeries {
			st.Series = append([]Point(nil), rt.history...)
		} else {
			st.Series = nil
			st.Recent = nil
		}
		out = append(out, st)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Segment.ID < out[j].Segment.ID })
	return out
}

// StatsFor 는 한 세그먼트의 통계를 돌려준다.
func (e *Engine) StatsFor(id string, withSeries bool) (SegmentStats, bool) {
	for _, st := range e.Stats(withSeries) {
		if st.Segment.ID == id {
			return st, true
		}
	}
	return SegmentStats{}, false
}

// Uptime 은 엔진 가동 시간이다.
func (e *Engine) Uptime() time.Duration { return e.now().Sub(e.start) }
