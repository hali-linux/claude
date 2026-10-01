package queue

// window 는 최근 windowSize 초의 초당 카운터를 보관하는 링 버퍼이다.
type window struct {
	buckets [windowSize]Bucket
}

const windowSize = StatsWindow * 2

func (w *window) at(sec int64) *Counters {
	b := &w.buckets[uint64(sec)%windowSize]
	if b.Unix != sec {
		*b = Bucket{Unix: sec}
	}
	return &b.Counters
}

// series 는 nowSec 를 포함한 최근 n 초의 버킷을 오래된 것부터 돌려준다.
func (w *window) series(nowSec int64, n int) []Bucket {
	out := make([]Bucket, n)
	for i := 0; i < n; i++ {
		sec := nowSec - int64(n-1-i)
		b := w.buckets[uint64(sec)%windowSize]
		if b.Unix == sec {
			out[i] = b
		} else {
			out[i] = Bucket{Unix: sec}
		}
	}
	return out
}
