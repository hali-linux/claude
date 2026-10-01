package spop

import (
	"bytes"
	"context"
	"math"
	"net"
	"sync"
	"testing"
	"time"
)

func TestVarintBoundaries(t *testing.T) {
	// Byte lengths from the table in HAProxy's doc/SPOE.txt (section 3.1).
	cases := []struct {
		v   uint64
		len int
	}{
		{0, 1}, {239, 1}, {240, 2}, {2287, 2}, {2288, 3}, {264431, 3},
		{264432, 4}, {33818863, 4}, {33818864, 5}, {4328786159, 5}, {4328786160, 6},
	}
	for _, c := range cases {
		b := AppendVarint(nil, c.v)
		if len(b) != c.len {
			t.Errorf("AppendVarint(%d) = %d bytes, want %d", c.v, len(b), c.len)
		}
		got, n, err := ReadVarint(b)
		if err != nil || got != c.v || n != len(b) {
			t.Errorf("ReadVarint(%x) = %d, %d, %v; want %d", b, got, n, err, c.v)
		}
	}
	if b := AppendVarint(nil, 240); !bytes.Equal(b, []byte{0xF0, 0x00}) {
		t.Errorf("AppendVarint(240) = %x, want f000", b)
	}
	if b := AppendVarint(nil, 256); !bytes.Equal(b, []byte{0xF0, 0x01}) {
		t.Errorf("AppendVarint(256) = %x, want f001", b)
	}
}

func TestVarintRoundTrip(t *testing.T) {
	for _, v := range []uint64{1, 127, 128, 255, 1000, 65535, 1 << 20, 1<<32 - 1, 1 << 40, math.MaxUint64 - 1, math.MaxUint64} {
		b := AppendVarint(nil, v)
		got, n, err := ReadVarint(b)
		if err != nil || got != v || n != len(b) {
			t.Fatalf("round trip %d: got %d (n=%d, err=%v)", v, got, n, err)
		}
	}
	if _, _, err := ReadVarint([]byte{0xF0, 0x80}); err == nil {
		t.Fatal("expected error on truncated varint")
	}
}

func TestMessagesAndActionsRoundTrip(t *testing.T) {
	msgs := []Message{{Name: "check", Args: []Arg{
		{"s", "hello"}, {"b", []byte{0, 1, 2}}, {"i", int64(-5)}, {"u", uint64(7)},
		{"ip4", net.ParseIP("192.0.2.1")}, {"ip6", net.ParseIP("2001:db8::1")},
		{"t", true}, {"f", false}, {"n", nil}, {"", "unnamed"},
	}}}
	payload, err := AppendMessages(nil, msgs)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeMessages(payload)
	if err != nil {
		t.Fatal(err)
	}
	m := got[0]
	if v, _ := m.Get("s"); v != "hello" {
		t.Errorf("s = %v", v)
	}
	if v, _ := m.Get("b"); !bytes.Equal(v.([]byte), []byte{0, 1, 2}) {
		t.Errorf("b = %v", v)
	}
	if v, _ := m.Get("i"); v != int64(-5) {
		t.Errorf("i = %v", v)
	}
	if v, _ := m.Get("u"); v != uint64(7) {
		t.Errorf("u = %v", v)
	}
	if v, _ := m.Get("ip4"); v.(net.IP).String() != "192.0.2.1" {
		t.Errorf("ip4 = %v", v)
	}
	if v, _ := m.Get("ip6"); v.(net.IP).String() != "2001:db8::1" {
		t.Errorf("ip6 = %v", v)
	}
	if v, _ := m.Get("t"); v != true {
		t.Errorf("t = %v", v)
	}
	if v, _ := m.Get("f"); v != false {
		t.Errorf("f = %v", v)
	}
	if v, ok := m.Get("n"); !ok || v != nil {
		t.Errorf("n = %v, %v", v, ok)
	}

	acts := []Action{SetVar(ScopeTransaction, "action", "block"), SetVar(ScopeTransaction, "status", int64(403)), {Scope: ScopeRequest, Name: "x", Unset: true}}
	ap, err := AppendActions(nil, acts)
	if err != nil {
		t.Fatal(err)
	}
	gotActs, err := DecodeActions(ap)
	if err != nil {
		t.Fatal(err)
	}
	if len(gotActs) != 3 || gotActs[0].Value != "block" || gotActs[1].Value != int64(403) || !gotActs[2].Unset {
		t.Fatalf("actions = %+v", gotActs)
	}
}

// fakeHAProxy speaks the HAProxy side of SPOP.
type fakeHAProxy struct {
	t  *testing.T
	nc net.Conn
}

func (h *fakeHAProxy) send(f *Frame) {
	h.t.Helper()
	if _, err := h.nc.Write(AppendFrame(nil, f)); err != nil {
		h.t.Fatal(err)
	}
}

func (h *fakeHAProxy) recv() *Frame {
	h.t.Helper()
	h.nc.SetReadDeadline(time.Now().Add(5 * time.Second))
	f, err := ReadFrame(h.nc, 1<<20)
	if err != nil {
		h.t.Fatal(err)
	}
	return f
}

func (h *fakeHAProxy) hello(healthcheck bool) map[string]any {
	h.t.Helper()
	kvs := []KV{{"supported-versions", "2.0"}, {"max-frame-size", uint32(16380)}, {"capabilities", "pipelining,async"}}
	if healthcheck {
		kvs = append(kvs, KV{"healthcheck", true})
	}
	p, _ := appendKVList(nil, kvs)
	h.send(&Frame{Type: FrameHAProxyHello, Flags: FlagFin, Payload: p})
	f := h.recv()
	if f.Type != FrameAgentHello {
		h.t.Fatalf("got frame type %d, want AGENT-HELLO", f.Type)
	}
	got, err := decodeKVList(&decoder{b: f.Payload})
	if err != nil {
		h.t.Fatal(err)
	}
	out := map[string]any{}
	for _, kv := range got {
		out[kv.Name] = kv.Value
	}
	return out
}

func startServer(t *testing.T, h Handler) (*Server, string) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Handler: h, MaxFrameSize: 1 << 20, MaxConcurrency: 8}
	go s.Serve(l)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		s.Shutdown(ctx)
	})
	return s, l.Addr().String()
}

func dial(t *testing.T, addr string) *fakeHAProxy {
	t.Helper()
	nc, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { nc.Close() })
	return &fakeHAProxy{t: t, nc: nc}
}

func TestServerHandshakeNotifyAck(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	_, addr := startServer(t, func(_ context.Context, msgs []Message) []Action {
		v, _ := msgs[0].Get("path")
		mu.Lock()
		seen = append(seen, v.(string))
		mu.Unlock()
		if v == "/slow" {
			time.Sleep(100 * time.Millisecond)
		}
		return []Action{SetVar(ScopeTransaction, "path", v)}
	})
	h := dial(t, addr)
	hello := h.hello(false)
	if hello["version"] != "2.0" || hello["max-frame-size"] != uint64(16380) || hello["capabilities"] != "pipelining" {
		t.Fatalf("unexpected AGENT-HELLO: %v", hello)
	}

	// Pipelining: two NOTIFY frames before reading any ACK; the fast one
	// may be acknowledged first.
	for i, path := range []string{"/slow", "/fast"} {
		p, _ := AppendMessages(nil, []Message{{Name: "req", Args: []Arg{{"path", path}}}})
		h.send(&Frame{Type: FrameNotify, Flags: FlagFin, StreamID: uint64(300 + i), FrameID: 1, Payload: p})
	}
	got := map[uint64]string{}
	for i := 0; i < 2; i++ {
		f := h.recv()
		if f.Type != FrameAck || f.FrameID != 1 {
			t.Fatalf("unexpected frame %+v", f)
		}
		acts, err := DecodeActions(f.Payload)
		if err != nil {
			t.Fatal(err)
		}
		got[f.StreamID] = acts[0].Value.(string)
	}
	if got[300] != "/slow" || got[301] != "/fast" {
		t.Fatalf("ACKs not matched to streams: %v", got)
	}

	// Graceful disconnect.
	p, _ := appendKVList(nil, []KV{{"status-code", uint32(0)}, {"message", ""}})
	h.send(&Frame{Type: FrameHAProxyDisconnect, Flags: FlagFin, Payload: p})
	if f := h.recv(); f.Type != FrameAgentDisconnect {
		t.Fatalf("got frame type %d, want AGENT-DISCONNECT", f.Type)
	}
}

func TestServerHealthcheck(t *testing.T) {
	_, addr := startServer(t, func(context.Context, []Message) []Action { return nil })
	h := dial(t, addr)
	h.hello(true)
	h.nc.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := h.nc.Read(make([]byte, 1)); err == nil {
		t.Fatal("expected the agent to close the connection after a health check")
	}
}

func TestServerRejectsBadVersionAndOversizedFrames(t *testing.T) {
	_, addr := startServer(t, func(context.Context, []Message) []Action { return nil })

	h := dial(t, addr)
	p, _ := appendKVList(nil, []KV{{"supported-versions", "1.0"}, {"max-frame-size", uint32(16380)}, {"capabilities", ""}})
	h.send(&Frame{Type: FrameHAProxyHello, Flags: FlagFin, Payload: p})
	f := h.recv()
	if f.Type != FrameAgentDisconnect {
		t.Fatalf("got frame type %d, want AGENT-DISCONNECT", f.Type)
	}
	if status, _ := decodeDisconnect(f.Payload); status != StatusBadVersion {
		t.Fatalf("status = %d, want %d", status, StatusBadVersion)
	}

	h2 := dial(t, addr)
	h2.hello(false) // negotiates 16380
	big := make([]byte, 20000)
	h2.send(&Frame{Type: FrameNotify, Flags: FlagFin, StreamID: 1, FrameID: 1, Payload: big})
	f = h2.recv()
	if status, _ := decodeDisconnect(f.Payload); f.Type != FrameAgentDisconnect || status != StatusTooBig {
		t.Fatalf("got type %d status %d, want AGENT-DISCONNECT/too big", f.Type, status)
	}
}

func TestServerPanicSendsEmptyAck(t *testing.T) {
	_, addr := startServer(t, func(context.Context, []Message) []Action { panic("boom") })
	h := dial(t, addr)
	h.hello(false)
	p, _ := AppendMessages(nil, []Message{{Name: "req"}})
	h.send(&Frame{Type: FrameNotify, Flags: FlagFin, StreamID: 9, FrameID: 4, Payload: p})
	f := h.recv()
	if f.Type != FrameAck || f.StreamID != 9 || f.FrameID != 4 || len(f.Payload) != 0 {
		t.Fatalf("unexpected frame %+v", f)
	}
}
