package masumi

import (
	"encoding/binary"
	"errors"
	"math"
	"math/big"
	"unicode/utf8"
)

// A minimal order-preserving CBOR codec for COSE objects. It mirrors the
// TypeScript SDK's decoder (integers and bignum tags as integers, map entries
// in first-seen order with a repeated primitive key overwriting the earlier
// value) and its CML default encoder (definite lengths, minimal heads), which
// together determine the bytes a COSE Sig_structure is verified over.

type cborKind int

const (
	cborInt cborKind = iota
	cborBytes
	cborText
	cborArray
	cborMap
	cborTag
	cborBool
	cborNull
	cborUndefined
	cborFloat
)

type cborNode struct {
	kind  cborKind
	num   *big.Int
	bytes []byte
	text  string
	items []*cborNode
	keys  []*cborNode
	tag   uint64
	flag  bool
	float float64
}

const maxCBORDepth = 64

var errCBOR = errors.New("invalid CBOR")

func decodeCBOR(b []byte) (*cborNode, error) {
	if len(b) == 0 {
		return nil, errCBOR
	}
	node, n, err := decodeCBORAt(b, 0, 0)
	if err != nil {
		return nil, err
	}
	if n != len(b) {
		return nil, errors.New("trailing CBOR bytes")
	}
	return node, nil
}

func readHead(b []byte, off int) (major byte, info byte, arg uint64, next int, err error) {
	if off >= len(b) {
		return 0, 0, 0, 0, errCBOR
	}
	major, info = b[off]>>5, b[off]&0x1f
	off++
	switch {
	case info < 24:
		return major, info, uint64(info), off, nil
	case info == 24:
		if off+1 > len(b) {
			return 0, 0, 0, 0, errCBOR
		}
		return major, info, uint64(b[off]), off + 1, nil
	case info == 25:
		if off+2 > len(b) {
			return 0, 0, 0, 0, errCBOR
		}
		return major, info, uint64(binary.BigEndian.Uint16(b[off:])), off + 2, nil
	case info == 26:
		if off+4 > len(b) {
			return 0, 0, 0, 0, errCBOR
		}
		return major, info, uint64(binary.BigEndian.Uint32(b[off:])), off + 4, nil
	case info == 27:
		if off+8 > len(b) {
			return 0, 0, 0, 0, errCBOR
		}
		return major, info, binary.BigEndian.Uint64(b[off:]), off + 8, nil
	case info == 31:
		return major, info, 0, off, nil
	}
	return 0, 0, 0, 0, errCBOR
}

func decodeCBORAt(b []byte, off, depth int) (*cborNode, int, error) {
	if depth > maxCBORDepth {
		return nil, 0, errCBOR
	}
	major, info, arg, next, err := readHead(b, off)
	if err != nil {
		return nil, 0, err
	}
	indefinite := info == 31
	switch major {
	case 0, 1:
		if indefinite {
			return nil, 0, errCBOR
		}
		n := new(big.Int).SetUint64(arg)
		if major == 1 {
			n.Neg(n).Sub(n, big.NewInt(1))
		}
		return &cborNode{kind: cborInt, num: n}, next, nil
	case 2, 3:
		var content []byte
		if indefinite {
			for {
				if next >= len(b) {
					return nil, 0, errCBOR
				}
				if b[next] == 0xff {
					next++
					break
				}
				cm, ci, clen, cnext, err := readHead(b, next)
				if err != nil || cm != major || ci == 31 || clen > uint64(len(b)-cnext) {
					return nil, 0, errCBOR
				}
				content = append(content, b[cnext:cnext+int(clen)]...)
				next = cnext + int(clen)
			}
		} else {
			if arg > uint64(len(b)-next) {
				return nil, 0, errCBOR
			}
			content = append([]byte{}, b[next:next+int(arg)]...)
			next += int(arg)
		}
		if major == 2 {
			return &cborNode{kind: cborBytes, bytes: content}, next, nil
		}
		if !utf8.Valid(content) {
			return nil, 0, errCBOR
		}
		return &cborNode{kind: cborText, text: string(content)}, next, nil
	case 4:
		node := &cborNode{kind: cborArray}
		for i := uint64(0); indefinite || i < arg; i++ {
			if indefinite {
				if next >= len(b) {
					return nil, 0, errCBOR
				}
				if b[next] == 0xff {
					next++
					break
				}
			}
			item, n, err := decodeCBORAt(b, next, depth+1)
			if err != nil {
				return nil, 0, err
			}
			node.items = append(node.items, item)
			next = n
		}
		return node, next, nil
	case 5:
		node := &cborNode{kind: cborMap}
		for i := uint64(0); indefinite || i < arg; i++ {
			if indefinite {
				if next >= len(b) {
					return nil, 0, errCBOR
				}
				if b[next] == 0xff {
					next++
					break
				}
			}
			key, n, err := decodeCBORAt(b, next, depth+1)
			if err != nil {
				return nil, 0, err
			}
			value, n, err := decodeCBORAt(b, n, depth+1)
			if err != nil {
				return nil, 0, err
			}
			next = n
			node.setEntry(key, value)
		}
		return node, next, nil
	case 6:
		if info > 25 {
			return nil, 0, errCBOR
		}
		inner, n, err := decodeCBORAt(b, next, depth+1)
		if err != nil {
			return nil, 0, err
		}
		if arg == 2 || arg == 3 {
			if inner.kind != cborBytes {
				return nil, 0, errCBOR
			}
			v := new(big.Int).SetBytes(inner.bytes)
			if arg == 3 {
				v.Neg(v).Sub(v, big.NewInt(1))
			}
			return &cborNode{kind: cborInt, num: v}, n, nil
		}
		return &cborNode{kind: cborTag, tag: arg, items: []*cborNode{inner}}, n, nil
	case 7:
		switch info {
		case 20, 21:
			return &cborNode{kind: cborBool, flag: info == 21}, next, nil
		case 22:
			return &cborNode{kind: cborNull}, next, nil
		case 23:
			return &cborNode{kind: cborUndefined}, next, nil
		case 25:
			return &cborNode{kind: cborFloat, float: halfToFloat(uint16(arg))}, next, nil
		case 26:
			return &cborNode{kind: cborFloat, float: float64(math.Float32frombits(uint32(arg)))}, next, nil
		case 27:
			return &cborNode{kind: cborFloat, float: math.Float64frombits(arg)}, next, nil
		}
	}
	return nil, 0, errCBOR
}

func halfToFloat(h uint16) float64 {
	exp := int(h>>10) & 0x1f
	mant := float64(h & 0x3ff)
	var v float64
	switch exp {
	case 0:
		v = math.Ldexp(mant, -24)
	case 31:
		if mant == 0 {
			v = math.Inf(1)
		} else {
			v = math.NaN()
		}
	default:
		v = math.Ldexp(mant+1024, exp-25)
	}
	if h&0x8000 != 0 {
		return -v
	}
	return v
}

// sameKey is JavaScript Map key equality (SameValueZero) for decoded items.
func sameKey(a, b *cborNode) bool {
	if a.kind != b.kind {
		return false
	}
	switch a.kind {
	case cborInt:
		return a.num.Cmp(b.num) == 0
	case cborText:
		return a.text == b.text
	case cborFloat:
		return a.float == b.float || (math.IsNaN(a.float) && math.IsNaN(b.float))
	case cborBool:
		return a.flag == b.flag
	case cborNull, cborUndefined:
		return true
	}
	return false
}

func (m *cborNode) setEntry(key, value *cborNode) {
	for i, k := range m.keys {
		if sameKey(k, key) {
			m.items[i] = value
			return
		}
	}
	m.keys = append(m.keys, key)
	m.items = append(m.items, value)
}

func (m *cborNode) get(key *cborNode) *cborNode {
	for i, k := range m.keys {
		if sameKey(k, key) {
			return m.items[i]
		}
	}
	return nil
}

func intKey(v int64) *cborNode   { return &cborNode{kind: cborInt, num: big.NewInt(v)} }
func textKey(s string) *cborNode { return &cborNode{kind: cborText, text: s} }

func (n *cborNode) isInt(v int64) bool {
	return n != nil && n.kind == cborInt && n.num.IsInt64() && n.num.Int64() == v
}

func appendHead(out []byte, major byte, arg uint64) []byte {
	m := major << 5
	switch {
	case arg < 24:
		return append(out, m|byte(arg))
	case arg <= math.MaxUint8:
		return append(out, m|24, byte(arg))
	case arg <= math.MaxUint16:
		return binary.BigEndian.AppendUint16(append(out, m|25), uint16(arg))
	case arg <= math.MaxUint32:
		return binary.BigEndian.AppendUint32(append(out, m|26), uint32(arg))
	}
	return binary.BigEndian.AppendUint64(append(out, m|27), arg)
}

// encodeCBOR encodes a decoded tree with definite lengths and minimal heads.
func encodeCBOR(out []byte, n *cborNode) ([]byte, error) {
	switch n.kind {
	case cborInt:
		if n.num.Sign() >= 0 {
			if n.num.IsUint64() {
				return appendHead(out, 0, n.num.Uint64()), nil
			}
			out = appendHead(out, 6, 2)
			out = appendHead(out, 2, uint64(len(n.num.Bytes())))
			return append(out, n.num.Bytes()...), nil
		}
		abs := new(big.Int).Neg(n.num)
		abs.Sub(abs, big.NewInt(1))
		if abs.IsUint64() {
			return appendHead(out, 1, abs.Uint64()), nil
		}
		out = appendHead(out, 6, 3)
		out = appendHead(out, 2, uint64(len(abs.Bytes())))
		return append(out, abs.Bytes()...), nil
	case cborBytes:
		return append(appendHead(out, 2, uint64(len(n.bytes))), n.bytes...), nil
	case cborText:
		return append(appendHead(out, 3, uint64(len(n.text))), n.text...), nil
	case cborArray:
		out = appendHead(out, 4, uint64(len(n.items)))
		for _, item := range n.items {
			var err error
			if out, err = encodeCBOR(out, item); err != nil {
				return nil, err
			}
		}
		return out, nil
	case cborMap:
		out = appendHead(out, 5, uint64(len(n.keys)))
		for i := range n.keys {
			var err error
			if out, err = encodeCBOR(out, n.keys[i]); err != nil {
				return nil, err
			}
			if out, err = encodeCBOR(out, n.items[i]); err != nil {
				return nil, err
			}
		}
		return out, nil
	case cborTag:
		return encodeCBOR(appendHead(out, 6, n.tag), n.items[0])
	case cborBool:
		if n.flag {
			return append(out, 0xf5), nil
		}
		return append(out, 0xf4), nil
	case cborNull:
		return append(out, 0xf6), nil
	case cborUndefined:
		return append(out, 0xf7), nil
	}
	return nil, errors.New("cannot re-encode a CBOR float")
}

func bytesNode(b []byte) *cborNode { return &cborNode{kind: cborBytes, bytes: b} }

func encodeArray(items ...*cborNode) []byte {
	out, _ := encodeCBOR(nil, &cborNode{kind: cborArray, items: items})
	return out
}
