package queue

import (
	"context"
	"errors"
	"math/rand/v2"
	"sort"
	"testing"
	"time"
)

func TestTreapMatchesSortedSlice(t *testing.T) {
	type item struct {
		score int64
		id    string
	}
	var (
		tr  treap
		ref []item
	)
	r := rand.New(rand.NewPCG(1, 2))
	idx := func(it item) int {
		return sort.Search(len(ref), func(i int) bool { return !less(ref[i].score, ref[i].id, it.score, it.id) })
	}
	for i := 0; i < 5000; i++ {
		switch op := r.IntN(3); {
		case op < 2 || len(ref) == 0:
			it := item{score: r.Int64N(200), id: NewTicketID()}
			tr.Insert(it.score, it.id)
			j := idx(it)
			ref = append(ref, item{})
			copy(ref[j+1:], ref[j:])
			ref[j] = it
		default:
			j := r.IntN(len(ref))
			if !tr.Delete(ref[j].score, ref[j].id) {
				t.Fatalf("delete failed for %+v", ref[j])
			}
			ref = append(ref[:j], ref[j+1:]...)
		}
		if tr.Len() != len(ref) {
			t.Fatalf("len %d != %d", tr.Len(), len(ref))
		}
		if len(ref) > 0 {
			j := r.IntN(len(ref))
			if got := tr.Rank(ref[j].score, ref[j].id); got != int64(j) {
				t.Fatalf("rank = %d, want %d", got, j)
			}
		}
	}
	if tr.Delete(-1, "missing") {
		t.Fatal("deleting missing element should return false")
	}
}

func TestGlobAndMatchSegment(t *testing.T) {
	cases := []struct {
		pattern, path string
		want          bool
	}{
		{"/event/*", "/event/2026/sale", true},
		{"/event/*", "/event/", true},
		{"/event/*", "/events", false},
		{"/order", "/order", true},
		{"/order", "/order/1", false},
		{"/*/buy", "/shop/a/buy", true},
		{"/*.do", "/goods/list.do", true},
		{"*", "/anything", true},
	}
	for _, c := range cases {
		if got := globMatch(c.pattern, c.path); got != c.want {
			t.Errorf("globMatch(%q, %q) = %v, want %v", c.pattern, c.path, got, c.want)
		}
	}
	segs := []Segment{
		{ID: "all", URLPatterns: []string{"/*"}},
		{ID: "event", URLPatterns: []string{"/event/*"}},
		{ID: "buy", URLPatterns: []string{"/event/*/buy"}},
	}
	for path, want := range map[string]string{
		"/":                 "all",
		"/event/1":          "event",
		"/event/1/buy?x=1":  "buy",
		"/event/1/buy#frag": "buy",
	} {
		got, ok := MatchSegment(segs, path)
		if !ok || got.ID != want {
			t.Errorf("MatchSegment(%q) = %q,%v want %q", path, got.ID, ok, want)
		}
	}
	if _, ok := MatchSegment(segs[1:], "/other"); ok {
		t.Error("unexpected match")
	}
}

func TestSegmentValidate(t *testing.T) {
	ok := Segment{ID: "evt-1", MaxActive: 10}
	ok.Normalize()
	if err := ok.Validate(); err != nil {
		t.Fatalf("valid segment rejected: %v", err)
	}
	if ok.Mode != ModeQueue || ok.ActiveTTL != DefaultActiveTTL || ok.PassTTL != DefaultPassTTL || ok.Name != "evt-1" {
		t.Fatalf("defaults not applied: %+v", ok)
	}
	open := time.Now()
	closeAt := open.Add(-time.Hour)
	bad := []Segment{
		{ID: "has space"},
		{ID: ""},
		{ID: "x", Mode: "weird"},
		{ID: "x", MaxActive: -1},
		{ID: "x", URLPatterns: []string{"no-slash"}},
		{ID: "x", ClosedURL: "javascript:alert(1)"},
		{ID: "x", ClosedURL: "//evil.example"},
		{ID: "x", OpenAt: &open, CloseAt: &closeAt},
		{ID: "x", ActiveTTL: 100000},
	}
	for i, s := range bad {
		s.Normalize()
		if err := s.Validate(); !errors.Is(err, ErrInvalidSegment) {
			t.Errorf("case %d: expected validation error, got %v", i, err)
		}
	}
}

func newTestEngine(t *testing.T) (*Engine, *clock) {
	t.Helper()
	st, err := NewMemoryStore("")
	if err != nil {
		t.Fatal(err)
	}
	e, err := NewEngine(context.Background(), st, EngineConfig{LiveWindow: 20 * time.Second, WaitTTL: time.Minute}, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := newClock()
	e.SetClock(c.now)
	return e, c
}

func TestEngineModes(t *testing.T) {
	ctx := context.Background()
	e, c := newTestEngine(t)
	if _, err := e.Enter(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown segment err = %v", err)
	}
	s, err := e.SaveSegment(ctx, Segment{ID: "m", MaxActive: 0, BlockMessage: "점검 중", ClosedMessage: "종료", ClosedURL: "/done"})
	if err != nil {
		t.Fatal(err)
	}
	w, err := e.Enter(ctx, "m")
	if err != nil || w.Status != StatusWait || w.Position != 1 || w.Ticket == "" {
		t.Fatalf("wait response = %+v err=%v", w, err)
	}

	s.Mode = ModeBlock
	if _, err := e.SaveSegment(ctx, s); err != nil {
		t.Fatal(err)
	}
	r, _ := e.Poll(ctx, "m", w.Ticket)
	if r.Status != StatusBlocked || r.Message != "점검 중" {
		t.Fatalf("blocked poll = %+v", r)
	}
	r, _ = e.Enter(ctx, "m")
	if r.Status != StatusBlocked || r.Ticket != "" {
		t.Fatalf("blocked enter = %+v", r)
	}

	s.Mode = ModeBypass
	e.SaveSegment(ctx, s)
	r, _ = e.Enter(ctx, "m")
	if r.Status != StatusPass || !r.Bypass {
		t.Fatalf("bypass enter = %+v", r)
	}

	s.Mode = ModeQueue
	closeAt := c.now().Add(time.Minute)
	s.CloseAt = &closeAt
	e.SaveSegment(ctx, s)
	c.add(2 * time.Minute)
	r, _ = e.Enter(ctx, "m")
	if r.Status != StatusClosed || r.RedirectURL != "/done" || r.Message != "종료" {
		t.Fatalf("closed enter = %+v", r)
	}
	e.Tick(ctx)
	st, _ := e.StatsFor("m", false)
	if st.Blocked != 2 || st.ClosedHits != 1 || !st.Closed {
		t.Fatalf("stats = %+v", st)
	}
}

func TestEnginePreOpenAndETA(t *testing.T) {
	ctx := context.Background()
	e, c := newTestEngine(t)
	openAt := c.now().Add(5 * time.Second)
	if _, err := e.SaveSegment(ctx, Segment{ID: "o", MaxActive: 1, ActiveTTL: 1, OpenAt: &openAt}); err != nil {
		t.Fatal(err)
	}
	r, _ := e.Enter(ctx, "o")
	if r.Status != StatusPreWait || r.OpenInMs != 5000 || r.NextPollMs != 5000 {
		t.Fatalf("pre-wait = %+v", r)
	}
	c.add(5 * time.Second)
	r, _ = e.Poll(ctx, "o", r.Ticket)
	if r.Status != StatusPass || r.ActiveTTL != 1 {
		t.Fatalf("after open = %+v", r)
	}

	// 1초마다 1명씩 입장하는 흐름을 만들어 입장 속도와 예상 대기 시간을 확인한다.
	var waiting []string
	for i := 0; i < 10; i++ {
		w, _ := e.Enter(ctx, "o")
		waiting = append(waiting, w.Ticket)
	}
	for i := 0; i < 8; i++ {
		c.add(time.Second)
		for _, id := range waiting {
			e.Poll(ctx, "o", id)
		}
		e.Tick(ctx)
	}
	st, _ := e.StatsFor("o", true)
	if st.AdmitRate < 0.8 || st.AdmitRate > 1.2 {
		t.Fatalf("admit rate = %v, want ~1/s", st.AdmitRate)
	}
	if len(st.Series) == 0 || st.Series[len(st.Series)-1].Waiting != st.Waiting {
		t.Fatalf("series = %+v", st.Series)
	}
	r, _ = e.Poll(ctx, "o", waiting[len(waiting)-1])
	if r.Status != StatusWait || r.ETASec < 1 || r.ETASec > 4 {
		t.Fatalf("eta response = %+v", r)
	}
	if r.NextPollMs < 1000 || r.NextPollMs > 10000 {
		t.Fatalf("next poll = %d", r.NextPollMs)
	}
}

func TestEngineSeedOnlyWhenEmpty(t *testing.T) {
	ctx := context.Background()
	e, _ := newTestEngine(t)
	if err := e.Seed(ctx, []Segment{{ID: "a", MaxActive: 5}}); err != nil {
		t.Fatal(err)
	}
	if err := e.Seed(ctx, []Segment{{ID: "b", MaxActive: 5}}); err != nil {
		t.Fatal(err)
	}
	segs := e.Segments()
	if len(segs) != 1 || segs[0].ID != "a" {
		t.Fatalf("segments = %+v", segs)
	}
	if err := e.Seed(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
}

func TestTicketIDFormat(t *testing.T) {
	id := NewTicketID()
	if !ValidTicketID(id) {
		t.Fatalf("generated id invalid: %q", id)
	}
	for _, bad := range []string{"", "short", "aaaaaaaaaaaaaaaaaaaaa!", "aaaaaaaaaaaaaaaaaaaaaaa"} {
		if ValidTicketID(bad) {
			t.Errorf("ValidTicketID(%q) = true", bad)
		}
	}
}
