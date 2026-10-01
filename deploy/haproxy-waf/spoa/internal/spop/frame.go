package spop

import (
	"encoding/binary"
	"fmt"
	"io"
)

// Frame types.
const (
	FrameUnset             = 0
	FrameHAProxyHello      = 1
	FrameHAProxyDisconnect = 2
	FrameNotify            = 3
	FrameAgentHello        = 101
	FrameAgentDisconnect   = 102
	FrameAck               = 103
)

// Frame flags (32 bits, network byte order).
const (
	FlagFin   = 0x00000001
	FlagAbort = 0x00000002
)

// Status codes carried by DISCONNECT frames.
const (
	StatusNormal           = 0
	StatusIO               = 1
	StatusTimeout          = 2
	StatusTooBig           = 3
	StatusInvalid          = 4
	StatusNoVersion        = 5
	StatusNoFrameSize      = 6
	StatusNoCapabilities   = 7
	StatusBadVersion       = 8
	StatusBadFrameSize     = 9
	StatusFragNotSupported = 10
	StatusInterlaced       = 11
	StatusFrameIDNotFound  = 12
	StatusResource         = 13
	StatusUnknown          = 99
)

// MinFrameSize is the smallest max-frame-size a peer may announce.
const MinFrameSize = 256

// Frame is one decoded SPOP frame.
type Frame struct {
	Type     byte
	Flags    uint32
	StreamID uint64
	FrameID  uint64
	Payload  []byte
}

// ProtocolError is a fatal error that must be reported to HAProxy with an
// AGENT-DISCONNECT frame carrying Status.
type ProtocolError struct {
	Status  uint32
	Message string
}

func (e *ProtocolError) Error() string {
	return fmt.Sprintf("spop: %s (status %d)", e.Message, e.Status)
}

func protoErr(status uint32, format string, args ...any) *ProtocolError {
	return &ProtocolError{Status: status, Message: fmt.Sprintf(format, args...)}
}

// ReadFrame reads one length-prefixed frame. Frames larger than maxSize are
// rejected without reading their body.
func ReadFrame(r io.Reader, maxSize uint32) (*Frame, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n > maxSize {
		return nil, protoErr(StatusTooBig, "frame of %d bytes exceeds max-frame-size %d", n, maxSize)
	}
	if n < 7 { // type + flags + 2 one-byte varints
		return nil, protoErr(StatusInvalid, "frame too short (%d bytes)", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return parseFrame(buf)
}

func parseFrame(buf []byte) (*Frame, error) {
	d := &decoder{b: buf}
	t, _ := d.byte()
	fl, err := d.next(4)
	if err != nil {
		return nil, protoErr(StatusInvalid, "missing flags")
	}
	f := &Frame{Type: t, Flags: binary.BigEndian.Uint32(fl)}
	if f.StreamID, err = d.varint(); err != nil {
		return nil, protoErr(StatusInvalid, "bad stream-id")
	}
	if f.FrameID, err = d.varint(); err != nil {
		return nil, protoErr(StatusInvalid, "bad frame-id")
	}
	f.Payload = buf[d.off:]
	return f, nil
}

// AppendFrame serializes a frame, including its 4-byte length prefix.
func AppendFrame(b []byte, f *Frame) []byte {
	start := len(b)
	b = append(b, 0, 0, 0, 0, f.Type)
	b = binary.BigEndian.AppendUint32(b, f.Flags)
	b = AppendVarint(b, f.StreamID)
	b = AppendVarint(b, f.FrameID)
	b = append(b, f.Payload...)
	binary.BigEndian.PutUint32(b[start:], uint32(len(b)-start-4))
	return b
}

// Arg is one argument of a message. Unnamed arguments have an empty name.
type Arg struct {
	Name  string
	Value any
}

// Message is one SPOE message carried in a NOTIFY frame.
type Message struct {
	Name string
	Args []Arg
}

// Get returns the value of the first argument with the given name.
func (m *Message) Get(name string) (any, bool) {
	for _, a := range m.Args {
		if a.Name == name {
			return a.Value, true
		}
	}
	return nil, false
}

// DecodeMessages parses the LIST-OF-MESSAGES payload of a NOTIFY frame.
func DecodeMessages(payload []byte) ([]Message, error) {
	d := &decoder{b: payload}
	var msgs []Message
	for !d.empty() {
		name, err := d.bytes()
		if err != nil {
			return nil, err
		}
		nargs, err := d.byte()
		if err != nil {
			return nil, err
		}
		m := Message{Name: string(name), Args: make([]Arg, 0, nargs)}
		for i := 0; i < int(nargs); i++ {
			an, err := d.bytes()
			if err != nil {
				return nil, err
			}
			v, err := d.value()
			if err != nil {
				return nil, err
			}
			m.Args = append(m.Args, Arg{Name: string(an), Value: v})
		}
		msgs = append(msgs, m)
	}
	return msgs, nil
}

// AppendMessages serializes messages as a NOTIFY payload (used by tests and
// tools that emulate HAProxy).
func AppendMessages(b []byte, msgs []Message) ([]byte, error) {
	var err error
	for _, m := range msgs {
		if len(m.Args) > 255 {
			return nil, fmt.Errorf("spop: too many args in message %q", m.Name)
		}
		b = appendName(b, m.Name)
		b = append(b, byte(len(m.Args)))
		for _, a := range m.Args {
			b = appendName(b, a.Name)
			if b, err = AppendValue(b, a.Value); err != nil {
				return nil, err
			}
		}
	}
	return b, nil
}

// Variable scopes for set-var / unset-var actions.
type Scope byte

const (
	ScopeProcess     Scope = 0
	ScopeSession     Scope = 1
	ScopeTransaction Scope = 2
	ScopeRequest     Scope = 3
	ScopeResponse    Scope = 4
)

const (
	actionSetVar   = 1
	actionUnsetVar = 2
)

// Action is a set-var (Value != nil) or unset-var (Unset) action.
type Action struct {
	Scope Scope
	Name  string
	Value any
	Unset bool
}

// SetVar builds a set-var action. HAProxy prefixes Name with the agent's
// "option var-prefix".
func SetVar(scope Scope, name string, value any) Action {
	return Action{Scope: scope, Name: name, Value: value}
}

// AppendActions serializes actions as an ACK payload.
func AppendActions(b []byte, actions []Action) ([]byte, error) {
	var err error
	for _, a := range actions {
		if a.Unset {
			b = append(b, actionUnsetVar, 2, byte(a.Scope))
			b = appendName(b, a.Name)
			continue
		}
		b = append(b, actionSetVar, 3, byte(a.Scope))
		b = appendName(b, a.Name)
		if b, err = AppendValue(b, a.Value); err != nil {
			return nil, err
		}
	}
	return b, nil
}

// DecodeActions parses an ACK payload (used by tests).
func DecodeActions(payload []byte) ([]Action, error) {
	d := &decoder{b: payload}
	var out []Action
	for !d.empty() {
		t, _ := d.byte()
		nargs, err := d.byte()
		if err != nil {
			return nil, err
		}
		scope, err := d.byte()
		if err != nil {
			return nil, err
		}
		name, err := d.bytes()
		if err != nil {
			return nil, err
		}
		a := Action{Scope: Scope(scope), Name: string(name)}
		switch {
		case t == actionSetVar && nargs == 3:
			if a.Value, err = d.value(); err != nil {
				return nil, err
			}
		case t == actionUnsetVar && nargs == 2:
			a.Unset = true
		default:
			return nil, fmt.Errorf("spop: unknown action %d/%d", t, nargs)
		}
		out = append(out, a)
	}
	return out, nil
}
