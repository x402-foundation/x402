package paymentchannels

import (
	"encoding/binary"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
)

func tokenAccountFixture(mint, owner solana.PublicKey, state byte, extensions []byte) []byte {
	data := make([]byte, TokenAccountLen, TokenAccountLen+len(extensions))
	copy(data[0:32], mint[:])
	copy(data[32:64], owner[:])
	binary.LittleEndian.PutUint64(data[64:72], 7)
	data[108] = state
	return append(data, extensions...)
}

func TestUnusableSettlementAccount(t *testing.T) {
	mint := solana.NewWallet().PublicKey()
	owner := solana.NewWallet().PublicKey()
	program := solana.TokenProgramID
	check := func(state byte, extensions []byte) string {
		return UnusableSettlementAccount(program, tokenAccountFixture(mint, owner, state, extensions), owner, mint, program)
	}

	assert.Equal(t, "", check(1, nil))
	// ImmutableOwner (7, empty) followed by zero padding is allowed.
	assert.Equal(t, "", check(1, []byte{2, 7, 0, 0, 0, 0, 0, 0, 0}))
	assert.Equal(t, "is frozen", check(2, nil))
	assert.Equal(t, "is in account state 0", check(0, nil))
	assert.Equal(t, "carries token account extension 1", check(1, []byte{1}))
	assert.Equal(t, "carries token account extension 9", check(1, []byte{2, 9, 0, 0, 0}))
	assert.Equal(t, "carries token account extension 65535", check(1, []byte{2, 7, 0}))
	assert.Equal(t, "carries token account extension 65535", check(1, []byte{2, 7, 0, 9, 0}))
	assert.Contains(t, UnusableSettlementAccount(solana.Token2022ProgramID, tokenAccountFixture(mint, owner, 1, nil), owner, mint, program), "is not owned by")
	assert.Equal(t, "is not an initialized token account", UnusableSettlementAccount(program, nil, owner, mint, program))
	assert.Contains(t, UnusableSettlementAccount(program, tokenAccountFixture(owner, owner, 1, nil), owner, mint, program), "holds mint")
	assert.Contains(t, UnusableSettlementAccount(program, tokenAccountFixture(mint, mint, 1, nil), owner, mint, program), "is owned by")

	decoded, ok := DecodeTokenAccount(tokenAccountFixture(mint, owner, 1, nil))
	assert.True(t, ok)
	assert.Equal(t, uint64(7), decoded.Amount)
}
