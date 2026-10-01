package queue

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisOptions 는 Redis 연결 설정이다.
//   - Addrs 1개: 단일 Redis
//   - MasterName 지정: Redis Sentinel (Addrs 는 Sentinel 주소 목록)
//   - Addrs 여러 개 + MasterName 없음: Redis Cluster
type RedisOptions struct {
	Addrs      []string
	MasterName string
	Username   string
	Password   string
	DB         int
	TLS        bool
	KeyPrefix  string
	PoolSize   int
}

// RedisStore 는 여러 TrafficGate 서버가 대기열을 공유하는 클러스터용 저장소이다.
// 모든 대기열 연산은 Lua 스크립트로 원자적으로 처리된다.
// 한 세그먼트의 키는 모두 같은 해시 태그 {세그먼트ID} 를 가지므로 Redis Cluster 에서도 동작한다.
type RedisStore struct {
	c      redis.UniversalClient
	prefix string
}

// 스크립트에서 한 번에 정리하는 최대 원소 수.
const (
	pollSweepLimit = 200
	bgSweepLimit   = 2000
	statsTTLSec    = StatsWindow * 3
)

// NewRedisStore 는 Redis 저장소를 만든다.
func NewRedisStore(o RedisOptions) (*RedisStore, error) {
	if len(o.Addrs) == 0 {
		return nil, errors.New("redis addrs 가 비어 있습니다")
	}
	uo := &redis.UniversalOptions{
		Addrs:        o.Addrs,
		MasterName:   o.MasterName,
		Username:     o.Username,
		Password:     o.Password,
		DB:           o.DB,
		PoolSize:     o.PoolSize,
		DialTimeout:  3 * time.Second,
		ReadTimeout:  2 * time.Second,
		WriteTimeout: 2 * time.Second,
	}
	if o.TLS {
		uo.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	prefix := o.KeyPrefix
	if prefix == "" {
		prefix = "tg:"
	}
	return &RedisStore{c: redis.NewUniversalClient(uo), prefix: prefix}, nil
}

func (r *RedisStore) segKey(seg, name string) string {
	return r.prefix + "{" + seg + "}:" + name
}

func (r *RedisStore) keys(seg string, now time.Time) []string {
	return []string{
		r.segKey(seg, "seq"),
		r.segKey(seg, "live"),
		r.segKey(seg, "lseen"),
		r.segKey(seg, "sseen"),
		r.segKey(seg, "active"),
		r.segKey(seg, "tk"),
		r.segKey(seg, "tot"),
		r.segKey(seg, "st:"+strconv.FormatInt(now.Unix(), 10)),
	}
}

func (r *RedisStore) segmentsKey() string    { return r.prefix + "segments" }
func (r *RedisStore) segmentsVerKey() string { return r.prefix + "segments:ver" }

func commonArgs(p Params, limit int) []any {
	pre := 0
	if p.PreOpen {
		pre = 1
	}
	return []any{
		p.Now.UnixMilli(),
		p.MaxActive,
		p.ActiveTTL.Milliseconds(),
		p.LiveWindow.Milliseconds(),
		p.WaitTTL.Milliseconds(),
		limit,
		statsTTLSec,
		pre,
	}
}

// luaPrelude 는 모든 스크립트가 공유하는 키/인자 정의와 공통 함수이다.
//
// KEYS: 1 seq, 2 live(ZSET 점수=대기순번), 3 lseen(ZSET live 대기자의 마지막 폴링 시각),
//
//	4 sseen(ZSET stale 대기자의 마지막 폴링 시각), 5 active(ZSET 만료 시각),
//	6 tk(HASH 티켓ID -> "점수|발급시각|상태"), 7 tot(HASH 누적 통계), 8 st:<초>(HASH 초당 통계)
//
// ARGV: 1 now(ms), 2 maxActive, 3 activeTTL(ms), 4 liveWindow(ms), 5 waitTTL(ms),
//
//	6 sweep limit, 7 stats TTL(s), 8 preOpen(0/1), 9~ 스크립트별 인자
const luaPrelude = `
local K_SEQ, K_LIVE, K_LSEEN, K_SSEEN, K_ACTIVE, K_TK, K_TOT, K_SEC =
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7], KEYS[8]
local now = tonumber(ARGV[1])
local maxActive = tonumber(ARGV[2])
local activeTTL = tonumber(ARGV[3])
local liveWin = tonumber(ARGV[4])
local waitTTL = tonumber(ARGV[5])
local limit = tonumber(ARGV[6])
local statsTTL = tonumber(ARGV[7])
local preOpen = tonumber(ARGV[8])

local function fmt(n) return string.format('%d', n) end

local function stat(field, n)
  if n == 0 then return end
  redis.call('HINCRBY', K_TOT, field, n)
  redis.call('HINCRBY', K_SEC, field, n)
  redis.call('EXPIRE', K_SEC, statsTTL)
end

local function counts()
  return redis.call('ZCARD', K_LIVE), redis.call('ZCARD', K_ACTIVE)
end

local function sweep()
  local done = 0
  local ids = redis.call('ZRANGEBYSCORE', K_ACTIVE, '-inf', fmt(now), 'LIMIT', 0, limit)
  for i = 1, #ids do
    redis.call('ZREM', K_ACTIVE, ids[i])
    redis.call('HDEL', K_TK, ids[i])
  end
  stat('x', #ids)
  done = done + #ids
  local res = redis.call('ZRANGEBYSCORE', K_LSEEN, '-inf', '(' .. fmt(now - liveWin), 'WITHSCORES', 'LIMIT', 0, limit)
  for i = 1, #res, 2 do
    redis.call('ZREM', K_LSEEN, res[i])
    redis.call('ZREM', K_LIVE, res[i])
    redis.call('ZADD', K_SSEEN, res[i + 1], res[i])
  end
  done = done + #res / 2
  ids = redis.call('ZRANGEBYSCORE', K_SSEEN, '-inf', '(' .. fmt(now - waitTTL), 'LIMIT', 0, limit)
  for i = 1, #ids do
    redis.call('ZREM', K_SSEEN, ids[i])
    redis.call('HDEL', K_TK, ids[i])
  end
  stat('b', #ids)
  done = done + #ids
  return done
end

local function parse(v)
  local a = string.find(v, '|', 1, true)
  local b = string.find(v, '|', a + 1, true)
  return string.sub(v, 1, a - 1), tonumber(string.sub(v, a + 1, b - 1)), string.sub(v, b + 1)
end

local function check(id, score, created)
  local live, active = counts()
  local rank = redis.call('ZRANK', K_LIVE, id)
  if preOpen == 1 then return {3, rank, live, active, 0} end
  if rank < maxActive - active then
    redis.call('ZREM', K_LIVE, id)
    redis.call('ZREM', K_LSEEN, id)
    redis.call('ZADD', K_ACTIVE, fmt(now + activeTTL), id)
    redis.call('HSET', K_TK, id, score .. '|' .. fmt(created) .. '|a')
    local waited = now - created
    stat('a', 1)
    stat('w', waited)
    return {1, rank, live - 1, active + 1, waited}
  end
  return {2, rank, live, active, 0}
end
`

var (
	// ARGV 9: ticketID, 10: maxWaiting, 11: randomScore('' 이면 순번 사용)
	scriptEnter = redis.NewScript(luaPrelude + `
sweep()
local id = ARGV[9]
local maxWaiting = tonumber(ARGV[10])
if maxWaiting > 0 then
  local w = redis.call('ZCARD', K_LSEEN) + redis.call('ZCARD', K_SSEEN)
  if w >= maxWaiting then
    stat('r', 1)
    local live, active = counts()
    return {5, 0, live, active, 0}
  end
end
if redis.call('HEXISTS', K_TK, id) == 1 then return redis.error_reply('DUPLICATE_TICKET') end
local seq = redis.call('INCR', K_SEQ)
local score
if ARGV[11] ~= '' then score = ARGV[11] else score = fmt(1125899906842624 + seq) end
redis.call('HSET', K_TK, id, score .. '|' .. fmt(now) .. '|w')
redis.call('ZADD', K_LIVE, score, id)
redis.call('ZADD', K_LSEEN, fmt(now), id)
stat('e', 1)
return check(id, score, now)
`)

	// ARGV 9: ticketID
	scriptPoll = redis.NewScript(luaPrelude + `
sweep()
local id = ARGV[9]
local v = redis.call('HGET', K_TK, id)
if not v then
  local live, active = counts()
  return {4, 0, live, active, 0}
end
local score, created, st = parse(v)
if st == 'a' then
  local exp = redis.call('ZSCORE', K_ACTIVE, id)
  local live, active = counts()
  if exp and tonumber(exp) > now then return {1, 0, live, active, 0} end
  if redis.call('ZREM', K_ACTIVE, id) == 1 then stat('x', 1) end
  redis.call('HDEL', K_TK, id)
  live, active = counts()
  return {4, 0, live, active, 0}
end
if not redis.call('ZSCORE', K_LSEEN, id) then
  if redis.call('ZREM', K_SSEEN, id) == 0 then
    redis.call('HDEL', K_TK, id)
    local live, active = counts()
    return {4, 0, live, active, 0}
  end
  redis.call('ZADD', K_LIVE, score, id)
end
redis.call('ZADD', K_LSEEN, fmt(now), id)
return check(id, score, created)
`)

	// ARGV 9: ticketID
	scriptAlive = redis.NewScript(luaPrelude + `
local id = ARGV[9]
local v = redis.call('HGET', K_TK, id)
if not v then return 0 end
local score, created, st = parse(v)
if st ~= 'a' then return 0 end
local exp = redis.call('ZSCORE', K_ACTIVE, id)
if not exp or tonumber(exp) <= now then return 0 end
redis.call('ZADD', K_ACTIVE, fmt(now + activeTTL), id)
return 1
`)

	// ARGV 9: ticketID
	scriptComplete = redis.NewScript(luaPrelude + `
local id = ARGV[9]
local v = redis.call('HGET', K_TK, id)
if not v then return 0 end
local score, created, st = parse(v)
redis.call('HDEL', K_TK, id)
if st == 'a' then
  if redis.call('ZREM', K_ACTIVE, id) == 1 then
    stat('c', 1)
    return 1
  end
  return 0
end
redis.call('ZREM', K_LIVE, id)
redis.call('ZREM', K_LSEEN, id)
redis.call('ZREM', K_SSEEN, id)
stat('q', 1)
return 1
`)

	scriptSweep = redis.NewScript(luaPrelude + `
return sweep()
`)
)

func toOutcome(v any) (Outcome, error) {
	arr, ok := v.([]any)
	if !ok || len(arr) != 5 {
		return Outcome{}, fmt.Errorf("unexpected script result: %v", v)
	}
	n := make([]int64, 5)
	for i, x := range arr {
		iv, ok := x.(int64)
		if !ok {
			return Outcome{}, fmt.Errorf("unexpected script result element: %v", x)
		}
		n[i] = iv
	}
	return Outcome{Code: Code(n[0]), Rank: n[1], Live: n[2], Active: n[3], WaitedMs: n[4]}, nil
}

func (r *RedisStore) Enter(ctx context.Context, segID, ticketID string, p Params) (Outcome, error) {
	rnd := ""
	if p.PreOpen && p.Shuffle {
		rnd = strconv.FormatInt(p.RandomScore, 10)
	}
	args := append(commonArgs(p, pollSweepLimit), ticketID, p.MaxWaiting, rnd)
	v, err := scriptEnter.Run(ctx, r.c, r.keys(segID, p.Now), args...).Result()
	if err != nil {
		if strings.Contains(err.Error(), "DUPLICATE_TICKET") {
			return Outcome{}, ErrDuplicateTicket
		}
		return Outcome{}, err
	}
	return toOutcome(v)
}

func (r *RedisStore) Poll(ctx context.Context, segID, ticketID string, p Params) (Outcome, error) {
	args := append(commonArgs(p, pollSweepLimit), ticketID)
	v, err := scriptPoll.Run(ctx, r.c, r.keys(segID, p.Now), args...).Result()
	if err != nil {
		return Outcome{}, err
	}
	return toOutcome(v)
}

func (r *RedisStore) Alive(ctx context.Context, segID, ticketID string, p Params) (bool, error) {
	args := append(commonArgs(p, 0), ticketID)
	n, err := scriptAlive.Run(ctx, r.c, r.keys(segID, p.Now), args...).Int64()
	return n == 1, err
}

func (r *RedisStore) Complete(ctx context.Context, segID, ticketID string, p Params) (bool, error) {
	args := append(commonArgs(p, 0), ticketID)
	n, err := scriptComplete.Run(ctx, r.c, r.keys(segID, p.Now), args...).Int64()
	return n == 1, err
}

func (r *RedisStore) Sweep(ctx context.Context, segID string, p Params) error {
	for i := 0; i < 20; i++ {
		n, err := scriptSweep.Run(ctx, r.c, r.keys(segID, p.Now), commonArgs(p, bgSweepLimit)...).Int64()
		if err != nil {
			return err
		}
		if n < bgSweepLimit {
			return nil
		}
	}
	return nil
}

func (r *RedisStore) Reset(ctx context.Context, segID string) error {
	return r.c.Del(ctx,
		r.segKey(segID, "live"), r.segKey(segID, "lseen"), r.segKey(segID, "sseen"),
		r.segKey(segID, "active"), r.segKey(segID, "tk"),
	).Err()
}

var statFields = map[string]func(*Counters) *int64{
	"e": func(c *Counters) *int64 { return &c.Entered },
	"a": func(c *Counters) *int64 { return &c.Admitted },
	"c": func(c *Counters) *int64 { return &c.Completed },
	"x": func(c *Counters) *int64 { return &c.Expired },
	"b": func(c *Counters) *int64 { return &c.Abandoned },
	"q": func(c *Counters) *int64 { return &c.Cancelled },
	"r": func(c *Counters) *int64 { return &c.Rejected },
	"w": func(c *Counters) *int64 { return &c.WaitMsSum },
}

func parseCounters(m map[string]string) Counters {
	var c Counters
	for k, v := range m {
		if f, ok := statFields[k]; ok {
			n, _ := strconv.ParseInt(v, 10, 64)
			*f(&c) = n
		}
	}
	return c
}

func (r *RedisStore) Stats(ctx context.Context, segID string, now time.Time) (RawStats, error) {
	pipe := r.c.Pipeline()
	live := pipe.ZCard(ctx, r.segKey(segID, "lseen"))
	stale := pipe.ZCard(ctx, r.segKey(segID, "sseen"))
	active := pipe.ZCount(ctx, r.segKey(segID, "active"), "("+strconv.FormatInt(now.UnixMilli(), 10), "+inf")
	tot := pipe.HGetAll(ctx, r.segKey(segID, "tot"))
	nowSec := now.Unix()
	secs := make([]*redis.MapStringStringCmd, StatsWindow)
	for i := 0; i < StatsWindow; i++ {
		sec := nowSec - int64(StatsWindow-1-i)
		secs[i] = pipe.HGetAll(ctx, r.segKey(segID, "st:"+strconv.FormatInt(sec, 10)))
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return RawStats{}, err
	}
	rs := RawStats{
		Live:   live.Val(),
		Stale:  stale.Val(),
		Active: active.Val(),
		Totals: parseCounters(tot.Val()),
		Series: make([]Bucket, StatsWindow),
	}
	for i, cmd := range secs {
		rs.Series[i] = Bucket{Unix: nowSec - int64(StatsWindow-1-i), Counters: parseCounters(cmd.Val())}
	}
	return rs, nil
}

// ---- 세그먼트 설정 ----

func (r *RedisStore) ListSegments(ctx context.Context) ([]Segment, error) {
	m, err := r.c.HGetAll(ctx, r.segmentsKey()).Result()
	if err != nil {
		return nil, err
	}
	out := make([]Segment, 0, len(m))
	for id, raw := range m {
		var s Segment
		if err := json.Unmarshal([]byte(raw), &s); err != nil {
			return nil, fmt.Errorf("세그먼트 %q 형식 오류: %w", id, err)
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (r *RedisStore) SaveSegment(ctx context.Context, s Segment) error {
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	pipe := r.c.TxPipeline()
	pipe.HSet(ctx, r.segmentsKey(), s.ID, data)
	pipe.Incr(ctx, r.segmentsVerKey())
	_, err = pipe.Exec(ctx)
	return err
}

func (r *RedisStore) DeleteSegment(ctx context.Context, id string) error {
	n, err := r.c.HDel(ctx, r.segmentsKey(), id).Result()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	if err := r.c.Incr(ctx, r.segmentsVerKey()).Err(); err != nil {
		return err
	}
	return r.c.Del(ctx,
		r.segKey(id, "seq"), r.segKey(id, "live"), r.segKey(id, "lseen"), r.segKey(id, "sseen"),
		r.segKey(id, "active"), r.segKey(id, "tk"), r.segKey(id, "tot"),
	).Err()
}

func (r *RedisStore) SegmentsVersion(ctx context.Context) (int64, error) {
	v, err := r.c.Get(ctx, r.segmentsVerKey()).Int64()
	if errors.Is(err, redis.Nil) {
		return 0, nil
	}
	return v, err
}

func (r *RedisStore) Ping(ctx context.Context) error { return r.c.Ping(ctx).Err() }

func (r *RedisStore) Close() error { return r.c.Close() }
