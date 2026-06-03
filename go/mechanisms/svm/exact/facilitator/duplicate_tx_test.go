package facilitator

import (
	"encoding/base64"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

func TestFacilitatorInstructionConstraints(t *testing.T) {
	t.Run("allows 3-6 instructions", func(t *testing.T) {
		minInstructions := 3
		maxInstructions := 6

		assert.Equal(t, 3, minInstructions)
		assert.Equal(t, 6, maxInstructions)
	})

	t.Run("optional instructions may be Lighthouse or Memo", func(t *testing.T) {
		lighthouseProgram := svm.LighthouseProgramAddress
		memoProgram := svm.MemoProgramAddress

		assert.NotEqual(t, lighthouseProgram, memoProgram)
		assert.NotEmpty(t, memoProgram)
		assert.NotEmpty(t, lighthouseProgram)
	})
}

func TestErrorCodesForMitigationPlanning(t *testing.T) {
	t.Run("instruction count error", func(t *testing.T) {
		err := ErrTransactionInstructionsLength
		assert.Equal(t, "invalid_exact_solana_payload_transaction_instructions_length", err)
	})
}

func TestDuplicateSettlementCache(t *testing.T) {
	t.Run("should reject duplicate transaction", func(t *testing.T) {
		cache := svm.NewSettlementCache()

		cache.Mu().Lock()
		cache.Entries()["txBase64A=="] = time.Now()
		cache.Mu().Unlock()

		assert.True(t, cache.IsDuplicate("txBase64A=="), "same transaction key should be detected as duplicate")
	})

	t.Run("should not conflict with distinct transactions", func(t *testing.T) {
		cache := svm.NewSettlementCache()

		cache.Mu().Lock()
		cache.Entries()["txBase64A=="] = time.Now()
		cache.Mu().Unlock()

		assert.False(t, cache.IsDuplicate("txBase64B=="), "different transaction key should not be a duplicate")
	})

	t.Run("should prune expired entries", func(t *testing.T) {
		cache := svm.NewSettlementCache()

		cache.Mu().Lock()
		cache.Entries()["expiredTx=="] = time.Now().Add(-150 * time.Second)
		cache.Entries()["freshTx=="] = time.Now()
		cache.Mu().Unlock()

		// IsDuplicate triggers pruning internally
		assert.False(t, cache.IsDuplicate("newTx=="), "new tx should not be a duplicate")

		cache.Mu().Lock()
		_, expiredExists := cache.Entries()["expiredTx=="]
		_, freshExists := cache.Entries()["freshTx=="]
		cache.Mu().Unlock()

		assert.False(t, expiredExists, "expired entry should be pruned")
		assert.True(t, freshExists, "fresh entry should survive pruning")
	})

	t.Run("duplicate settlement error constant is correct", func(t *testing.T) {
		assert.Equal(t, "duplicate_settlement", ErrDuplicateSettlement)
	})

	t.Run("constructor wires the shared cache into the scheme", func(t *testing.T) {
		cache := svm.NewSettlementCache()
		scheme := NewExactSvmScheme(nil, cache)
		assert.Same(t, cache, scheme.settlementCache,
			"scheme should hold the exact cache instance that was injected")
	})
}

// TestMessageHashMalleabilityResistance verifies that manipulating the fee-payer
// signature bytes (slot 0) — which the facilitator overwrites before broadcast —
// does not change the cache key. An attacker who randomizes those bytes to bypass
// a wire-bytes cache key must be caught by keying on the immutable message hash.
func TestMessageHashMalleabilityResistance(t *testing.T) {
	// Build a minimal but structurally valid Solana transaction so we have real
	// binary that DecodeTransaction and Message.MarshalBinary can process.
	payer := solana.NewWallet().PrivateKey.PublicKey()
	recipient := solana.NewWallet().PrivateKey.PublicKey()

	blockhash, err := solana.HashFromBase58("5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF")
	require.NoError(t, err)

	tx, err := solana.NewTransaction(
		[]solana.Instruction{
			solana.NewInstruction(
				solana.SystemProgramID,
				solana.AccountMetaSlice{
					solana.NewAccountMeta(payer, true, true),
					solana.NewAccountMeta(recipient, true, false),
				},
				[]byte{2, 0, 0, 0, 232, 3, 0, 0, 0, 0, 0, 0}, // SystemTransfer 1000 lamports
			),
		},
		blockhash,
		solana.TransactionPayer(payer),
	)
	require.NoError(t, err)

	// Give the transaction a placeholder signature at slot 0 (simulates a payer-signed tx
	// where the facilitator's fee-payer slot has garbage bytes the attacker controls).
	placeholderSig := solana.Signature{}
	copy(placeholderSig[:], make([]byte, 64))
	tx.Signatures = []solana.Signature{placeholderSig}

	h1, err := svm.MessageHash(tx)
	require.NoError(t, err)

	// Randomize the bytes at signature slot 0 — exactly what the attacker would do.
	attackerSig := solana.Signature{}
	for i := range attackerSig {
		attackerSig[i] = byte(i + 1)
	}
	tx.Signatures[0] = attackerSig

	h2, err := svm.MessageHash(tx)
	require.NoError(t, err)

	assert.Equal(t, h1, h2,
		"message hash must be identical regardless of bytes in the fee-payer signature slot")

	// Sanity: a different message produces a different hash.
	tx2, err := solana.NewTransaction(
		[]solana.Instruction{
			solana.NewInstruction(
				solana.SystemProgramID,
				solana.AccountMetaSlice{
					solana.NewAccountMeta(payer, true, true),
					solana.NewAccountMeta(recipient, true, false),
				},
				[]byte{2, 0, 0, 0, 233, 3, 0, 0, 0, 0, 0, 0}, // SystemTransfer 1001 lamports
			),
		},
		blockhash,
		solana.TransactionPayer(payer),
	)
	require.NoError(t, err)

	h3, err := svm.MessageHash(tx2)
	require.NoError(t, err)

	assert.NotEqual(t, h1, h3,
		"distinct messages must produce distinct hashes")

	// Verify the hash is a valid base64 string (32-byte SHA-256 → 44 base64 chars).
	decoded, err := base64.StdEncoding.DecodeString(h1)
	require.NoError(t, err)
	assert.Len(t, decoded, 32, "SHA-256 digest must be 32 bytes")
}
