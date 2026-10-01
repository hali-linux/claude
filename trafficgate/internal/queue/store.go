package queue

import (
	"context"
	"errors"
	"time"
)

// Code 는 저장소 수준의 대기열 처리 결과이다.
type Code int

const (
	CodePass    Code = 1 // 입장 허용
	CodeWait    Code = 2 // 대기
	CodePreWait Code = 3 // 오픈 전 대기(사전 대기실)
	CodeExpired Code = 4 // 알 수 없거나 만료된 티켓
	CodeFull    Code = 5 // 대기열 가득 참
)

// scoreBase 는 일반 티켓의 대기열 점수 기준값이다.
// 오픈 전 무작위 섞기 티켓은 [0, scoreBase) 범위의 난수 점수를 받아 항상 일반 티켓보다 앞선다.
// 2^50 + seq 는 Redis ZSET 점수(double)로도 정확히 표현된다.
const scoreBase = int64(1) << 50

// ErrNotFound 는 세그먼트를 찾을 수 없음을 나타낸다.
var ErrNotFound = errors.New("segment not found")

// ErrDuplicateTicket 은 티켓 ID 충돌(사실상 발생하지 않음)을 나타낸다.
var ErrDuplicateTicket = errors.New("duplicate ticket id")

// Params 는 한 번의 대기열 연산에 필요한 세그먼트/전역 설정 값이다.
type Params struct {
	Now        time.Time
	MaxActive  int
	ActiveTTL  time.Duration
	LiveWindow time.Duration
	WaitTTL    time.Duration
	MaxWaiting int
	PreOpen    bool
	// Shuffle 이 true(오픈 전 + 무작위 섞기)이면 새 티켓은 순번 대신 RandomScore([0, 2^50)) 를 점수로 쓴다.
	Shuffle     bool
	RandomScore int64
}

// Outcome 은 저장소 연산 결과이다.
type Outcome struct {
	Code     Code
	Rank     int64 // live 대기자 중 0부터 시작하는 순위
	Live     int64 // 현재 live 대기자 수
	Active   int64 // 현재 활성(입장) 사용자 수
	WaitedMs int64 // 입장 시 대기한 시간
}

// Counters 는 누적 통계 카운터이다.
type Counters struct {
	Entered   int64 `json:"entered"`     // 발급된 티켓 수
	Admitted  int64 `json:"admitted"`    // 입장 허용 수
	Completed int64 `json:"completed"`   // 정상 완료(슬롯 반환) 수
	Expired   int64 `json:"expired"`     // 활성 슬롯 시간 초과 수
	Abandoned int64 `json:"abandoned"`   // 대기 중 이탈(폴링 중단) 수
	Cancelled int64 `json:"cancelled"`   // 대기 취소 수
	Rejected  int64 `json:"rejected"`    // 대기열 가득 참으로 거절된 수
	WaitMsSum int64 `json:"wait_ms_sum"` // 입장자 대기 시간 합(ms)
}

// Add 는 두 카운터를 더한다.
func (c *Counters) Add(o Counters) {
	c.Entered += o.Entered
	c.Admitted += o.Admitted
	c.Completed += o.Completed
	c.Expired += o.Expired
	c.Abandoned += o.Abandoned
	c.Cancelled += o.Cancelled
	c.Rejected += o.Rejected
	c.WaitMsSum += o.WaitMsSum
}

// Bucket 은 1초 단위 통계이다.
type Bucket struct {
	Unix int64 `json:"t"`
	Counters
}

// RawStats 는 저장소가 보고하는 세그먼트 상태이다.
type RawStats struct {
	Live   int64
	Stale  int64
	Active int64
	Totals Counters
	// Series 는 최근 StatsWindow 초의 초당 통계(오래된 것부터)이다.
	Series []Bucket
}

// StatsWindow 는 저장소가 보관하는 초당 통계의 길이(초)이다.
const StatsWindow = 60

// Store 는 대기열 상태 저장소이다. 모든 대기열 연산은 원자적이어야 한다.
type Store interface {
	ListSegments(ctx context.Context) ([]Segment, error)
	SaveSegment(ctx context.Context, s Segment) error
	DeleteSegment(ctx context.Context, id string) error
	// SegmentsVersion 은 세그먼트 설정이 바뀔 때마다 증가하는 값이다(클러스터 동기화용).
	SegmentsVersion(ctx context.Context) (int64, error)

	Enter(ctx context.Context, segID, ticketID string, p Params) (Outcome, error)
	Poll(ctx context.Context, segID, ticketID string, p Params) (Outcome, error)
	Alive(ctx context.Context, segID, ticketID string, p Params) (bool, error)
	Complete(ctx context.Context, segID, ticketID string, p Params) (bool, error)
	Sweep(ctx context.Context, segID string, p Params) error
	Reset(ctx context.Context, segID string) error
	Stats(ctx context.Context, segID string, now time.Time) (RawStats, error)

	Ping(ctx context.Context) error
	Close() error
}
