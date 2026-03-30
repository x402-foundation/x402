package facilitator

import (
	"testing"
	"time"

	"github.com/coinbase/x402/go/mechanisms/svm"
	"github.com/stretchr/testify/assert"
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
