package facilitator

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// plainPermit2Payload builds a Permit2 payment payload + requirements with no
// extensions, so pending-settlement tests exercise the base broadcast path
// (not the ERC-20-approval-gas-sponsoring branch covered separately by
// newPermit2ERC20Fixture).
func plainPermit2Payload() (types.PaymentPayload, types.PaymentRequirements, *evm.ExactPermit2Payload) {
	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:84532",
		Amount:  "1000000",
		Asset:   testToken,
		PayTo:   testPayTo,
	}
	permit2Payload := &evm.ExactPermit2Payload{
		Signature: "0x" + strings.Repeat("11", 65),
		Permit2Authorization: evm.Permit2Authorization{
			From: testPayer,
			Permitted: evm.Permit2TokenPermissions{
				Token:  testToken,
				Amount: "1000000",
			},
			Spender:  evm.X402ExactPermit2ProxyAddress,
			Nonce:    "1",
			Deadline: fmt.Sprintf("%d", time.Now().Unix()+10000),
			Witness: evm.Permit2Witness{
				To:         testPayTo,
				ValidAfter: "0",
			},
		},
	}
	payload := types.PaymentPayload{X402Version: 2, Payload: permit2Payload.ToMap(), Accepted: requirements}
	return payload, requirements, permit2Payload
}

// Exercises the PendingSettlementStore fast path wired into settleEIP3009 and
// SettlePermit2 (see eip3009.go/permit2.go): a settle attempt whose receipt
// wait fails must populate the store keyed by the payload signature; a
// subsequent settle for the identical payload must hit that entry, skip
// verify/broadcast entirely, and reconcile against the already-broadcast
// transaction. Mirrors the TS/Python pendingSettlement test suites.

func TestSettleEIP3009_PendingSettlementStore_CacheMissSuccessLeavesNoEntry(t *testing.T) {
	payload, requirements := plainEIP3009Payload(t)
	signer := deployedCodeSigner(nil)
	scheme := NewExactEvmScheme(signer, &ExactEvmSchemeConfig{})
	store := x402.NewInMemoryPendingSettlementStore()
	scheme.SetPendingSettlementStore(store)

	evmPayload := payload.Payload["signature"]

	resp, err := scheme.Settle(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)

	_, ok, _ := store.Get(context.Background(), evmPayload.(string))
	assert.False(t, ok, "successful settlement must not leave a pending entry")
}

func TestSettleEIP3009_PendingSettlementStore_CacheMissReceiptFailurePopulatesStore(t *testing.T) {
	payload, requirements := plainEIP3009Payload(t)
	signer := deployedCodeSigner(fmt.Errorf("rpc: timeout waiting for receipt"))
	scheme := NewExactEvmScheme(signer, &ExactEvmSchemeConfig{})
	store := x402.NewInMemoryPendingSettlementStore()
	scheme.SetPendingSettlementStore(store)
	signature := payload.Payload["signature"].(string)

	_, err := scheme.Settle(context.Background(), payload, requirements, nil)
	wantTxHash := "0x" + strings.Repeat("ab", 32)
	assertSettlementPending(t, err, wantTxHash)

	txHash, ok, _ := store.Get(context.Background(), signature)
	assert.True(t, ok, "receipt-wait failure must populate the pending-settlement store")
	assert.Equal(t, wantTxHash, txHash)
}

func TestSettleEIP3009_PendingSettlementStore_CacheHitReconcilesWithoutRebroadcast(t *testing.T) {
	payload, requirements := plainEIP3009Payload(t)
	signer := deployedCodeSigner(nil) // receipt wait now succeeds
	scheme := NewExactEvmScheme(signer, &ExactEvmSchemeConfig{})
	store := x402.NewInMemoryPendingSettlementStore()
	scheme.SetPendingSettlementStore(store)
	signature := payload.Payload["signature"].(string)
	priorTxHash := "0x" + strings.Repeat("ab", 32)
	require.NoError(t, store.Set(context.Background(), signature, priorTxHash))

	resp, err := scheme.Settle(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, priorTxHash, resp.Transaction)
	assert.Equal(t, 0, signer.writeCalls, "reconciliation fast path must never re-broadcast")

	_, ok, _ := store.Get(context.Background(), signature)
	assert.False(t, ok, "successful reconciliation must clear the pending entry")
}

func TestSettleEIP3009_PendingSettlementStore_CacheHitStillPendingReturnsAgainWithoutRebroadcast(t *testing.T) {
	payload, requirements := plainEIP3009Payload(t)
	signer := deployedCodeSigner(fmt.Errorf("rpc: still pending"))
	scheme := NewExactEvmScheme(signer, &ExactEvmSchemeConfig{})
	store := x402.NewInMemoryPendingSettlementStore()
	scheme.SetPendingSettlementStore(store)
	signature := payload.Payload["signature"].(string)
	priorTxHash := "0x" + strings.Repeat("ab", 32)
	require.NoError(t, store.Set(context.Background(), signature, priorTxHash))

	_, err := scheme.Settle(context.Background(), payload, requirements, nil)
	assertSettlementPending(t, err, priorTxHash)
	assert.Equal(t, 0, signer.writeCalls, "reconciliation fast path must never re-broadcast")

	txHash, ok, _ := store.Get(context.Background(), signature)
	assert.True(t, ok)
	assert.Equal(t, priorTxHash, txHash)
}

func TestSettleEIP3009_PendingSettlementStore_TerminalVerifyFailureNeverTouchesStore(t *testing.T) {
	payload, requirements := plainEIP3009Payload(t)
	badRequirements := requirements
	badRequirements.PayTo = "0x0000000000000000000000000000000000000000"
	signer := deployedCodeSigner(nil)
	scheme := NewExactEvmScheme(signer, &ExactEvmSchemeConfig{})
	store := x402.NewInMemoryPendingSettlementStore()
	scheme.SetPendingSettlementStore(store)
	signature := payload.Payload["signature"].(string)

	_, err := scheme.Settle(context.Background(), payload, badRequirements, nil)
	require.Error(t, err)
	assert.Equal(t, 0, signer.writeCalls)

	_, ok, _ := store.Get(context.Background(), signature)
	assert.False(t, ok)
}

// An invalid broadcast hash means nothing usable was ever sent, so there is nothing to
// reconcile against later: the pending-settlement store must stay empty rather than being
// polluted with the unusable hash (which a later retry could otherwise try to reconcile
// against instead of correctly re-attempting the broadcast).
func TestSettleEIP3009_PendingSettlementStore_InvalidBroadcastHashNeverPopulatesStore(t *testing.T) {
	payload, requirements := plainEIP3009Payload(t)
	signer := deployedCodeSigner(fmt.Errorf("rpc: timeout waiting for receipt"))
	signer.writeTxHash = "0xnothash"
	scheme := NewExactEvmScheme(signer, &ExactEvmSchemeConfig{})
	store := x402.NewInMemoryPendingSettlementStore()
	scheme.SetPendingSettlementStore(store)
	signature := payload.Payload["signature"].(string)

	_, err := scheme.Settle(context.Background(), payload, requirements, nil)
	assertSettleErr(t, err, ErrTransactionFailed, "")

	_, ok, _ := store.Get(context.Background(), signature)
	assert.False(t, ok, "an invalid broadcast hash must never be cached")
}

func TestSettlePermit2_PendingSettlementStore_InvalidBroadcastHashNeverPopulatesStore(t *testing.T) {
	payload, requirements, permit2Payload := plainPermit2Payload()
	signer := deployedCodeSigner(fmt.Errorf("rpc: timeout waiting for receipt"))
	signer.writeTxHash = "0xnothash"
	store := x402.NewInMemoryPendingSettlementStore()

	_, err := SettlePermit2(context.Background(), signer, payload, requirements, permit2Payload, nil,
		&Permit2FacilitatorConfig{PendingSettlementStore: store})
	assertSettleErr(t, err, ErrTransactionFailed, "")

	_, ok, _ := store.Get(context.Background(), permit2Payload.Signature)
	assert.False(t, ok, "an invalid broadcast hash must never be cached")
}

func TestSettleEIP3009_PendingSettlementStore_DefaultsToFreshInMemoryStoreWhenNoneInjected(t *testing.T) {
	payload, requirements := plainEIP3009Payload(t)
	scheme := NewExactEvmScheme(deployedCodeSigner(nil), &ExactEvmSchemeConfig{})

	resp, err := scheme.Settle(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)
}

func TestSettlePermit2_PendingSettlementStore_CacheMissSuccessLeavesNoEntry(t *testing.T) {
	payload, requirements, permit2Payload := plainPermit2Payload()
	signer := deployedCodeSigner(nil)
	store := x402.NewInMemoryPendingSettlementStore()

	resp, err := SettlePermit2(context.Background(), signer, payload, requirements, permit2Payload, nil,
		&Permit2FacilitatorConfig{PendingSettlementStore: store})
	require.NoError(t, err)
	assert.True(t, resp.Success)

	_, ok, _ := store.Get(context.Background(), permit2Payload.Signature)
	assert.False(t, ok)
}

func TestSettlePermit2_PendingSettlementStore_CacheMissReceiptFailurePopulatesStore(t *testing.T) {
	payload, requirements, permit2Payload := plainPermit2Payload()
	signer := deployedCodeSigner(fmt.Errorf("rpc: timeout waiting for receipt"))
	store := x402.NewInMemoryPendingSettlementStore()

	_, err := SettlePermit2(context.Background(), signer, payload, requirements, permit2Payload, nil,
		&Permit2FacilitatorConfig{PendingSettlementStore: store})
	wantTxHash := "0x" + strings.Repeat("ab", 32)
	assertSettlementPending(t, err, wantTxHash)

	txHash, ok, _ := store.Get(context.Background(), permit2Payload.Signature)
	assert.True(t, ok)
	assert.Equal(t, wantTxHash, txHash)
}

func TestSettlePermit2_PendingSettlementStore_CacheHitReconcilesWithoutRebroadcast(t *testing.T) {
	payload, requirements, permit2Payload := plainPermit2Payload()
	signer := deployedCodeSigner(nil)
	store := x402.NewInMemoryPendingSettlementStore()
	priorTxHash := "0x" + strings.Repeat("ab", 32)
	require.NoError(t, store.Set(context.Background(), permit2Payload.Signature, priorTxHash))

	resp, err := SettlePermit2(context.Background(), signer, payload, requirements, permit2Payload, nil,
		&Permit2FacilitatorConfig{PendingSettlementStore: store})
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, priorTxHash, resp.Transaction)
	assert.Equal(t, 0, signer.writeCalls, "reconciliation fast path must never re-broadcast")

	_, ok, _ := store.Get(context.Background(), permit2Payload.Signature)
	assert.False(t, ok)
}

func TestSettlePermit2_PendingSettlementStore_CacheHitStillPendingReturnsAgainWithoutRebroadcast(t *testing.T) {
	payload, requirements, permit2Payload := plainPermit2Payload()
	signer := deployedCodeSigner(fmt.Errorf("rpc: still pending"))
	store := x402.NewInMemoryPendingSettlementStore()
	priorTxHash := "0x" + strings.Repeat("ab", 32)
	require.NoError(t, store.Set(context.Background(), permit2Payload.Signature, priorTxHash))

	_, err := SettlePermit2(context.Background(), signer, payload, requirements, permit2Payload, nil,
		&Permit2FacilitatorConfig{PendingSettlementStore: store})
	assertSettlementPending(t, err, priorTxHash)
	assert.Equal(t, 0, signer.writeCalls)

	txHash, ok, _ := store.Get(context.Background(), permit2Payload.Signature)
	assert.True(t, ok)
	assert.Equal(t, priorTxHash, txHash)
}

func TestSettlePermit2_PendingSettlementStore_DefaultsToFreshInMemoryStoreWhenNoneInjected(t *testing.T) {
	payload, requirements, permit2Payload := plainPermit2Payload()
	signer := deployedCodeSigner(nil)

	resp, err := SettlePermit2(context.Background(), signer, payload, requirements, permit2Payload, nil, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)
}
