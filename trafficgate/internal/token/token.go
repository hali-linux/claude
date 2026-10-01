// Package token 은 대기열 통과 토큰(Pass Token)을 발급하고 검증한다.
//
// 형식: "v1.<payload>.<signature>"
//   - payload   = base64url(JSON{"s":세그먼트,"t":티켓,"iat":발급시각,"exp":만료시각})  (패딩 없음)
//   - signature = base64url(HMAC-SHA256(token_secret, "v1." + payload))           (패딩 없음)
//
// 백엔드 서버는 token_secret 만 있으면 Java/Node/Python 등에서 직접 검증할 수 있다.
package token

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const prefix = "v1."

var (
	ErrMalformed = errors.New("malformed token")
	ErrSignature = errors.New("invalid token signature")
	ErrExpired   = errors.New("token expired")
	ErrSegment   = errors.New("token segment mismatch")
)

// Claims 는 토큰 내용이다.
type Claims struct {
	Segment  string `json:"s"`
	Ticket   string `json:"t,omitempty"`
	IssuedAt int64  `json:"iat"`
	Expires  int64  `json:"exp"`
}

// Signer 는 토큰을 발급/검증한다. 검증 시 이전 키(키 교체 중)도 허용한다.
type Signer struct {
	keys [][]byte
}

// NewSigner 는 현재 키와 이전 키들로 Signer 를 만든다.
func NewSigner(current string, previous ...string) (*Signer, error) {
	if len(current) < 32 {
		return nil, errors.New("token secret 은 32자 이상이어야 합니다")
	}
	s := &Signer{keys: [][]byte{[]byte(current)}}
	for _, p := range previous {
		if p != "" {
			s.keys = append(s.keys, []byte(p))
		}
	}
	return s, nil
}

func sign(key []byte, msg string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(msg))
	return m.Sum(nil)
}

// Issue 는 토큰을 발급한다.
func (s *Signer) Issue(segment, ticket string, now time.Time, ttl time.Duration) string {
	c := Claims{Segment: segment, Ticket: ticket, IssuedAt: now.Unix(), Expires: now.Add(ttl).Unix()}
	payload, _ := json.Marshal(c)
	body := prefix + base64.RawURLEncoding.EncodeToString(payload)
	return body + "." + base64.RawURLEncoding.EncodeToString(sign(s.keys[0], body))
}

// Verify 는 토큰을 검증한다. segment 가 비어 있지 않으면 세그먼트 일치도 확인한다.
func (s *Signer) Verify(tok, segment string, now time.Time) (Claims, error) {
	if len(tok) > 1024 || !strings.HasPrefix(tok, prefix) {
		return Claims{}, ErrMalformed
	}
	dot := strings.LastIndexByte(tok, '.')
	if dot <= len(prefix) {
		return Claims{}, ErrMalformed
	}
	body, sigPart := tok[:dot], tok[dot+1:]
	sig, err := base64.RawURLEncoding.DecodeString(sigPart)
	if err != nil {
		return Claims{}, ErrMalformed
	}
	valid := false
	for _, k := range s.keys {
		if hmac.Equal(sig, sign(k, body)) {
			valid = true
			break
		}
	}
	if !valid {
		return Claims{}, ErrSignature
	}
	payload, err := base64.RawURLEncoding.DecodeString(body[len(prefix):])
	if err != nil {
		return Claims{}, ErrMalformed
	}
	var c Claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return Claims{}, ErrMalformed
	}
	if now.Unix() >= c.Expires {
		return c, ErrExpired
	}
	if segment != "" && c.Segment != segment {
		return c, ErrSegment
	}
	return c, nil
}
