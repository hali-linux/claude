package queue

import (
	"container/heap"
	"container/list"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// MemoryStore 는 단일 서버용 인메모리 저장소이다.
// 세그먼트 설정은 dataDir/segments.json 에, 대기열 상태는 종료 시 dataDir/state.json 에 저장해
// 재시작(업그레이드) 후에도 대기 순번이 유지된다.
type MemoryStore struct {
	mu      sync.RWMutex
	segs    map[string]*memSegment
	configs map[string]Segment
	version int64
	dataDir string
}

type memTicket struct {
	id        string
	score     int64
	created   int64 // unix ms
	lastSeen  int64 // unix ms
	active    bool
	activeExp int64 // unix ms
	heapIdx   int
	elem      *list.Element
	live      bool
}

type memSegment struct {
	mu      sync.Mutex
	seq     int64
	tickets map[string]*memTicket
	live    treap
	liveL   *list.List // live 대기 티켓, lastSeen 오름차순
	staleL  *list.List // stale 대기 티켓, lastSeen 오름차순
	active  activeHeap
	totals  Counters
	win     window
}

func newMemSegment() *memSegment {
	return &memSegment{
		tickets: make(map[string]*memTicket),
		liveL:   list.New(),
		staleL:  list.New(),
	}
}

const (
	segmentsFile = "segments.json"
	stateFile    = "state.json"
)

// NewMemoryStore 는 메모리 저장소를 만든다. dataDir 가 비어 있으면 디스크에 저장하지 않는다.
func NewMemoryStore(dataDir string) (*MemoryStore, error) {
	m := &MemoryStore{
		segs:    make(map[string]*memSegment),
		configs: make(map[string]Segment),
		dataDir: dataDir,
		version: 1,
	}
	if dataDir == "" {
		return m, nil
	}
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		return nil, fmt.Errorf("데이터 디렉터리 생성 실패: %w", err)
	}
	if err := m.loadSegments(); err != nil {
		return nil, err
	}
	if err := m.loadState(); err != nil {
		return nil, err
	}
	return m, nil
}

// ---- 세그먼트 설정 ----

func (m *MemoryStore) ListSegments(context.Context) ([]Segment, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Segment, 0, len(m.configs))
	for _, s := range m.configs {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *MemoryStore) SaveSegment(_ context.Context, s Segment) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	prev, existed := m.configs[s.ID]
	m.configs[s.ID] = s
	if err := m.persistSegmentsLocked(); err != nil {
		if existed {
			m.configs[s.ID] = prev
		} else {
			delete(m.configs, s.ID)
		}
		return err
	}
	m.version++
	return nil
}

func (m *MemoryStore) DeleteSegment(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	prev, existed := m.configs[id]
	if !existed {
		return ErrNotFound
	}
	delete(m.configs, id)
	if err := m.persistSegmentsLocked(); err != nil {
		m.configs[id] = prev
		return err
	}
	delete(m.segs, id)
	m.version++
	return nil
}

func (m *MemoryStore) SegmentsVersion(context.Context) (int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.version, nil
}

func (m *MemoryStore) seg(id string) *memSegment {
	m.mu.RLock()
	s := m.segs[id]
	m.mu.RUnlock()
	if s != nil {
		return s
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if s = m.segs[id]; s == nil {
		s = newMemSegment()
		m.segs[id] = s
	}
	return s
}

// ---- 대기열 연산 ----

func (m *MemoryStore) Enter(_ context.Context, segID, ticketID string, p Params) (Outcome, error) {
	s := m.seg(segID)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := p.Now.UnixMilli()
	s.sweep(p)
	if p.MaxWaiting > 0 && s.liveL.Len()+s.staleL.Len() >= p.MaxWaiting {
		s.count(now, func(c *Counters) { c.Rejected++ })
		return Outcome{Code: CodeFull, Live: int64(s.live.Len()), Active: int64(len(s.active))}, nil
	}
	if _, dup := s.tickets[ticketID]; dup {
		return Outcome{}, ErrDuplicateTicket
	}
	s.seq++
	score := scoreBase + s.seq
	if p.PreOpen && p.Shuffle {
		score = p.RandomScore
	}
	t := &memTicket{id: ticketID, score: score, created: now, lastSeen: now, live: true}
	s.tickets[ticketID] = t
	t.elem = s.liveL.PushBack(t)
	s.live.Insert(t.score, t.id)
	s.count(now, func(c *Counters) { c.Entered++ })
	return s.check(t, p), nil
}

func (m *MemoryStore) Poll(_ context.Context, segID, ticketID string, p Params) (Outcome, error) {
	s := m.seg(segID)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweep(p)
	t := s.tickets[ticketID]
	if t == nil {
		return Outcome{Code: CodeExpired, Live: int64(s.live.Len()), Active: int64(len(s.active))}, nil
	}
	if t.active {
		return Outcome{Code: CodePass, Live: int64(s.live.Len()), Active: int64(len(s.active))}, nil
	}
	s.touch(t, p.Now.UnixMilli())
	return s.check(t, p), nil
}

func (m *MemoryStore) Alive(_ context.Context, segID, ticketID string, p Params) (bool, error) {
	s := m.seg(segID)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := p.Now.UnixMilli()
	t := s.tickets[ticketID]
	if t == nil || !t.active || t.activeExp <= now {
		return false, nil
	}
	t.activeExp = now + p.ActiveTTL.Milliseconds()
	heap.Fix(&s.active, t.heapIdx)
	return true, nil
}

func (m *MemoryStore) Complete(_ context.Context, segID, ticketID string, p Params) (bool, error) {
	s := m.seg(segID)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := p.Now.UnixMilli()
	t := s.tickets[ticketID]
	if t == nil {
		return false, nil
	}
	if t.active {
		heap.Remove(&s.active, t.heapIdx)
		delete(s.tickets, t.id)
		s.count(now, func(c *Counters) { c.Completed++ })
		return true, nil
	}
	s.removeWaiting(t)
	delete(s.tickets, t.id)
	s.count(now, func(c *Counters) { c.Cancelled++ })
	return true, nil
}

func (m *MemoryStore) Sweep(_ context.Context, segID string, p Params) error {
	s := m.seg(segID)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweep(p)
	return nil
}

func (m *MemoryStore) Reset(_ context.Context, segID string) error {
	s := m.seg(segID)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tickets = make(map[string]*memTicket)
	s.live = treap{}
	s.liveL.Init()
	s.staleL.Init()
	s.active = nil
	return nil
}

func (m *MemoryStore) Stats(_ context.Context, segID string, now time.Time) (RawStats, error) {
	s := m.seg(segID)
	s.mu.Lock()
	defer s.mu.Unlock()
	return RawStats{
		Live:   int64(s.liveL.Len()),
		Stale:  int64(s.staleL.Len()),
		Active: int64(len(s.active)),
		Totals: s.totals,
		Series: s.win.series(now.Unix(), StatsWindow),
	}, nil
}

func (m *MemoryStore) Ping(context.Context) error { return nil }

// Close 는 대기열 상태를 디스크에 저장한다.
func (m *MemoryStore) Close() error {
	if m.dataDir == "" {
		return nil
	}
	return m.saveState(time.Now())
}

// ---- 세그먼트 내부 로직 (s.mu 보유 상태에서 호출) ----

func (s *memSegment) count(nowMs int64, f func(*Counters)) {
	f(&s.totals)
	f(s.win.at(nowMs / 1000))
}

// sweep 은 만료된 활성 슬롯을 반환하고, 오래 폴링하지 않은 대기자를 stale 로 옮기거나 제거한다.
// 각 원소는 한 번만 처리되므로 분할 상환 비용은 O(1) 이다.
func (s *memSegment) sweep(p Params) {
	now := p.Now.UnixMilli()
	for len(s.active) > 0 && s.active[0].activeExp <= now {
		t := heap.Pop(&s.active).(*memTicket)
		delete(s.tickets, t.id)
		s.count(now, func(c *Counters) { c.Expired++ })
	}
	liveCut := now - p.LiveWindow.Milliseconds()
	for e := s.liveL.Front(); e != nil; e = s.liveL.Front() {
		t := e.Value.(*memTicket)
		if t.lastSeen >= liveCut {
			break
		}
		s.liveL.Remove(e)
		s.live.Delete(t.score, t.id)
		t.live = false
		t.elem = s.staleL.PushBack(t)
	}
	waitCut := now - p.WaitTTL.Milliseconds()
	for e := s.staleL.Front(); e != nil; e = s.staleL.Front() {
		t := e.Value.(*memTicket)
		if t.lastSeen >= waitCut {
			break
		}
		s.staleL.Remove(e)
		delete(s.tickets, t.id)
		s.count(now, func(c *Counters) { c.Abandoned++ })
	}
}

func (s *memSegment) touch(t *memTicket, now int64) {
	t.lastSeen = now
	if t.live {
		s.liveL.MoveToBack(t.elem)
		return
	}
	s.staleL.Remove(t.elem)
	t.elem = s.liveL.PushBack(t)
	t.live = true
	s.live.Insert(t.score, t.id)
}

func (s *memSegment) removeWaiting(t *memTicket) {
	if t.live {
		s.liveL.Remove(t.elem)
		s.live.Delete(t.score, t.id)
	} else {
		s.staleL.Remove(t.elem)
	}
	t.elem = nil
	t.live = false
}

// check 는 대기 중인 티켓이 입장 가능한지 판단하고, 가능하면 입장시킨다.
// 입장 기준: live 대기자 중 내 순위 < 남은 슬롯 수 (엄격한 선착순)
func (s *memSegment) check(t *memTicket, p Params) Outcome {
	now := p.Now.UnixMilli()
	rank := s.live.Rank(t.score, t.id)
	out := Outcome{Rank: rank, Live: int64(s.live.Len()), Active: int64(len(s.active))}
	if p.PreOpen {
		out.Code = CodePreWait
		return out
	}
	free := int64(p.MaxActive) - int64(len(s.active))
	if rank < free {
		s.removeWaiting(t)
		t.active = true
		t.activeExp = now + p.ActiveTTL.Milliseconds()
		heap.Push(&s.active, t)
		waited := now - t.created
		s.count(now, func(c *Counters) {
			c.Admitted++
			c.WaitMsSum += waited
		})
		return Outcome{Code: CodePass, Rank: rank, Live: out.Live - 1, Active: out.Active + 1, WaitedMs: waited}
	}
	out.Code = CodeWait
	return out
}

// ---- activeHeap: activeExp 기준 최소 힙 ----

type activeHeap []*memTicket

func (h activeHeap) Len() int           { return len(h) }
func (h activeHeap) Less(i, j int) bool { return h[i].activeExp < h[j].activeExp }
func (h activeHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].heapIdx = i
	h[j].heapIdx = j
}
func (h *activeHeap) Push(x any) {
	t := x.(*memTicket)
	t.heapIdx = len(*h)
	*h = append(*h, t)
}
func (h *activeHeap) Pop() any {
	old := *h
	n := len(old)
	t := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	t.heapIdx = -1
	return t
}

// ---- 영속화 ----

func (m *MemoryStore) loadSegments() error {
	data, err := os.ReadFile(filepath.Join(m.dataDir, segmentsFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("세그먼트 파일 읽기 실패: %w", err)
	}
	var segs []Segment
	if err := json.Unmarshal(data, &segs); err != nil {
		return fmt.Errorf("세그먼트 파일 형식 오류(%s): %w", segmentsFile, err)
	}
	for _, s := range segs {
		m.configs[s.ID] = s
	}
	return nil
}

func (m *MemoryStore) persistSegmentsLocked() error {
	if m.dataDir == "" {
		return nil
	}
	segs := make([]Segment, 0, len(m.configs))
	for _, s := range m.configs {
		segs = append(segs, s)
	}
	sort.Slice(segs, func(i, j int) bool { return segs[i].ID < segs[j].ID })
	data, err := json.MarshalIndent(segs, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(m.dataDir, segmentsFile), data, 0o640)
}

type memSnapshot struct {
	SavedAt  int64                     `json:"saved_at"`
	Segments map[string]memSegSnapshot `json:"segments"`
}

type memSegSnapshot struct {
	Seq     int64               `json:"seq"`
	Totals  Counters            `json:"totals"`
	Tickets []memTicketSnapshot `json:"tickets"`
}

type memTicketSnapshot struct {
	ID        string `json:"id"`
	Score     int64  `json:"score"`
	Created   int64  `json:"created"`
	LastSeen  int64  `json:"last_seen"`
	Active    bool   `json:"active,omitempty"`
	ActiveExp int64  `json:"active_exp,omitempty"`
}

func (m *MemoryStore) saveState(now time.Time) error {
	m.mu.RLock()
	snap := memSnapshot{SavedAt: now.UnixMilli(), Segments: make(map[string]memSegSnapshot, len(m.segs))}
	for id, s := range m.segs {
		if _, ok := m.configs[id]; !ok {
			continue
		}
		s.mu.Lock()
		ss := memSegSnapshot{Seq: s.seq, Totals: s.totals, Tickets: make([]memTicketSnapshot, 0, len(s.tickets))}
		for _, t := range s.tickets {
			ss.Tickets = append(ss.Tickets, memTicketSnapshot{
				ID: t.id, Score: t.score, Created: t.created, LastSeen: t.lastSeen,
				Active: t.active, ActiveExp: t.activeExp,
			})
		}
		s.mu.Unlock()
		snap.Segments[id] = ss
	}
	m.mu.RUnlock()
	data, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(m.dataDir, stateFile), data, 0o640)
}

func (m *MemoryStore) loadState() error {
	path := filepath.Join(m.dataDir, stateFile)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("상태 파일 읽기 실패: %w", err)
	}
	// 한 번 복원한 스냅숏은 지운다(오래된 상태가 다시 복원되지 않도록).
	defer os.Remove(path)
	var snap memSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		// 손상된 스냅숏은 무시하고 빈 대기열로 시작한다.
		return nil
	}
	for id, ss := range snap.Segments {
		if _, ok := m.configs[id]; !ok {
			continue
		}
		s := newMemSegment()
		s.seq = ss.Seq
		s.totals = ss.Totals
		waiting := make([]memTicketSnapshot, 0, len(ss.Tickets))
		for _, ts := range ss.Tickets {
			if ts.Active {
				t := &memTicket{id: ts.ID, score: ts.Score, created: ts.Created, lastSeen: ts.LastSeen, active: true, activeExp: ts.ActiveExp}
				s.tickets[t.id] = t
				heap.Push(&s.active, t)
				continue
			}
			waiting = append(waiting, ts)
		}
		sort.Slice(waiting, func(i, j int) bool { return waiting[i].LastSeen < waiting[j].LastSeen })
		for _, ts := range waiting {
			t := &memTicket{id: ts.ID, score: ts.Score, created: ts.Created, lastSeen: ts.LastSeen, live: true}
			s.tickets[t.id] = t
			t.elem = s.liveL.PushBack(t)
			s.live.Insert(t.score, t.id)
		}
		m.segs[id] = s
	}
	return nil
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".tmp-"+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	cleanup := func() { _ = os.Remove(tmp) }
	if _, err := f.Write(data); err != nil {
		f.Close()
		cleanup()
		return err
	}
	if err := f.Chmod(perm); err != nil {
		f.Close()
		cleanup()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		cleanup()
		return err
	}
	if err := f.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		cleanup()
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}
