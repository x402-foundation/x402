package script

import (
	"errors"

	"github.com/blinklabs-io/plutigo/data"

	"github.com/fxamacker/cbor/v2"
)

// Plutus parameter application performed directly on the flat bit stream.
// Every term is copied bit for bit; only the byte-alignment fillers in front
// of bytestring payloads are re-emitted for their new position. This keeps
// the validator byte-identical to what Aiken and the TypeScript SDK produce,
// which a decode/re-encode round trip through a UPLC AST does not guarantee.

var errFlat = errors.New("malformed flat UPLC program")

const maxFlatDepth = 4096

type flatReader struct {
	b   []byte
	pos int
}

func (r *flatReader) bit() (uint8, error) {
	if r.pos >= len(r.b)*8 {
		return 0, errFlat
	}
	v := (r.b[r.pos/8] >> (7 - uint(r.pos%8))) & 1
	r.pos++
	return v, nil
}

type flatWriter struct {
	out []byte
	pos int
}

func (w *flatWriter) bit(v uint8) {
	if w.pos%8 == 0 {
		w.out = append(w.out, 0)
	}
	if v != 0 {
		w.out[len(w.out)-1] |= 1 << (7 - uint(w.pos%8))
	}
	w.pos++
}

func (w *flatWriter) bits(value uint64, n int) {
	for i := n - 1; i >= 0; i-- {
		w.bit(uint8(value>>uint(i)) & 1)
	}
}

func (w *flatWriter) filler() {
	for w.pos%8 != 7 {
		w.bit(0)
	}
	w.bit(1)
}

func (w *flatWriter) byteString(b []byte) {
	w.filler()
	for len(b) > 0 {
		n := min(len(b), 255)
		w.bits(uint64(n), 8)
		for _, c := range b[:n] {
			w.bits(uint64(c), 8)
		}
		b = b[n:]
	}
	w.bits(0, 8)
}

type flatCopier struct {
	r *flatReader
	w *flatWriter
}

func (c *flatCopier) copyBits(n int) (uint64, error) {
	var v uint64
	for i := 0; i < n; i++ {
		b, err := c.r.bit()
		if err != nil {
			return 0, err
		}
		c.w.bit(b)
		v = v<<1 | uint64(b)
	}
	return v, nil
}

func (c *flatCopier) natural() error {
	for {
		more, err := c.copyBits(1)
		if err != nil {
			return err
		}
		if _, err := c.copyBits(7); err != nil {
			return err
		}
		if more == 0 {
			return nil
		}
	}
}

// byteString re-aligns a filler-prefixed chunked bytestring.
func (c *flatCopier) byteString() error {
	for {
		b, err := c.r.bit()
		if err != nil {
			return err
		}
		if b == 1 {
			break
		}
	}
	if c.r.pos%8 != 0 {
		return errFlat
	}
	c.w.filler()
	for {
		n, err := c.copyBits(8)
		if err != nil {
			return err
		}
		if n == 0 {
			return nil
		}
		if _, err := c.copyBits(8 * int(n)); err != nil {
			return err
		}
	}
}

// UPLC constant type tags; list and pair are applications of typeApply.
const (
	typeInteger    = 0
	typeByteString = 1
	typeString     = 2
	typeUnit       = 3
	typeBool       = 4
	typeList       = 5
	typePair       = 6
	typeApply      = 7
	typeData       = 8
)

type flatType struct {
	tag   uint64
	elems []flatType
}

func parseFlatType(tags []uint64, i *int) (flatType, error) {
	if *i >= len(tags) {
		return flatType{}, errFlat
	}
	tag := tags[*i]
	*i++
	switch tag {
	case typeInteger, typeByteString, typeString, typeUnit, typeBool, typeData:
		return flatType{tag: tag}, nil
	case typeApply:
		if *i >= len(tags) {
			return flatType{}, errFlat
		}
		sub := tags[*i]
		*i++
		switch sub {
		case typeList:
			elem, err := parseFlatType(tags, i)
			return flatType{tag: typeList, elems: []flatType{elem}}, err
		case typeApply:
			if *i >= len(tags) || tags[*i] != typePair {
				return flatType{}, errFlat
			}
			*i++
			a, err := parseFlatType(tags, i)
			if err != nil {
				return flatType{}, err
			}
			b, err := parseFlatType(tags, i)
			return flatType{tag: typePair, elems: []flatType{a, b}}, err
		}
	}
	return flatType{}, errFlat
}

func (c *flatCopier) value(t flatType, depth int) error {
	if depth > maxFlatDepth {
		return errFlat
	}
	switch t.tag {
	case typeInteger:
		return c.natural()
	case typeByteString, typeString, typeData:
		return c.byteString()
	case typeUnit:
		return nil
	case typeBool:
		_, err := c.copyBits(1)
		return err
	case typeList:
		for {
			more, err := c.copyBits(1)
			if err != nil || more == 0 {
				return err
			}
			if err := c.value(t.elems[0], depth+1); err != nil {
				return err
			}
		}
	case typePair:
		if err := c.value(t.elems[0], depth+1); err != nil {
			return err
		}
		return c.value(t.elems[1], depth+1)
	}
	return errFlat
}

func (c *flatCopier) termList(depth int) error {
	for {
		more, err := c.copyBits(1)
		if err != nil || more == 0 {
			return err
		}
		if err := c.term(depth + 1); err != nil {
			return err
		}
	}
}

func (c *flatCopier) term(depth int) error {
	if depth > maxFlatDepth {
		return errFlat
	}
	tag, err := c.copyBits(4)
	if err != nil {
		return err
	}
	switch tag {
	case 0: // var
		return c.natural()
	case 1, 2, 5: // delay, lambda, force
		return c.term(depth + 1)
	case 3: // apply
		if err := c.term(depth + 1); err != nil {
			return err
		}
		return c.term(depth + 1)
	case 4: // constant
		var tags []uint64
		for {
			more, err := c.copyBits(1)
			if err != nil {
				return err
			}
			if more == 0 {
				break
			}
			t, err := c.copyBits(4)
			if err != nil {
				return err
			}
			tags = append(tags, t)
		}
		i := 0
		t, err := parseFlatType(tags, &i)
		if err != nil || i != len(tags) {
			return errFlat
		}
		return c.value(t, depth)
	case 6: // error
		return nil
	case 7: // builtin
		_, err := c.copyBits(7)
		return err
	case 8: // constr
		if err := c.natural(); err != nil {
			return err
		}
		return c.termList(depth)
	case 9: // case
		if err := c.term(depth + 1); err != nil {
			return err
		}
		return c.termList(depth)
	}
	return errFlat
}

// ApplyParams applies Plutus data parameters to a flat program given with
// zero, one or two CBOR byte-string wrappers and returns the single-wrapped
// applied script, byte-identical to Aiken's apply_params and the TypeScript
// SDK. Terms are copied bit for bit; only bytestring fillers are re-aligned.
func ApplyParams(code []byte, params []data.PlutusData) ([]byte, error) {
	encoded := make([][]byte, len(params))
	for i, p := range params {
		b, err := data.Encode(p)
		if err != nil {
			return nil, err
		}
		encoded[i] = b
	}
	return applyDataParams(code, encoded)
}

func applyDataParams(code []byte, params [][]byte) ([]byte, error) {
	flat := code
	for i := 0; i < 2; i++ {
		var inner []byte
		if len(flat) == 0 || flat[0]>>5 != 2 {
			break
		}
		if err := cbor.Unmarshal(flat, &inner); err != nil {
			break
		}
		flat = inner
	}
	c := &flatCopier{r: &flatReader{b: flat}, w: &flatWriter{}}
	for i := 0; i < 3; i++ {
		if err := c.natural(); err != nil {
			return nil, err
		}
	}
	for range params {
		c.w.bits(3, 4)
	}
	if err := c.term(0); err != nil {
		return nil, err
	}
	for _, p := range params {
		c.w.bits(4, 4) // constant
		c.w.bits(1, 1) // type list cons
		c.w.bits(8, 4) // data
		c.w.bits(0, 1) // type list end
		c.w.byteString(p)
	}
	c.w.filler()
	return cbor.Marshal(c.w.out)
}
