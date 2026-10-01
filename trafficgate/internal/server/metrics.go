package server

import (
	"fmt"
	"net/http"
	"runtime"
	"sort"
	"strconv"
	"strings"

	"github.com/hali-linux/claude/trafficgate/internal/queue"
	"github.com/hali-linux/claude/trafficgate/internal/version"
)

// handleMetrics 는 Prometheus 텍스트 형식으로 메트릭을 내보낸다.
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.Admin.MetricsPublic {
		if _, _, ok := s.authenticate(r); !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized", "")
			return
		}
	}
	var b strings.Builder
	stats := s.engine.Stats(false)

	gauge := func(name, help string, val func(queue.SegmentStats) float64) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s gauge\n", name, help, name)
		for _, st := range stats {
			fmt.Fprintf(&b, "%s{segment=%q} %s\n", name, st.Segment.ID, fmtFloat(val(st)))
		}
	}
	counter := func(name, help string, val func(queue.SegmentStats) int64) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s counter\n", name, help, name)
		for _, st := range stats {
			fmt.Fprintf(&b, "%s{segment=%q} %d\n", name, st.Segment.ID, val(st))
		}
	}

	fmt.Fprintf(&b, "# HELP trafficgate_build_info 빌드 정보\n# TYPE trafficgate_build_info gauge\n")
	fmt.Fprintf(&b, "trafficgate_build_info{version=%q,store=%q} 1\n", version.Version, s.cfg.Store.Type)

	gauge("trafficgate_waiting", "대기 중인 사용자 수(live+stale)", func(st queue.SegmentStats) float64 { return float64(st.Waiting) })
	gauge("trafficgate_waiting_live", "최근 폴링한 대기자 수", func(st queue.SegmentStats) float64 { return float64(st.Live) })
	gauge("trafficgate_active", "입장해 있는 사용자 수", func(st queue.SegmentStats) float64 { return float64(st.Active) })
	gauge("trafficgate_max_active", "진입 허용 수", func(st queue.SegmentStats) float64 { return float64(st.Segment.MaxActive) })
	gauge("trafficgate_admit_rate", "초당 입장 수(최근 평균)", func(st queue.SegmentStats) float64 { return st.AdmitRate })
	gauge("trafficgate_enter_rate", "초당 신규 진입 수(최근 평균)", func(st queue.SegmentStats) float64 { return st.EnterRate })
	gauge("trafficgate_avg_wait_seconds", "최근 입장자의 평균 대기 시간", func(st queue.SegmentStats) float64 { return st.AvgWaitSec })
	gauge("trafficgate_eta_seconds", "지금 진입하는 사용자의 예상 대기 시간(-1 계산 불가)", func(st queue.SegmentStats) float64 { return float64(st.ETASec) })
	gauge("trafficgate_segment_mode", "세그먼트 모드(0 queue, 1 bypass, 2 block)", func(st queue.SegmentStats) float64 {
		switch st.Segment.Mode {
		case queue.ModeBypass:
			return 1
		case queue.ModeBlock:
			return 2
		}
		return 0
	})

	counter("trafficgate_entered_total", "발급된 티켓 수", func(st queue.SegmentStats) int64 { return st.Totals.Entered })
	counter("trafficgate_admitted_total", "입장 허용 수", func(st queue.SegmentStats) int64 { return st.Totals.Admitted })
	counter("trafficgate_completed_total", "정상 완료(슬롯 반환) 수", func(st queue.SegmentStats) int64 { return st.Totals.Completed })
	counter("trafficgate_expired_total", "활성 슬롯 시간 초과 수", func(st queue.SegmentStats) int64 { return st.Totals.Expired })
	counter("trafficgate_abandoned_total", "대기 중 이탈 수", func(st queue.SegmentStats) int64 { return st.Totals.Abandoned })
	counter("trafficgate_cancelled_total", "대기 취소 수", func(st queue.SegmentStats) int64 { return st.Totals.Cancelled })
	counter("trafficgate_rejected_total", "대기열 가득 참으로 거절된 수", func(st queue.SegmentStats) int64 { return st.Totals.Rejected })
	counter("trafficgate_wait_ms_total", "입장자 대기 시간 합(ms)", func(st queue.SegmentStats) int64 { return st.Totals.WaitMsSum })
	counter("trafficgate_blocked_responses_total", "(이 노드) 차단 응답 수", func(st queue.SegmentStats) int64 { return st.Blocked })
	counter("trafficgate_closed_responses_total", "(이 노드) 종료 응답 수", func(st queue.SegmentStats) int64 { return st.ClosedHits })

	fmt.Fprintf(&b, "# HELP trafficgate_rate_limited_total (이 노드) IP 요청 제한으로 거절된 수\n# TYPE trafficgate_rate_limited_total counter\n")
	fmt.Fprintf(&b, "trafficgate_rate_limited_total %d\n", s.limited.Load())

	fmt.Fprintf(&b, "# HELP trafficgate_http_requests_total (이 노드) HTTP 요청 수\n# TYPE trafficgate_http_requests_total counter\n")
	s.reqMu.Lock()
	keys := make([]reqKey, 0, len(s.requests))
	for k := range s.requests {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].route != keys[j].route {
			return keys[i].route < keys[j].route
		}
		return keys[i].code < keys[j].code
	})
	for _, k := range keys {
		fmt.Fprintf(&b, "trafficgate_http_requests_total{route=%q,code=\"%d\"} %d\n", k.route, k.code, s.requests[k].Load())
	}
	s.reqMu.Unlock()

	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	fmt.Fprintf(&b, "# HELP go_goroutines 고루틴 수\n# TYPE go_goroutines gauge\ngo_goroutines %d\n", runtime.NumGoroutine())
	fmt.Fprintf(&b, "# HELP go_memstats_heap_alloc_bytes 힙 사용량\n# TYPE go_memstats_heap_alloc_bytes gauge\ngo_memstats_heap_alloc_bytes %d\n", ms.HeapAlloc)
	fmt.Fprintf(&b, "# HELP process_uptime_seconds 가동 시간\n# TYPE process_uptime_seconds gauge\nprocess_uptime_seconds %s\n",
		fmtFloat(s.now().Sub(s.started).Seconds()))

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(b.String()))
}

func fmtFloat(f float64) string {
	return strconv.FormatFloat(f, 'g', -1, 64)
}
