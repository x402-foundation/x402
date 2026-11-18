package facilitator

import (
	"context"
	"testing"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

// onchainHoldCases are the verify-hold states a managed refund or deposit settle can meet.
var onchainHoldCases = []struct {
	name      string
	pendingID string
	preHold   bool
	salt      string
}{
	{name: "no verify hold", pendingID: "", salt: "10"},
	{name: "lapsed verify hold", pendingID: "0xlapsed", salt: "11"},
	{name: "live verify hold", pendingID: "0xlive", preHold: true, salt: "12"},
}

func TestSettleManaged_RefundWithLapsedLockFailsWhileAnotherHolderIsLive(t *testing.T) {
	h := newHotRefund(t, unclaimedFields(), nil, nil)
	acquireBound(t, h.inner, "0xother", voucherFields(h.channelID, "6000", dummySig))

	resp, err := h.settleWithPendingID("5000", "0xlapsed")
	if err != nil || resp == nil || resp.Success || resp.ErrorReason != ErrPendingIdMismatch {
		t.Fatalf("refund %+v %v", resp, err)
	}
	if len(h.signer.writeFns) != 0 {
		t.Fatalf("writes = %v, want none", h.signer.writeFns)
	}
	if got := h.row(); got.ChargedCumulativeAmount != "5000" || got.PendingClaim != nil || got.ChargeCount != 6 {
		t.Fatalf("row changed: %+v", got)
	}
	if held, _ := h.inner.IsHeld(context.Background(), h.channelID, ""); !held {
		t.Fatal("the other holder's reservation must stay live")
	}
}

func TestSettleManaged_RefundHoldsTheLockThroughBroadcast(t *testing.T) {
	for _, tc := range onchainHoldCases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHotRefund(t, unclaimedFields(), nil, nil)
			if tc.preHold {
				acquireBound(t, h.inner, tc.pendingID, voucherFields(h.channelID, h.charged, dummySig))
			}
			rivalAcquired := true
			h.onWrite = func() {
				rivalAcquired, _ = h.inner.Acquire(context.Background(), h.channelID, "0xrival", 60_000)
			}

			resp, err := h.settleWithPendingID("5000", tc.pendingID)
			if err != nil || resp == nil || !resp.Success {
				t.Fatalf("refund %+v %v", resp, err)
			}
			if rivalAcquired {
				t.Fatal("another owner acquired the lock during the refund broadcast")
			}
			if held, _ := h.inner.IsHeld(context.Background(), h.channelID, ""); held {
				t.Fatal("lock must be free after the refund")
			}
		})
	}
}

func TestSettleManagedDeposit_WithLapsedLockFailsWhileAnotherHolderIsLive(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "06")
	channelId := mustChannelId(t, cfg)
	signer := managedDepositSigner(t)
	deps := managedDeps(t, store, store, auth, signer)
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "svc", nil }
	acquireBound(t, store, "0xother", voucherFields(channelId, "1000", dummySig))
	payment := signedManagedDeposit(t, cfg, channelId)
	payment.Payload["pendingId"] = "0xlapsed"

	resp, err := SettleManaged(context.Background(), deps, payment, managedRequirements(auth.addr), nil, nil)
	if err != nil || resp == nil || resp.Success || resp.ErrorReason != ErrPendingIdMismatch {
		t.Fatalf("deposit %+v %v", resp, err)
	}
	if signer.writeCalls != 0 {
		t.Fatalf("writes = %d, want none", signer.writeCalls)
	}
	if got, _ := store.Get(context.Background(), channelId); got != nil {
		t.Fatalf("failed deposit committed a row: %+v", got)
	}
	if held, _ := store.IsHeld(context.Background(), channelId, ""); !held {
		t.Fatal("the other holder's reservation must stay live")
	}
}

func TestSettleManagedDeposit_HoldsTheLockThroughBroadcast(t *testing.T) {
	for _, tc := range onchainHoldCases {
		t.Run(tc.name, func(t *testing.T) {
			store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
			auth := managedAuthorizer()
			cfg := managedConfig(auth.addr, tc.salt)
			channelId := mustChannelId(t, cfg)
			signer := managedDepositSigner(t)
			rivalAcquired := true
			write := signer.writeContract
			signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
				rivalAcquired, _ = store.Acquire(context.Background(), channelId, "0xrival", 60_000)
				return write(functionName, args...)
			}
			deps := managedDeps(t, store, store, auth, signer)
			deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "svc", nil }
			payment := signedManagedDeposit(t, cfg, channelId)
			if tc.pendingID != "" {
				payment.Payload["pendingId"] = tc.pendingID
			}
			if tc.preHold {
				acquireBound(t, store, tc.pendingID, voucherFields(channelId, "1000", eoaVoucherSignature(t, channelId, "1000", managedNetwork)))
			}

			resp, err := SettleManaged(context.Background(), deps, payment, managedRequirements(auth.addr), nil, nil)
			if err != nil || resp == nil || !resp.Success {
				t.Fatalf("deposit %+v %v", resp, err)
			}
			if rivalAcquired {
				t.Fatal("another owner acquired the lock during the deposit broadcast")
			}
			if held, _ := store.IsHeld(context.Background(), channelId, ""); held {
				t.Fatal("lock must be free after the deposit")
			}
		})
	}
}
