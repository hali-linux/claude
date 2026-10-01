package token

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

const (
	secretA = "0123456789abcdef0123456789abcdef-A"
	secretB = "0123456789abcdef0123456789abcdef-B"
)

func TestIssueVerify(t *testing.T) {
	s, err := NewSigner(secretA)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	tok := s.Issue("event", "tkt", now, time.Minute)
	c, err := s.Verify(tok, "event", now.Add(59*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if c.Segment != "event" || c.Ticket != "tkt" || c.Expires != now.Unix()+60 {
		t.Fatalf("claims = %+v", c)
	}
	if _, err := s.Verify(tok, "", now); err != nil {
		t.Fatalf("verify without segment: %v", err)
	}
	if _, err := s.Verify(tok, "other", now); !errors.Is(err, ErrSegment) {
		t.Fatalf("segment mismatch err = %v", err)
	}
	if _, err := s.Verify(tok, "event", now.Add(time.Minute)); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired err = %v", err)
	}
	// 서명 변조
	tampered := tok[:len(tok)-2] + "AA"
	if _, err := s.Verify(tampered, "event", now); err == nil {
		t.Fatal("tampered token accepted")
	}
	// 페이로드 변조
	parts := strings.Split(tok, ".")
	evil := "v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"s":"event","t":"x","iat":1,"exp":9999999999}`)) + "." + parts[2]
	if _, err := s.Verify(evil, "event", now); !errors.Is(err, ErrSignature) {
		t.Fatalf("payload tamper err = %v", err)
	}
	for _, bad := range []string{"", "v1.", "v2.a.b", "v1.abc", "v1.!!.!!"} {
		if _, err := s.Verify(bad, "", now); err == nil {
			t.Errorf("malformed %q accepted", bad)
		}
	}
}

func TestKeyRotation(t *testing.T) {
	oldS, _ := NewSigner(secretA)
	newS, _ := NewSigner(secretB, secretA)
	now := time.Now()
	if _, err := newS.Verify(oldS.Issue("s", "t", now, time.Minute), "s", now); err != nil {
		t.Fatalf("token signed with previous key rejected: %v", err)
	}
	if _, err := oldS.Verify(newS.Issue("s", "t", now, time.Minute), "s", now); !errors.Is(err, ErrSignature) {
		t.Fatalf("old signer must not accept new key: %v", err)
	}
	if _, err := NewSigner("short"); err == nil {
		t.Fatal("short secret accepted")
	}
}

// 문서에 적힌 검증 절차(다른 언어 구현용)와 실제 서명이 일치하는지 확인한다.
func TestDocumentedFormat(t *testing.T) {
	s, _ := NewSigner(secretA)
	tok := s.Issue("seg", "tkt", time.Unix(1_800_000_000, 0), time.Minute)
	i := strings.LastIndexByte(tok, '.')
	m := hmac.New(sha256.New, []byte(secretA))
	m.Write([]byte(tok[:i]))
	if got := base64.RawURLEncoding.EncodeToString(m.Sum(nil)); got != tok[i+1:] {
		t.Fatalf("signature mismatch: %s vs %s", got, tok[i+1:])
	}
	payload, _ := base64.RawURLEncoding.DecodeString(strings.Split(tok, ".")[1])
	if string(payload) != `{"s":"seg","t":"tkt","iat":1800000000,"exp":1800000060}` {
		t.Fatalf("payload = %s", payload)
	}
}
