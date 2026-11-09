package svm

import (
	"encoding/binary"
	"encoding/json"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNormalizeSimulatedInnerInstructions_ParsedTransferChecked(t *testing.T) {
	program := solana.TokenProgramID
	source := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	dest := solana.NewWallet().PublicKey()
	authority := solana.NewWallet().PublicKey()
	keys := solana.PublicKeySlice{source, mint, dest, authority, program}

	raw := []byte(`[{
		"index": 2,
		"instructions": [{
			"parsed": {
				"info": {
					"authority": "` + authority.String() + `",
					"destination": "` + dest.String() + `",
					"mint": "` + mint.String() + `",
					"source": "` + source.String() + `",
					"tokenAmount": {"amount": "1000", "decimals": 6}
				},
				"type": "transferChecked"
			},
			"program": "spl-token",
			"programId": "` + program.String() + `",
			"stackHeight": 2
		}]
	}]`)

	var groups []simulateInnerGroup
	require.NoError(t, json.Unmarshal(raw, &groups))

	normalized := normalizeSimulatedInnerInstructions(groups, keys)
	require.Len(t, normalized, 1)
	require.Len(t, normalized[0].Instructions, 1)

	ix := normalized[0].Instructions[0]
	assert.Equal(t, uint16(4), ix.ProgramIDIndex)
	require.Len(t, ix.Accounts, 4)
	assert.Equal(t, []uint16{0, 1, 2, 3}, ix.Accounts)
	require.GreaterOrEqual(t, len(ix.Data), 9)
	assert.Equal(t, byte(ixTokenTransferChecked), ix.Data[0])
	assert.Equal(t, uint64(1000), binary.LittleEndian.Uint64(ix.Data[1:9]))
}

func TestNormalizeSimulatedInnerInstructions_CompiledPassthrough(t *testing.T) {
	data := make([]byte, 9)
	data[0] = ixTokenTransferChecked
	binary.LittleEndian.PutUint64(data[1:], 500)

	groups := []simulateInnerGroup{{
		Index: 1,
		Instructions: []simulateInnerIx{{
			ProgramIDIndex: 5,
			Accounts:       []uint16{1, 2, 3, 4},
			Data:           solana.Base58(data),
		}},
	}}

	normalized := normalizeSimulatedInnerInstructions(groups, nil)
	require.Len(t, normalized, 1)
	require.Len(t, normalized[0].Instructions, 1)
	assert.Equal(t, uint16(5), normalized[0].Instructions[0].ProgramIDIndex)
	assert.Equal(t, []uint16{1, 2, 3, 4}, normalized[0].Instructions[0].Accounts)
	assert.Equal(t, solana.Base58(data), normalized[0].Instructions[0].Data)
}
