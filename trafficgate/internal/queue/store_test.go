package queue

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 같은 테스트를 메모리 저장소와 Redis 저장소에 모두 실행해 두 구현의 동작이 같음을 보장한다.
// Redis 테스트는 TG_TEST_REDIS(주소) 가 지정되었거나 redis-server 실행 파일이 있을 때만 실행된다.

var testRedisAddr string

func TestMain(m *testing.M) {
	code := func() int {
		if addr := os.Getenv("TG_TEST_REDIS"); addr != "" {
			testRedisAddr = addr
		} else if path, err := exec.LookPath("redis-server"); err == nil {
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err == nil {
				port := ln.Addr().(*net.TCPAddr).Port
				ln.Close()
				cmd := exec.Command(path, "--port", fmt.Sprint(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no")
				if err := cmd.Start(); err == nil {
					defer func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() }()
					addr := fmt.Sprintf("127.0.0.1:%d", port)
					for i := 0; i < 50; i++ {
						if c, err := net.Dial("tcp", addr); err == nil {
							c.Close()
							testRedisAddr = addr
							break
						}
						time.Sleep(100 * time.Millisecond)
					}
				}
			}
		}
		return m.Run()
	}()
	os.Exit(code)
}

var prefixSeq atomic.Int64

func newRedisTestStore(t *testing.T) *RedisStore {
	t.Helper()
	if testRedisAddr == "" {
		t.Skip("Redis 를 사용할 수 없어 건너뜀 (TG_TEST_REDIS 또는 redis-server 필요)")
	}
	rs, err := NewRedisStore(RedisOptions{
		Addrs:     []string{testRedisAddr},
		KeyPrefix: fmt.Sprintf("tgtest:%d:%d:", os.Getpid(), prefixSeq.Add(1)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := rs.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { rs.Close() })
	return rs
}

func eachStore(t *testing.T, fn func(t *testing.T, st Store)) {
	t.Run("memory", func(t *testing.T) {
		st, err := NewMemoryStore("")
		if err != nil {
			t.Fatal(err)
		}
		fn(t, st)
	})
	t.Run("redis", func(t *testing.T) {
		fn(t, newRedisTestStore(t))
	})
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time      { return c.t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }
func newClock() *clock               { return &clock{t: time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)} }
func (c *clock) params(maxActive int) Params {
	return Params{
		Now:        c.t,
		MaxActive:  maxActive,
		ActiveTTL:  30 * time.Second,
		LiveWindow: 20 * time.Second,
		WaitTTL:    2 * time.Minute,
	}
}

func mustEnter(t *testing.T, st Store, seg string, p Params) (string, Outcome) {
	t.Helper()
	id := NewTicketID()
	out, err := st.Enter(context.Background(), seg, id, p)
	if err != nil {
		t.Fatal(err)
	}
	return id, out
}

func mustPoll(t *testing.T, st Store, seg, id string, p Params) Outcome {
	t.Helper()
	out, err := st.Poll(context.Background(), seg, id, p)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func expectCode(t *testing.T, got Outcome, want Code, label string) {
	t.Helper()
	if got.Code != want {
		t.Fatalf("%s: code = %d, want %d (outcome %+v)", label, got.Code, want, got)
	}
}

func TestStoreFIFOAdmission(t *testing.T) {
	eachStore(t, func(t *testing.T, st Store) {
		ctx := context.Background()
		c := newClock()
		p := c.params(2)

		a, oa := mustEnter(t, st, "s", p)
		_, ob := mustEnter(t, st, "s", p)
		expectCode(t, oa, CodePass, "A")
		expectCode(t, ob, CodePass, "B")

		cID, oc := mustEnter(t, st, "s", p)
		dID, od := mustEnter(t, st, "s", p)
		eID, oe := mustEnter(t, st, "s", p)
		expectCode(t, oc, CodeWait, "C")
		expectCode(t, od, CodeWait, "D")
		expectCode(t, oe, CodeWait, "E")
		if oc.Rank != 0 || od.Rank != 1 || oe.Rank != 2 {
			t.Fatalf("ranks = %d,%d,%d, want 0,1,2", oc.Rank, od.Rank, oe.Rank)
		}
		if oe.Live != 3 || oe.Active != 2 {
			t.Fatalf("E live=%d active=%d, want 3,2", oe.Live, oe.Active)
		}

		// A 가 슬롯을 반환하면 빈 자리 1개 → 맨 앞(C)만 입장 가능, D 는 여전히 대기
		c.add(time.Second)
		p = c.params(2)
		if ok, err := st.Complete(ctx, "s", a, p); err != nil || !ok {
			t.Fatalf("complete A: ok=%v err=%v", ok, err)
		}
		expectCode(t, mustPoll(t, st, "s", dID, p), CodeWait, "D before C")
		oc = mustPoll(t, st, "s", cID, p)
		expectCode(t, oc, CodePass, "C after A completes")
		if oc.WaitedMs != 1000 {
			t.Fatalf("C waited %dms, want 1000", oc.WaitedMs)
		}
		// 이미 입장한 티켓을 다시 폴링해도 PASS
		expectCode(t, mustPoll(t, st, "s", cID, p), CodePass, "C re-poll")
		od = mustPoll(t, st, "s", dID, p)
		expectCode(t, od, CodeWait, "D no free slot")
		if od.Rank != 0 {
			t.Fatalf("D rank = %d, want 0", od.Rank)
		}
		_ = eID

		raw, err := st.Stats(ctx, "s", c.now())
		if err != nil {
			t.Fatal(err)
		}
		if raw.Live != 2 || raw.Active != 2 {
			t.Fatalf("stats live=%d active=%d, want 2,2", raw.Live, raw.Active)
		}
		if raw.Totals.Entered != 5 || raw.Totals.Admitted != 3 || raw.Totals.Completed != 1 {
			t.Fatalf("totals = %+v", raw.Totals)
		}
		if raw.Totals.WaitMsSum != 1000 {
			t.Fatalf("wait sum = %d, want 1000", raw.Totals.WaitMsSum)
		}
		last := raw.Series[len(raw.Series)-1]
		if last.Unix != c.now().Unix() || last.Admitted != 1 || last.Completed != 1 {
			t.Fatalf("last bucket = %+v", last)
		}
	})
}

func TestStoreActiveExpiryAndAlive(t *testing.T) {
	eachStore(t, func(t *testing.T, st Store) {
		ctx := context.Background()
		c := newClock()
		p := c.params(1)
		a, _ := mustEnter(t, st, "s", p)
		b, ob := mustEnter(t, st, "s", p)
		expectCode(t, ob, CodeWait, "B")

		// 20초 후 하트비트로 연장 → 30초 시점에도 슬롯 유지
		c.add(20 * time.Second)
		if ok, err := st.Alive(ctx, "s", a, c.params(1)); err != nil || !ok {
			t.Fatalf("alive: ok=%v err=%v", ok, err)
		}
		c.add(15 * time.Second)
		expectCode(t, mustPoll(t, st, "s", b, c.params(1)), CodeWait, "B while A alive")

		// 연장된 만료 시각(20+30=50초)이 지나면 슬롯이 반환되어 B 입장
		c.add(16 * time.Second)
		expectCode(t, mustPoll(t, st, "s", b, c.params(1)), CodePass, "B after A expired")
		if ok, _ := st.Alive(ctx, "s", a, c.params(1)); ok {
			t.Fatal("alive on expired ticket should fail")
		}
		expectCode(t, mustPoll(t, st, "s", a, c.params(1)), CodeExpired, "A expired")
		raw, _ := st.Stats(ctx, "s", c.now())
		if raw.Totals.Expired != 1 {
			t.Fatalf("expired = %d, want 1", raw.Totals.Expired)
		}
	})
}

func TestStoreStaleWaiterDoesNotBlock(t *testing.T) {
	eachStore(t, func(t *testing.T, st Store) {
		ctx := context.Background()
		c := newClock()
		holder, _ := mustEnter(t, st, "s", c.params(1))
		a, oa := mustEnter(t, st, "s", c.params(1)) // 1번 대기자 (곧 폴링을 멈춤)
		b, _ := mustEnter(t, st, "s", c.params(1))  // 2번 대기자
		expectCode(t, oa, CodeWait, "A")

		// B 만 계속 폴링하고 A 는 live window(20s) 동안 폴링하지 않음
		for i := 0; i < 5; i++ {
			c.add(5 * time.Second)
			mustPoll(t, st, "s", b, c.params(1))
		}
		if err := st.Sweep(ctx, "s", c.params(1)); err != nil {
			t.Fatal(err)
		}
		raw, _ := st.Stats(ctx, "s", c.now())
		if raw.Live != 1 || raw.Stale != 1 {
			t.Fatalf("live=%d stale=%d, want 1,1", raw.Live, raw.Stale)
		}
		// 슬롯이 비면 stale 인 A 대신 live 인 B 가 입장한다
		if ok, _ := st.Complete(ctx, "s", holder, c.params(1)); !ok {
			t.Fatal("complete holder failed")
		}
		ob := mustPoll(t, st, "s", b, c.params(1))
		expectCode(t, ob, CodePass, "B passes stale A")

		// A 가 돌아오면 원래 순번(뒤에 온 C 보다 앞)을 유지한다
		cID, _ := mustEnter(t, st, "s", c.params(1))
		c.add(time.Second)
		oa = mustPoll(t, st, "s", a, c.params(1))
		expectCode(t, oa, CodeWait, "A back")
		if oa.Rank != 0 {
			t.Fatalf("A rank = %d, want 0", oa.Rank)
		}
		oc := mustPoll(t, st, "s", cID, c.params(1))
		if oc.Rank != 1 {
			t.Fatalf("C rank = %d, want 1", oc.Rank)
		}
	})
}

func TestStoreAbandonedWaiterRemoved(t *testing.T) {
	eachStore(t, func(t *testing.T, st Store) {
		ctx := context.Background()
		c := newClock()
		mustEnter(t, st, "s", c.params(0))
		a, oa := mustEnter(t, st, "s", c.params(0))
		expectCode(t, oa, CodeWait, "A")
		c.add(2*time.Minute + time.Second)
		if err := st.Sweep(ctx, "s", c.params(0)); err != nil {
			t.Fatal(err)
		}
		expectCode(t, mustPoll(t, st, "s", a, c.params(0)), CodeExpired, "A after wait TTL")
		raw, _ := st.Stats(ctx, "s", c.now())
		if raw.Totals.Abandoned != 2 || raw.Live+raw.Stale != 0 {
			t.Fatalf("abandoned=%d waiting=%d", raw.Totals.Abandoned, raw.Live+raw.Stale)
		}
	})
}

func TestStoreMaxWaitingAndCancel(t *testing.T) {
	eachStore(t, func(t *testing.T, st Store) {
		ctx := context.Background()
		c := newClock()
		p := c.params(0)
		p.MaxWaiting = 2
		a, _ := mustEnter(t, st, "s", p)
		mustEnter(t, st, "s", p)
		_, o := mustEnter(t, st, "s", p)
		expectCode(t, o, CodeFull, "third")
		// 대기 취소 후에는 다시 자리가 난다
		if ok, err := st.Complete(ctx, "s", a, p); err != nil || !ok {
			t.Fatalf("cancel: ok=%v err=%v", ok, err)
		}
		_, o = mustEnter(t, st, "s", p)
		expectCode(t, o, CodeWait, "after cancel")
		raw, _ := st.Stats(ctx, "s", c.now())
		if raw.Totals.Rejected != 1 || raw.Totals.Cancelled != 1 || raw.Totals.Entered != 3 {
			t.Fatalf("totals = %+v", raw.Totals)
		}
		if ok, _ := st.Complete(ctx, "s", a, p); ok {
			t.Fatal("double complete should report false")
		}
	})
}

func TestStorePreOpenAndShuffle(t *testing.T) {
	eachStore(t, func(t *testing.T, st Store) {
		c := newClock()
		pre := c.params(1)
		pre.PreOpen = true
		pre.Shuffle = true

		ids := make([]string, 5)
		for i := range ids {
			pre.RandomScore = int64(100 - i*10) // 늦게 온 사람이 더 작은 점수 = 더 앞
			var o Outcome
			ids[i], o = mustEnter(t, st, "s", pre)
			expectCode(t, o, CodePreWait, "pre-open enter")
		}
		expectCode(t, mustPoll(t, st, "s", ids[0], pre), CodePreWait, "pre-open poll")

		// 오픈 후 도착한 사람은 오픈 전 도착자 전원보다 뒤 (live window 20초 이내로 시간 경과)
		c.add(10 * time.Second)
		open := c.params(1)
		late, ol := mustEnter(t, st, "s", open)
		expectCode(t, ol, CodeWait, "late")
		if ol.Rank != 5 {
			t.Fatalf("late rank = %d, want 5", ol.Rank)
		}
		// 섞인 순서: ids[4] 가 맨 앞
		expectCode(t, mustPoll(t, st, "s", ids[0], open), CodeWait, "ids[0]")
		expectCode(t, mustPoll(t, st, "s", ids[4], open), CodePass, "ids[4] first")
		_ = late
	})
}

func TestStorePreOpenWithoutShuffleKeepsArrivalOrder(t *testing.T) {
	eachStore(t, func(t *testing.T, st Store) {
		c := newClock()
		pre := c.params(1)
		pre.PreOpen = true
		a, _ := mustEnter(t, st, "s", pre)
		b, _ := mustEnter(t, st, "s", pre)
		c.add(10 * time.Second)
		expectCode(t, mustPoll(t, st, "s", b, c.params(1)), CodeWait, "b")
		expectCode(t, mustPoll(t, st, "s", a, c.params(1)), CodePass, "a")
	})
}

func TestStoreReset(t *testing.T) {
	eachStore(t, func(t *testing.T, st Store) {
		ctx := context.Background()
		c := newClock()
		a, _ := mustEnter(t, st, "s", c.params(1))
		b, _ := mustEnter(t, st, "s", c.params(1))
		if err := st.Reset(ctx, "s"); err != nil {
			t.Fatal(err)
		}
		expectCode(t, mustPoll(t, st, "s", a, c.params(1)), CodeExpired, "a after reset")
		expectCode(t, mustPoll(t, st, "s", b, c.params(1)), CodeExpired, "b after reset")
		raw, _ := st.Stats(ctx, "s", c.now())
		if raw.Live != 0 || raw.Active != 0 || raw.Totals.Entered != 2 {
			t.Fatalf("after reset: %+v", raw)
		}
		_, o := mustEnter(t, st, "s", c.params(1))
		expectCode(t, o, CodePass, "enter after reset")
	})
}

func TestStoreSegmentsCRUD(t *testing.T) {
	eachStore(t, func(t *testing.T, st Store) {
		ctx := context.Background()
		v0, _ := st.SegmentsVersion(ctx)
		s := Segment{ID: "event", Name: "이벤트", Mode: ModeQueue, MaxActive: 10, ActiveTTL: 30, PassTTL: 600, URLPatterns: []string{"/event/*"}}
		if err := st.SaveSegment(ctx, s); err != nil {
			t.Fatal(err)
		}
		v1, _ := st.SegmentsVersion(ctx)
		if v1 <= v0 {
			t.Fatalf("version did not increase: %d -> %d", v0, v1)
		}
		list, err := st.ListSegments(ctx)
		if err != nil || len(list) != 1 || list[0].Name != "이벤트" || list[0].URLPatterns[0] != "/event/*" {
			t.Fatalf("list = %+v err=%v", list, err)
		}
		mustEnter(t, st, "event", newClock().params(1))
		if err := st.DeleteSegment(ctx, "event"); err != nil {
			t.Fatal(err)
		}
		if err := st.DeleteSegment(ctx, "event"); err != ErrNotFound {
			t.Fatalf("second delete err = %v", err)
		}
		list, _ = st.ListSegments(ctx)
		if len(list) != 0 {
			t.Fatalf("list after delete = %+v", list)
		}
		raw, _ := st.Stats(ctx, "event", time.Now())
		if raw.Totals.Entered != 0 {
			t.Fatalf("state should be purged: %+v", raw.Totals)
		}
	})
}

// 동시 요청 속에서도 활성 사용자 수가 진입 허용 수를 넘지 않는지 확인한다.
func TestStoreConcurrentNeverExceedsMaxActive(t *testing.T) {
	eachStore(t, func(t *testing.T, st Store) {
		ctx := context.Background()
		const maxActive = 7
		var (
			mu      sync.Mutex
			now     = time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
			holding atomic.Int64
			peak    atomic.Int64
			passed  atomic.Int64
		)
		params := func() Params {
			mu.Lock()
			defer mu.Unlock()
			now = now.Add(time.Millisecond)
			return Params{Now: now, MaxActive: maxActive, ActiveTTL: time.Hour, LiveWindow: time.Hour, WaitTTL: time.Hour}
		}
		var wg sync.WaitGroup
		for w := 0; w < 40; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := 0; j < 5; j++ {
					id := NewTicketID()
					out, err := st.Enter(ctx, "c", id, params())
					if err != nil {
						t.Error(err)
						return
					}
					for out.Code == CodeWait {
						out, err = st.Poll(ctx, "c", id, params())
						if err != nil {
							t.Error(err)
							return
						}
					}
					if out.Code != CodePass {
						t.Errorf("unexpected code %d", out.Code)
						return
					}
					h := holding.Add(1)
					for {
						p := peak.Load()
						if h <= p || peak.CompareAndSwap(p, h) {
							break
						}
					}
					passed.Add(1)
					holding.Add(-1)
					if _, err := st.Complete(ctx, "c", id, params()); err != nil {
						t.Error(err)
						return
					}
				}
			}()
		}
		wg.Wait()
		if passed.Load() != 200 {
			t.Fatalf("passed = %d, want 200", passed.Load())
		}
		if peak.Load() > maxActive {
			t.Fatalf("peak concurrent holders = %d > %d", peak.Load(), maxActive)
		}
		raw, _ := st.Stats(ctx, "c", now)
		if raw.Active != 0 || raw.Totals.Admitted != 200 || raw.Totals.Completed != 200 {
			t.Fatalf("final stats %+v", raw)
		}
	})
}

func TestMemoryStorePersistence(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	st, err := NewMemoryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	seg := Segment{ID: "p", Name: "persist", Mode: ModeQueue, MaxActive: 1, ActiveTTL: 30, PassTTL: 600}
	if err := st.SaveSegment(ctx, seg); err != nil {
		t.Fatal(err)
	}
	c := newClock()
	c.t = time.Now()
	a, _ := mustEnter(t, st, "p", c.params(1))
	b, ob := mustEnter(t, st, "p", c.params(1))
	expectCode(t, ob, CodeWait, "b")
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	st2, err := NewMemoryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	list, _ := st2.ListSegments(ctx)
	if len(list) != 1 || list[0].Name != "persist" {
		t.Fatalf("segments not restored: %+v", list)
	}
	expectCode(t, mustPoll(t, st2, "p", a, c.params(1)), CodePass, "a restored active")
	ob = mustPoll(t, st2, "p", b, c.params(1))
	expectCode(t, ob, CodeWait, "b restored waiting")
	if ob.Rank != 0 {
		t.Fatalf("b rank = %d", ob.Rank)
	}
	if _, err := os.Stat(dir + "/" + stateFile); !os.IsNotExist(err) {
		t.Fatal("state snapshot should be removed after restore")
	}
}
