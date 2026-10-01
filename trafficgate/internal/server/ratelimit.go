package server

import (
	"hash/maphash"
	"net/netip"
	"sync"
	"time"
)

// rateLimiter 는 키(IP)별 토큰 버킷 요청 제한기이다. 경합을 줄이기 위해 샤드로 나눈다.
type rateLimiter struct {
	rate   float64 // 초당 토큰
	burst  float64
	shards [32]rlShard
	seed   maphash.Seed
}

type rlShard struct {
	mu      sync.Mutex
	buckets map[netip.Addr]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newRateLimiter(perMinute, burst int) *rateLimiter {
	rl := &rateLimiter{rate: float64(perMinute) / 60, burst: float64(burst), seed: maphash.MakeSeed()}
	for i := range rl.shards {
		rl.shards[i].buckets = make(map[netip.Addr]*bucket)
	}
	return rl
}

func (rl *rateLimiter) shard(a netip.Addr) *rlShard {
	b := a.As16()
	return &rl.shards[maphash.Bytes(rl.seed, b[:])%uint64(len(rl.shards))]
}

// Allow 는 요청을 허용할지 판단한다.
func (rl *rateLimiter) Allow(a netip.Addr, now time.Time) bool {
	if rl == nil || !a.IsValid() {
		return true
	}
	s := rl.shard(a)
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.buckets[a]
	if b == nil {
		b = &bucket{tokens: rl.burst, last: now}
		s.buckets[a] = b
	}
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = min(rl.burst, b.tokens+elapsed*rl.rate)
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// Cleanup 은 가득 찬(오래 쓰이지 않은) 버킷을 지워 메모리를 회수한다.
func (rl *rateLimiter) Cleanup(now time.Time) {
	if rl == nil {
		return
	}
	full := time.Duration(rl.burst/rl.rate*float64(time.Second)) + time.Minute
	for i := range rl.shards {
		s := &rl.shards[i]
		s.mu.Lock()
		for k, b := range s.buckets {
			if now.Sub(b.last) > full {
				delete(s.buckets, k)
			}
		}
		s.mu.Unlock()
	}
}
