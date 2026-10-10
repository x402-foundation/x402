package script

import (
	"math/big"
	"testing"

	"github.com/blinklabs-io/plutigo/data"
	"github.com/fxamacker/cbor/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFlatConstantTypes(t *testing.T) {
	w := &flatWriter{}
	for i := 0; i < 3; i++ {
		w.bits(1, 8)
	}
	// A program whose body is a constr holding constants of every type.
	constant := func(tags []uint64, value func()) {
		w.bits(4, 4)
		for _, tag := range tags {
			w.bits(1, 1)
			w.bits(tag, 4)
		}
		w.bits(0, 1)
		value()
	}
	w.bits(8, 4)
	w.bits(0, 8) // constr tag 0
	field := func(f func()) { w.bits(1, 1); f() }
	field(func() { constant([]uint64{0}, func() { w.bits(0x0a, 8) }) })
	field(func() { constant([]uint64{1}, func() { w.byteString([]byte{1, 2}) }) })
	field(func() { constant([]uint64{2}, func() { w.byteString([]byte("hi")) }) })
	field(func() { constant([]uint64{3}, func() {}) })
	field(func() { constant([]uint64{4}, func() { w.bits(1, 1) }) })
	field(func() { constant([]uint64{8}, func() { w.byteString([]byte{0x01}) }) })
	field(func() {
		constant([]uint64{7, 5, 0}, func() { w.bits(1, 1); w.bits(1, 8); w.bits(0, 1) })
	})
	field(func() {
		constant([]uint64{7, 7, 6, 0, 4}, func() { w.bits(2, 8); w.bits(0, 1) })
	})
	field(func() {
		w.bits(9, 4)
		w.bits(0, 4)
		w.bits(0, 8)
		w.bits(1, 1)
		w.bits(6, 4)
		w.bits(0, 1)
	}) // case (var 0) [error]
	field(func() { w.bits(5, 4); w.bits(1, 4); w.bits(7, 4); w.bits(3, 7) }) // force(delay(builtin 3))
	field(func() {
		w.bits(2, 4)
		w.bits(3, 4)
		w.bits(0, 4)
		w.bits(0x81, 8)
		w.bits(0x01, 8)
		w.bits(0, 4)
		w.bits(0, 8)
	})
	w.bits(0, 1)
	w.filler()
	prog, _ := encodeFlatForTest(w.out)
	applied, err := ApplyParams(prog, []data.PlutusData{data.NewInteger(big.NewInt(1))})
	require.NoError(t, err)
	assert.NotEmpty(t, applied)

	bad := &flatWriter{}
	for i := 0; i < 3; i++ {
		bad.bits(1, 8)
	}
	bad.bits(4, 4)
	bad.bits(1, 1)
	bad.bits(12, 4)
	bad.bits(0, 1)
	bad.filler()
	prog, _ = encodeFlatForTest(bad.out)
	_, err = ApplyParams(prog, nil)
	assert.Error(t, err)
	for _, tags := range [][]uint64{{7}, {7, 5}, {7, 7, 1}, {7, 9}} {
		i := 0
		_, err := parseFlatType(tags, &i)
		assert.Error(t, err, tags)
	}
}

func encodeFlatForTest(flat []byte) ([]byte, error) {
	return cbor.Marshal(flat)
}
