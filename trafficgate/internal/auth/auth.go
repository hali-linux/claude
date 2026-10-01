// Package auth 는 관리자 비밀번호 해시와 관리 콘솔 세션을 다룬다.
package auth

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// PBKDF2-HMAC-SHA256 반복 횟수 (OWASP 2023 권고값).
const DefaultIterations = 600_000

const hashScheme = "pbkdf2-sha256"

// HashPassword 는 "pbkdf2-sha256$반복$솔트$해시" 형식의 비밀번호 해시를 만든다.
func HashPassword(password string) (string, error) {
	return hashWith(password, DefaultIterations)
}

func hashWith(password string, iter int) (string, error) {
	if len(password) < 8 {
		return "", errors.New("비밀번호는 8자 이상이어야 합니다")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, iter, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s$%d$%s$%s", hashScheme, iter,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// ValidHash 는 해시 문자열 형식이 올바른지 확인한다.
func ValidHash(h string) bool {
	_, _, _, err := parseHash(h)
	return err == nil
}

func parseHash(h string) (iter int, salt, key []byte, err error) {
	parts := strings.Split(h, "$")
	if len(parts) != 4 || parts[0] != hashScheme {
		return 0, nil, nil, errors.New("지원하지 않는 비밀번호 해시 형식")
	}
	iter, err = strconv.Atoi(parts[1])
	if err != nil || iter < 10_000 || iter > 10_000_000 {
		return 0, nil, nil, errors.New("잘못된 반복 횟수")
	}
	if salt, err = base64.RawStdEncoding.DecodeString(parts[2]); err != nil || len(salt) < 8 {
		return 0, nil, nil, errors.New("잘못된 솔트")
	}
	if key, err = base64.RawStdEncoding.DecodeString(parts[3]); err != nil || len(key) != 32 {
		return 0, nil, nil, errors.New("잘못된 해시")
	}
	return iter, salt, key, nil
}

// CheckPassword 는 비밀번호가 해시와 일치하는지 상수 시간으로 비교한다.
func CheckPassword(hash, password string) bool {
	iter, salt, want, err := parseHash(hash)
	if err != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, iter, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// DummyCheck 는 존재하지 않는 사용자 로그인 시에도 같은 시간을 소비해 사용자 존재 여부 노출을 막는다.
func DummyCheck(password string) {
	_, _ = pbkdf2.Key(sha256.New, password, []byte("trafficgate-dummy-salt"), DefaultIterations, 32)
}

// ---- 세션 ----

// SessionClaims 는 관리 콘솔 세션 쿠키 내용이다.
type SessionClaims struct {
	User    string `json:"u"`
	Expires int64  `json:"exp"`
	// HashFP 는 비밀번호 해시의 지문이다. 비밀번호가 바뀌면 기존 세션이 무효가 된다.
	HashFP string `json:"fp"`
}

// Sessions 는 HMAC 서명된 무상태 세션 쿠키를 발급/검증한다.
type Sessions struct {
	key []byte
	TTL time.Duration
}

// NewSessions 는 세션 관리자를 만든다.
func NewSessions(secret string, ttl time.Duration) (*Sessions, error) {
	if len(secret) < 32 {
		return nil, errors.New("session secret 은 32자 이상이어야 합니다")
	}
	return &Sessions{key: []byte(secret), TTL: ttl}, nil
}

// Fingerprint 는 비밀번호 해시 지문을 만든다.
func Fingerprint(passwordHash string) string {
	sum := sha256.Sum256([]byte(passwordHash))
	return base64.RawURLEncoding.EncodeToString(sum[:9])
}

func (s *Sessions) mac(body string) string {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte("session:" + body))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// Issue 는 세션 쿠키 값을 만든다.
func (s *Sessions) Issue(user, passwordHash string, now time.Time) string {
	payload, _ := json.Marshal(SessionClaims{User: user, Expires: now.Add(s.TTL).Unix(), HashFP: Fingerprint(passwordHash)})
	body := base64.RawURLEncoding.EncodeToString(payload)
	return body + "." + s.mac(body)
}

// Verify 는 세션 쿠키 값을 검증한다.
func (s *Sessions) Verify(value string, now time.Time) (SessionClaims, error) {
	body, sig, ok := strings.Cut(value, ".")
	if !ok || len(value) > 2048 {
		return SessionClaims{}, errors.New("malformed session")
	}
	if !hmac.Equal([]byte(sig), []byte(s.mac(body))) {
		return SessionClaims{}, errors.New("invalid session signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return SessionClaims{}, errors.New("malformed session")
	}
	var c SessionClaims
	if err := json.Unmarshal(payload, &c); err != nil {
		return SessionClaims{}, errors.New("malformed session")
	}
	if now.Unix() >= c.Expires {
		return c, errors.New("session expired")
	}
	return c, nil
}

// RandomString 은 n 바이트 난수를 base64url 로 인코딩한 문자열을 만든다.
func RandomString(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// RandomPassword 는 사람이 입력하기 쉬운 문자로 된 무작위 비밀번호를 만든다.
func RandomPassword(n int) string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}
