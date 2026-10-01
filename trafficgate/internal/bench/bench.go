// Package bench 는 가상 사용자로 TrafficGate 에 부하를 주는 도구이다.
// 실제 브라우저 에이전트와 같은 흐름(진입 → 권장 간격 폴링 → 입장 → 체류 → 완료)을 따른다.
package bench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Options 는 부하 테스트 설정이다.
type Options struct {
	URL         string
	Segment     string
	Users       int
	ArrivalRate float64
	Hold        time.Duration
	PollScale   float64
	Timeout     time.Duration
	Concurrency int
}

// Result 는 부하 테스트 결과이다.
type Result struct {
	Arrived      int64
	Passed       int64
	Completed    int64
	Rejected     int64 // BLOCKED/CLOSED
	Errors       int64
	Requests     int64
	PeakHolding  int64
	Duration     time.Duration
	LatencyP50   time.Duration
	LatencyP99   time.Duration
	WaitP50      time.Duration
	WaitP99      time.Duration
	WaitMax      time.Duration
	FirstErrText string
}

type response struct {
	Status     string `json:"status"`
	Ticket     string `json:"ticket"`
	Position   int64  `json:"position"`
	NextPollMs int64  `json:"next_poll_ms"`
	Bypass     bool   `json:"bypass"`
	Error      string `json:"error"`
}

type runner struct {
	o       Options
	client  *http.Client
	base    string
	arrived atomic.Int64
	passed  atomic.Int64
	done    atomic.Int64
	reject  atomic.Int64
	errs    atomic.Int64
	reqs    atomic.Int64
	holding atomic.Int64
	waiting atomic.Int64
	peak    atomic.Int64
	lastPos atomic.Int64

	mu       sync.Mutex
	lats     []time.Duration
	waits    []time.Duration
	firstErr string
}

// Run 은 부하 테스트를 실행하고 1초마다 진행 상황을 out 에 출력한다.
func Run(ctx context.Context, o Options, out io.Writer) (Result, error) {
	if o.Users <= 0 || o.ArrivalRate <= 0 {
		return Result{}, errors.New("users 와 rate 는 0 보다 커야 합니다")
	}
	if o.PollScale <= 0 {
		o.PollScale = 1
	}
	if o.Concurrency <= 0 {
		o.Concurrency = 512
	}
	if _, err := url.Parse(o.URL); err != nil {
		return Result{}, err
	}
	if o.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, o.Timeout)
		defer cancel()
	}
	tr := &http.Transport{
		MaxConnsPerHost:     o.Concurrency,
		MaxIdleConnsPerHost: o.Concurrency,
		IdleConnTimeout:     30 * time.Second,
	}
	r := &runner{
		o:      o,
		client: &http.Client{Transport: tr, Timeout: 15 * time.Second},
		base:   strings.TrimRight(o.URL, "/") + "/api/v1/segments/" + url.PathEscape(o.Segment),
	}
	start := time.Now()
	fmt.Fprintf(out, "부하 테스트: %s 세그먼트=%s 사용자=%d 도착률=%.0f/s 체류=%s\n", o.URL, o.Segment, o.Users, o.ArrivalRate, o.Hold)
	fmt.Fprintf(out, "%6s %8s %8s %8s %8s %8s %8s %7s\n", "초", "도착", "대기", "입장중", "통과", "완료", "오류", "순번")

	var wg sync.WaitGroup
	stopReport := make(chan struct{})
	reportDone := make(chan struct{})
	go func() {
		defer close(reportDone)
		tk := time.NewTicker(time.Second)
		defer tk.Stop()
		for {
			select {
			case <-stopReport:
				return
			case <-tk.C:
				fmt.Fprintf(out, "%6.0f %8d %8d %8d %8d %8d %8d %7d\n", time.Since(start).Seconds(),
					r.arrived.Load(), r.waiting.Load(), r.holding.Load(), r.passed.Load(), r.done.Load(), r.errs.Load(), r.lastPos.Load())
			}
		}
	}()

	interval := time.Duration(float64(time.Second) / o.ArrivalRate)
	next := time.Now()
spawn:
	for i := 0; i < o.Users; i++ {
		if d := time.Until(next); d > 0 {
			select {
			case <-ctx.Done():
				break spawn
			case <-time.After(d):
			}
		}
		next = next.Add(interval)
		wg.Add(1)
		r.arrived.Add(1)
		go func() {
			defer wg.Done()
			r.user(ctx)
		}()
	}
	wg.Wait()
	close(stopReport)
	<-reportDone

	res := Result{
		Arrived: r.arrived.Load(), Passed: r.passed.Load(), Completed: r.done.Load(), Rejected: r.reject.Load(),
		Errors: r.errs.Load(), Requests: r.reqs.Load(), PeakHolding: r.peak.Load(), Duration: time.Since(start),
		FirstErrText: r.firstErr,
	}
	res.LatencyP50, res.LatencyP99, _ = percentiles(r.lats)
	res.WaitP50, res.WaitP99, res.WaitMax = percentiles(r.waits)
	fmt.Fprintf(out, "\n결과: %s 동안 요청 %d건 (%.0f req/s)\n", res.Duration.Round(time.Millisecond), res.Requests,
		float64(res.Requests)/res.Duration.Seconds())
	fmt.Fprintf(out, "  사용자 %d명 → 통과 %d, 완료 %d, 차단/종료 %d, 오류 %d\n", res.Arrived, res.Passed, res.Completed, res.Rejected, res.Errors)
	fmt.Fprintf(out, "  동시 입장 최대 %d명 (클라이언트 관측)\n", res.PeakHolding)
	fmt.Fprintf(out, "  응답 지연 p50 %s, p99 %s\n", res.LatencyP50, res.LatencyP99)
	fmt.Fprintf(out, "  대기 시간 p50 %s, p99 %s, 최대 %s\n", res.WaitP50.Round(time.Millisecond), res.WaitP99.Round(time.Millisecond), res.WaitMax.Round(time.Millisecond))
	if res.FirstErrText != "" {
		fmt.Fprintf(out, "  첫 오류: %s\n", res.FirstErrText)
	}
	if ctx.Err() != nil && res.Completed+res.Rejected < res.Arrived {
		return res, fmt.Errorf("시간 초과 또는 중단됨: %w", ctx.Err())
	}
	return res, nil
}

func percentiles(d []time.Duration) (p50, p99, maxV time.Duration) {
	if len(d) == 0 {
		return 0, 0, 0
	}
	s := append([]time.Duration(nil), d...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[len(s)*50/100], s[min(len(s)*99/100, len(s)-1)], s[len(s)-1]
}

func (r *runner) fail(err error) {
	r.errs.Add(1)
	r.mu.Lock()
	if r.firstErr == "" {
		r.firstErr = err.Error()
	}
	r.mu.Unlock()
}

func (r *runner) call(ctx context.Context, path string) (response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.base+path, nil)
	if err != nil {
		return response{}, err
	}
	t0 := time.Now()
	resp, err := r.client.Do(req)
	r.reqs.Add(1)
	if err != nil {
		return response{}, err
	}
	defer resp.Body.Close()
	var out response
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return response{}, fmt.Errorf("HTTP %d: %w", resp.StatusCode, err)
	}
	lat := time.Since(t0)
	r.mu.Lock()
	r.lats = append(r.lats, lat)
	r.mu.Unlock()
	if resp.StatusCode >= 400 && resp.StatusCode != http.StatusTooManyRequests {
		return out, fmt.Errorf("HTTP %d %s", resp.StatusCode, out.Error)
	}
	return out, nil
}

func (r *runner) sleep(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

func (r *runner) user(ctx context.Context) {
	start := time.Now()
	errorsInRow := 0
	inQueue := false
	setQueued := func(v bool) {
		if v != inQueue {
			inQueue = v
			if v {
				r.waiting.Add(1)
			} else {
				r.waiting.Add(-1)
			}
		}
	}
	defer setQueued(false)

	ticket := ""
	next := func() (response, error) {
		if ticket != "" {
			return r.call(ctx, "/tickets/"+ticket+"/poll")
		}
		return r.call(ctx, "/enter")
	}
	resp, err := next()
	for ctx.Err() == nil {
		if err != nil {
			r.fail(err)
			errorsInRow++
			if errorsInRow >= 5 || !r.sleep(ctx, time.Second) {
				return
			}
			resp, err = next()
			continue
		}
		errorsInRow = 0
		if resp.Ticket != "" {
			ticket = resp.Ticket
		}
		switch resp.Status {
		case "PASS":
			setQueued(false)
			r.passed.Add(1)
			r.mu.Lock()
			r.waits = append(r.waits, time.Since(start))
			r.mu.Unlock()
			h := r.holding.Add(1)
			for {
				p := r.peak.Load()
				if h <= p || r.peak.CompareAndSwap(p, h) {
					break
				}
			}
			r.sleep(ctx, r.o.Hold)
			r.holding.Add(-1)
			if ticket != "" && !resp.Bypass {
				if _, err := r.call(context.Background(), "/tickets/"+ticket+"/complete"); err != nil {
					r.fail(err)
				}
			}
			r.done.Add(1)
			return
		case "WAIT", "PRE_WAIT":
			setQueued(true)
			r.lastPos.Store(resp.Position)
			d := time.Duration(float64(resp.NextPollMs)*r.o.PollScale) * time.Millisecond
			if !r.sleep(ctx, max(d, 50*time.Millisecond)) {
				return
			}
		case "RATE_LIMITED", "FULL":
			if !r.sleep(ctx, time.Duration(max(resp.NextPollMs, 1000))*time.Millisecond) {
				return
			}
		case "EXPIRED":
			ticket = ""
		case "BLOCKED", "CLOSED":
			r.reject.Add(1)
			return
		default:
			r.fail(fmt.Errorf("알 수 없는 상태 %q", resp.Status))
			return
		}
		resp, err = next()
	}
}
