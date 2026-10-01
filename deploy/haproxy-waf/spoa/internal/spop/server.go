package spop

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Handler processes the messages of one NOTIFY frame and returns the actions
// to send back in the ACK frame. It is called concurrently.
type Handler func(ctx context.Context, msgs []Message) []Action

// Server is an SPOP agent server.
type Server struct {
	Handler Handler
	// MaxFrameSize is the largest frame the agent accepts. The value
	// announced to HAProxy is min(MaxFrameSize, HAProxy's max-frame-size).
	MaxFrameSize uint32
	// MaxConcurrency bounds the number of NOTIFY frames processed at once
	// across all connections. When reached, the agent stops reading new
	// frames, which applies back-pressure to HAProxy.
	MaxConcurrency int
	// HelloTimeout bounds the HELLO handshake.
	HelloTimeout time.Duration
	Logger       *slog.Logger

	sem      chan struct{}
	initOnce sync.Once
	mu       sync.Mutex
	lns      map[net.Listener]struct{}
	conns    map[*conn]struct{}
	closing  atomic.Bool
	connWG   sync.WaitGroup
}

func (s *Server) init() {
	s.initOnce.Do(func() {
		if s.MaxFrameSize < MinFrameSize {
			s.MaxFrameSize = 1 << 20
		}
		if s.MaxConcurrency <= 0 {
			s.MaxConcurrency = 64
		}
		if s.HelloTimeout <= 0 {
			s.HelloTimeout = 5 * time.Second
		}
		if s.Logger == nil {
			s.Logger = slog.Default()
		}
		s.sem = make(chan struct{}, s.MaxConcurrency)
		s.lns = map[net.Listener]struct{}{}
		s.conns = map[*conn]struct{}{}
	})
}

// ErrServerClosed is returned by Serve after Shutdown.
var ErrServerClosed = errors.New("spop: server closed")

// Serve accepts connections on l until Shutdown is called.
func (s *Server) Serve(l net.Listener) error {
	s.init()
	s.mu.Lock()
	if s.closing.Load() {
		s.mu.Unlock()
		return ErrServerClosed
	}
	s.lns[l] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.lns, l)
		s.mu.Unlock()
	}()

	var backoff time.Duration
	for {
		nc, err := l.Accept()
		if err != nil {
			if s.closing.Load() {
				return ErrServerClosed
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				backoff = min(max(2*backoff, 5*time.Millisecond), time.Second)
				s.Logger.Warn("accept error; retrying", "err", err, "backoff", backoff)
				time.Sleep(backoff)
				continue
			}
			return err
		}
		backoff = 0
		c := &conn{s: s, nc: nc, log: s.Logger.With("peer", nc.RemoteAddr().String())}
		s.mu.Lock()
		if s.closing.Load() {
			s.mu.Unlock()
			nc.Close()
			return ErrServerClosed
		}
		s.conns[c] = struct{}{}
		s.connWG.Add(1)
		s.mu.Unlock()
		go c.serve()
	}
}

// Shutdown stops accepting connections, lets in-flight NOTIFY frames finish,
// sends AGENT-DISCONNECT on every connection and waits until they are closed
// or ctx expires.
func (s *Server) Shutdown(ctx context.Context) error {
	s.init()
	s.mu.Lock()
	s.closing.Store(true)
	for l := range s.lns {
		l.Close()
	}
	for c := range s.conns {
		// Unblock the reader; serve() then drains and disconnects.
		c.nc.SetReadDeadline(time.Now())
	}
	s.mu.Unlock()

	done := make(chan struct{})
	go func() { s.connWG.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		s.mu.Lock()
		for c := range s.conns {
			c.nc.Close()
		}
		s.mu.Unlock()
		return ctx.Err()
	}
}

type conn struct {
	s        *Server
	nc       net.Conn
	log      *slog.Logger
	wmu      sync.Mutex
	maxFrame uint32
	inflight sync.WaitGroup
}

func (c *conn) serve() {
	defer func() {
		c.inflight.Wait()
		c.nc.Close()
		c.s.mu.Lock()
		delete(c.s.conns, c)
		c.s.mu.Unlock()
		c.s.connWG.Done()
	}()

	healthcheck, err := c.handshake()
	if err != nil {
		c.fail(err)
		return
	}
	if healthcheck {
		return
	}

	for {
		c.nc.SetReadDeadline(time.Time{})
		if c.s.closing.Load() {
			c.disconnect(StatusNormal, "agent is shutting down")
			return
		}
		f, err := ReadFrame(c.nc, c.maxFrame)
		if err != nil {
			if c.s.closing.Load() {
				c.disconnect(StatusNormal, "agent is shutting down")
				return
			}
			c.fail(err)
			return
		}
		switch f.Type {
		case FrameNotify:
			if f.Flags&FlagFin == 0 {
				c.fail(protoErr(StatusFragNotSupported, "fragmented NOTIFY frames are not supported"))
				return
			}
			msgs, err := DecodeMessages(f.Payload)
			if err != nil {
				c.fail(protoErr(StatusInvalid, "invalid NOTIFY payload: %v", err))
				return
			}
			c.s.sem <- struct{}{}
			c.inflight.Add(1)
			go c.process(f.StreamID, f.FrameID, msgs)
		case FrameHAProxyDisconnect:
			status, msg := decodeDisconnect(f.Payload)
			if status != StatusNormal {
				c.log.Warn("HAProxy closed the connection", "status", status, "message", msg)
			}
			c.disconnect(StatusNormal, "")
			return
		case FrameUnset:
			c.fail(protoErr(StatusFragNotSupported, "fragmented frames are not supported"))
			return
		case FrameHAProxyHello:
			c.fail(protoErr(StatusInvalid, "unexpected HAPROXY-HELLO"))
			return
		default:
			// "Unknown frames may be silently skipped."
		}
	}
}

func (c *conn) handshake() (healthcheck bool, err error) {
	c.nc.SetReadDeadline(time.Now().Add(c.s.HelloTimeout))
	f, err := ReadFrame(c.nc, c.s.MaxFrameSize)
	if err != nil {
		return false, err
	}
	if f.Type != FrameHAProxyHello {
		return false, protoErr(StatusInvalid, "expected HAPROXY-HELLO, got frame type %d", f.Type)
	}
	if f.Flags&FlagFin == 0 {
		return false, protoErr(StatusFragNotSupported, "fragmented HELLO")
	}
	kvs, err := decodeKVList(&decoder{b: f.Payload})
	if err != nil {
		return false, protoErr(StatusInvalid, "invalid HAPROXY-HELLO: %v", err)
	}
	var versions, caps string
	var maxFrame uint64
	var haveVersions, haveCaps bool
	for _, kv := range kvs {
		switch kv.Name {
		case "supported-versions":
			versions, haveVersions = kv.Value.(string)
		case "max-frame-size":
			switch v := kv.Value.(type) {
			case uint64:
				maxFrame = v
			case int64:
				if v > 0 {
					maxFrame = uint64(v)
				}
			}
		case "capabilities":
			caps, haveCaps = kv.Value.(string)
		case "healthcheck":
			healthcheck, _ = kv.Value.(bool)
		}
	}
	if !haveVersions {
		return false, protoErr(StatusNoVersion, "supported-versions missing")
	}
	if !supportsV2(versions) {
		return false, protoErr(StatusBadVersion, "no supported SPOP version in %q", versions)
	}
	if maxFrame == 0 {
		return false, protoErr(StatusNoFrameSize, "max-frame-size missing")
	}
	if !haveCaps {
		return false, protoErr(StatusNoCapabilities, "capabilities missing")
	}
	c.maxFrame = uint32(min(maxFrame, uint64(c.s.MaxFrameSize)))
	if c.maxFrame < MinFrameSize {
		return false, protoErr(StatusBadFrameSize, "max-frame-size %d is too small", maxFrame)
	}
	payload, _ := appendKVList(nil, []KV{
		{"version", "2.0"},
		{"max-frame-size", uint32(c.maxFrame)},
		{"capabilities", "pipelining"},
	})
	if err := c.write(&Frame{Type: FrameAgentHello, Flags: FlagFin, Payload: payload}); err != nil {
		return false, err
	}
	if !healthcheck {
		c.log.Debug("SPOP connection established", "max_frame_size", c.maxFrame, "haproxy_capabilities", caps)
	}
	return healthcheck, nil
}

func supportsV2(versions string) bool {
	for _, v := range strings.Split(versions, ",") {
		if major, _, _ := strings.Cut(strings.TrimSpace(v), "."); major == "2" {
			return true
		}
	}
	return false
}

func (c *conn) process(streamID, frameID uint64, msgs []Message) {
	defer func() {
		<-c.s.sem
		c.inflight.Done()
	}()
	var actions []Action
	func() {
		defer func() {
			if r := recover(); r != nil {
				// No verdict is sent; HAProxy treats a missing verdict as an
				// error and applies its fail-open/fail-closed policy.
				c.log.Error("handler panic", "panic", r, "stack", string(debug.Stack()))
				actions = nil
			}
		}()
		actions = c.s.Handler(context.Background(), msgs)
	}()
	payload, err := AppendActions(nil, actions)
	if err != nil {
		c.log.Error("cannot encode actions", "err", err)
		payload = nil
	}
	f := &Frame{Type: FrameAck, Flags: FlagFin, StreamID: streamID, FrameID: frameID, Payload: payload}
	if frameSize(f) > c.maxFrame {
		c.log.Error("ACK exceeds max-frame-size; sending empty ACK", "size", frameSize(f), "max", c.maxFrame)
		f.Payload = nil
	}
	if err := c.write(f); err != nil && !errors.Is(err, net.ErrClosed) {
		c.log.Debug("cannot write ACK", "err", err)
	}
}

func frameSize(f *Frame) uint32 {
	return uint32(1 + 4 + len(AppendVarint(nil, f.StreamID)) + len(AppendVarint(nil, f.FrameID)) + len(f.Payload))
}

func (c *conn) write(f *Frame) error {
	buf := AppendFrame(make([]byte, 0, 16+len(f.Payload)), f)
	c.wmu.Lock()
	defer c.wmu.Unlock()
	c.nc.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err := c.nc.Write(buf)
	return err
}

// disconnect waits for in-flight frames, then sends AGENT-DISCONNECT.
func (c *conn) disconnect(status uint32, message string) {
	c.inflight.Wait()
	payload, _ := appendKVList(nil, []KV{
		{"status-code", uint32(status)},
		{"message", message},
	})
	_ = c.write(&Frame{Type: FrameAgentDisconnect, Flags: FlagFin, Payload: payload})
}

func (c *conn) fail(err error) {
	var pe *ProtocolError
	switch {
	case errors.As(err, &pe):
		c.log.Warn("SPOP protocol error", "err", err)
		c.disconnect(pe.Status, pe.Message)
	case errors.Is(err, io.EOF), errors.Is(err, net.ErrClosed), errors.Is(err, io.ErrUnexpectedEOF):
		// HAProxy closed the connection (normal on reload or health check).
	default:
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			c.disconnect(StatusTimeout, "timeout")
			return
		}
		c.log.Debug("SPOP connection error", "err", err)
	}
}

func decodeDisconnect(payload []byte) (uint32, string) {
	kvs, err := decodeKVList(&decoder{b: payload})
	if err != nil {
		return StatusInvalid, "invalid DISCONNECT payload"
	}
	var status uint32
	var msg string
	for _, kv := range kvs {
		switch kv.Name {
		case "status-code":
			switch v := kv.Value.(type) {
			case uint64:
				status = uint32(v)
			case int64:
				status = uint32(v)
			}
		case "message":
			msg, _ = kv.Value.(string)
		}
	}
	return status, msg
}
