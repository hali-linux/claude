// Package spop implements the agent side of HAProxy's Stream Processing
// Offload Protocol (SPOP v2.0), as documented in HAProxy's doc/SPOE.txt.
//
// HAProxy opens TCP connections to the agent, performs a HELLO handshake,
// then sends NOTIFY frames carrying "messages" (named lists of sampled
// values). The agent answers each NOTIFY with an ACK frame carrying
// "actions" (set-var / unset-var) that HAProxy applies to the stream.
package spop

import (
	"errors"
	"fmt"
	"net"
)

// Typed data identifiers (low 4 bits of the type byte).
const (
	TypeNull   = 0
	TypeBool   = 1
	TypeInt32  = 2
	TypeUint32 = 3
	TypeInt64  = 4
	TypeUint64 = 5
	TypeIPv4   = 6
	TypeIPv6   = 7
	TypeString = 8
	TypeBinary = 9

	typeMask  = 0x0F
	flagTrue  = 0x10
	maxVarint = 10 // bytes needed for any uint64 with this encoding
)

var (
	errShort   = errors.New("spop: truncated data")
	errVarint  = errors.New("spop: varint overflow")
	errBadType = errors.New("spop: unsupported data type")
)

// AppendVarint appends v using HAProxy's variable-length integer encoding
// (the "peers" encoding, not LEB128):
//
//	0   <= X < 240  : 1 byte
//	240 <= X < 2288 : 2 bytes, then 7 more bits per extra byte
func AppendVarint(b []byte, v uint64) []byte {
	if v < 240 {
		return append(b, byte(v))
	}
	b = append(b, byte(v)|0xF0)
	v = (v - 240) >> 4
	for v >= 128 {
		b = append(b, byte(v)|0x80)
		v = (v - 128) >> 7
	}
	return append(b, byte(v))
}

// ReadVarint decodes a varint from the start of b and returns the value and
// the number of bytes consumed.
func ReadVarint(b []byte) (uint64, int, error) {
	if len(b) == 0 {
		return 0, 0, errShort
	}
	v := uint64(b[0])
	if v < 240 {
		return v, 1, nil
	}
	shift := uint(4)
	for i := 1; ; i++ {
		if i >= len(b) {
			return 0, 0, errShort
		}
		if i >= maxVarint {
			return 0, 0, errVarint
		}
		c := b[i]
		v += uint64(c) << shift
		shift += 7
		if c < 128 {
			return v, i + 1, nil
		}
	}
}

// decoder walks a frame payload.
type decoder struct {
	b   []byte
	off int
}

func (d *decoder) empty() bool { return d.off >= len(d.b) }

func (d *decoder) byte() (byte, error) {
	if d.off >= len(d.b) {
		return 0, errShort
	}
	c := d.b[d.off]
	d.off++
	return c, nil
}

func (d *decoder) varint() (uint64, error) {
	v, n, err := ReadVarint(d.b[d.off:])
	if err != nil {
		return 0, err
	}
	d.off += n
	return v, nil
}

func (d *decoder) next(n uint64) ([]byte, error) {
	if n > uint64(len(d.b)-d.off) {
		return nil, errShort
	}
	s := d.b[d.off : d.off+int(n)]
	d.off += int(n)
	return s, nil
}

// bytes reads a length-prefixed byte string (used for names, which carry no
// type byte, and for STRING/BINARY payloads).
func (d *decoder) bytes() ([]byte, error) {
	n, err := d.varint()
	if err != nil {
		return nil, err
	}
	return d.next(n)
}

// value reads one TYPED-DATA item. Decoded Go types:
//
//	NULL → nil, BOOL → bool, INT32/INT64 → int64, UINT32/UINT64 → uint64,
//	IPV4/IPV6 → net.IP, STRING → string, BINARY → []byte (aliases the frame).
func (d *decoder) value() (any, error) {
	t, err := d.byte()
	if err != nil {
		return nil, err
	}
	switch t & typeMask {
	case TypeNull:
		return nil, nil
	case TypeBool:
		return t&flagTrue != 0, nil
	case TypeInt32, TypeInt64:
		v, err := d.varint()
		return int64(v), err
	case TypeUint32, TypeUint64:
		return d.varint()
	case TypeIPv4:
		b, err := d.next(4)
		if err != nil {
			return nil, err
		}
		return net.IP(append([]byte(nil), b...)), nil
	case TypeIPv6:
		b, err := d.next(16)
		if err != nil {
			return nil, err
		}
		return net.IP(append([]byte(nil), b...)), nil
	case TypeString:
		b, err := d.bytes()
		return string(b), err
	case TypeBinary:
		return d.bytes()
	default:
		return nil, fmt.Errorf("%w: %d", errBadType, t&typeMask)
	}
}

// AppendValue appends v as TYPED-DATA.
func AppendValue(b []byte, v any) ([]byte, error) {
	switch x := v.(type) {
	case nil:
		return append(b, TypeNull), nil
	case bool:
		if x {
			return append(b, TypeBool|flagTrue), nil
		}
		return append(b, TypeBool), nil
	case int:
		return AppendVarint(append(b, TypeInt64), uint64(int64(x))), nil
	case int64:
		return AppendVarint(append(b, TypeInt64), uint64(x)), nil
	case uint32:
		return AppendVarint(append(b, TypeUint32), uint64(x)), nil
	case uint64:
		return AppendVarint(append(b, TypeUint64), x), nil
	case net.IP:
		if v4 := x.To4(); v4 != nil {
			return append(append(b, TypeIPv4), v4...), nil
		}
		if len(x) == net.IPv6len {
			return append(append(b, TypeIPv6), x...), nil
		}
		return nil, fmt.Errorf("%w: invalid IP", errBadType)
	case string:
		b = AppendVarint(append(b, TypeString), uint64(len(x)))
		return append(b, x...), nil
	case []byte:
		b = AppendVarint(append(b, TypeBinary), uint64(len(x)))
		return append(b, x...), nil
	default:
		return nil, fmt.Errorf("%w: %T", errBadType, v)
	}
}

func appendName(b []byte, s string) []byte {
	return append(AppendVarint(b, uint64(len(s))), s...)
}

// KV is one item of a KV-LIST.
type KV struct {
	Name  string
	Value any
}

func decodeKVList(d *decoder) ([]KV, error) {
	var out []KV
	for !d.empty() {
		name, err := d.bytes()
		if err != nil {
			return nil, err
		}
		v, err := d.value()
		if err != nil {
			return nil, err
		}
		out = append(out, KV{Name: string(name), Value: v})
	}
	return out, nil
}

func appendKVList(b []byte, kvs []KV) ([]byte, error) {
	var err error
	for _, kv := range kvs {
		b = appendName(b, kv.Name)
		if b, err = AppendValue(b, kv.Value); err != nil {
			return nil, err
		}
	}
	return b, nil
}
