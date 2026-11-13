package script

import (
	"math/big"
	"testing"

	"github.com/blinklabs-io/plutigo/data"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestApplyParamsRejectsMalformedPrograms(t *testing.T) {
	for _, code := range [][]byte{nil, {0x01}, {0x43, 0x01, 0x00, 0x00}} {
		_, err := ApplyParams(code, []data.PlutusData{data.NewInteger(big.NewInt(1))})
		assert.Error(t, err, code)
	}
	_, err := ApplyParams([]byte{0x4d, 0x01, 0x00, 0x00, 0x33, 0x22, 0x22, 0x20, 0x05, 0x12, 0x00, 0x12, 0x00, 0x11}, []data.PlutusData{nil})
	require.Error(t, err)
}
