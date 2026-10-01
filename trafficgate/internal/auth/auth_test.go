package auth

import (
	"strings"
	"testing"
	"time"
)

func TestPasswordHash(t *testing.T) {
	h, err := hashWith("correct horse", 10_000)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "pbkdf2-sha256$10000$") || !ValidHash(h) {
		t.Fatalf("unexpected hash %q", h)
	}
	if !CheckPassword(h, "correct horse") {
		t.Fatal("correct password rejected")
	}
	if CheckPassword(h, "wrong horse") {
		t.Fatal("wrong password accepted")
	}
	if CheckPassword("plain", "plain") || ValidHash("pbkdf2-sha256$1$AA$AA") {
		t.Fatal("invalid hash format accepted")
	}
	if _, err := HashPassword("short"); err == nil {
		t.Fatal("short password accepted")
	}
	h2, _ := hashWith("correct horse", 10_000)
	if h == h2 {
		t.Fatal("salt not random")
	}
}

func TestSessions(t *testing.T) {
	s, err := NewSessions(strings.Repeat("k", 32), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	v := s.Issue("admin", "hash-1", now)
	c, err := s.Verify(v, now.Add(30*time.Minute))
	if err != nil || c.User != "admin" || c.HashFP != Fingerprint("hash-1") {
		t.Fatalf("verify: %+v %v", c, err)
	}
	if _, err := s.Verify(v, now.Add(2*time.Hour)); err == nil {
		t.Fatal("expired session accepted")
	}
	if _, err := s.Verify(v+"x", now); err == nil {
		t.Fatal("tampered session accepted")
	}
	other, _ := NewSessions(strings.Repeat("z", 32), time.Hour)
	if _, err := other.Verify(v, now); err == nil {
		t.Fatal("session from other key accepted")
	}
	if Fingerprint("hash-1") == Fingerprint("hash-2") {
		t.Fatal("fingerprint collision")
	}
}

func TestRandom(t *testing.T) {
	if p := RandomPassword(16); len(p) != 16 || p == RandomPassword(16) {
		t.Fatalf("bad random password %q", p)
	}
	if len(RandomString(32)) != 43 {
		t.Fatal("unexpected random string length")
	}
}
