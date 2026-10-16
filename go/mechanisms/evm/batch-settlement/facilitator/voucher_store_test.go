package facilitator

import (
	"context"
	"errors"
	"math"
	"math/big"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestVerifyManaged_RejectsWhenAdmissionLockHeld(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	ok, err := store.Acquire(context.Background(), channelId, "0xother", 60_000)
	if err != nil || !ok {
		t.Fatalf("acquire: %v %v", ok, err)
	}

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrChannelBusy {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerifyManaged_ConcurrentSameSignatureBusy(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))
	deps := managedDeps(t, store, store, auth, nil)
	payload := voucherEnvelope(cfg, voucherFields(channelId, "2000", dummySig), "")
	reqs := managedRequirements(auth.addr)

	var wg sync.WaitGroup
	results := make([]*struct {
		resp *x402.VerifyResponse
		err  error
	}, 2)
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			resp, err := VerifyManaged(context.Background(), deps, payload, reqs, nil)
			results[i] = &struct {
				resp *x402.VerifyResponse
				err  error
			}{resp, err}
		}()
	}
	wg.Wait()

	valid, busy := 0, 0
	for _, r := range results {
		if r.err != nil {
			t.Fatalf("err: %v", r.err)
		}
		if r.resp.IsValid {
			valid++
			if pendingIdFrom(r.resp) == "" {
				t.Fatal("missing pendingId")
			}
		}
		if r.resp.InvalidReason == ErrChannelBusy {
			busy++
		}
	}
	if valid != 1 || busy != 1 {
		t.Fatalf("valid=%d busy=%d", valid, busy)
	}
}

func TestSettleManaged_ReleasesLockWhenPendingIdEchoed(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "2000", dummySig)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))
	deps := managedDeps(t, store, store, auth, nil)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	verified, err := VerifyManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, ""), reqs, nil)
	if err != nil || !verified.IsValid {
		t.Fatalf("verify: %+v %v", verified, err)
	}
	pendingId := pendingIdFrom(verified)
	held, _ := store.IsHeld(context.Background(), channelId, "")
	if !held {
		t.Fatal("expected held lock")
	}

	settled, err := SettleManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, pendingId), reqs, nil, nil)
	if err != nil || !settled.Success {
		t.Fatalf("settle: %+v %v", settled, err)
	}
	held, _ = store.IsHeld(context.Background(), channelId, "")
	if held {
		t.Fatal("expected lock released")
	}
}

func TestSettleManaged_ZeroAmountDoesNotIncrementChargeCount(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "2000", dummySig)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		SignedMaxClaimable: "2000",
		ChargeCount:        2,
	}))
	deps := managedDeps(t, store, store, auth, nil)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	verified, err := VerifyManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, ""), reqs, nil)
	if err != nil || !verified.IsValid {
		t.Fatalf("verify: %+v %v", verified, err)
	}
	reqs.Amount = "0"
	settled, err := SettleManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, pendingIdFrom(verified)), reqs, nil, nil)
	if err != nil || !settled.Success {
		t.Fatalf("settle: %+v %v", settled, err)
	}
	if extraInt(settled, "chargeCount") != 2 {
		t.Fatalf("chargeCount extra = %d", extraInt(settled, "chargeCount"))
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.ChargedCumulativeAmount != "1000" || got.ChargeCount != 2 {
		t.Fatalf("stored %+v", got)
	}
}

func TestVerifyManaged_RejectsClientCancel(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	payload := cancelEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "")

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil), payload, managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrUnexpectedCancel {
		t.Fatalf("got %+v", resp)
	}
	held, _ := store.IsHeld(context.Background(), channelId, "")
	if held {
		t.Fatal("lock should not be taken")
	}
}

func TestVerifyManaged_WrongWithdrawDelay(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	reqs := managedRequirements(auth.addr)
	reqs.Extra["withdrawDelay"] = 600

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""), reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrWithdrawDelayMismatch {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerifyManaged_UnsupportedPayloadType(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		managedEnvelope(map[string]interface{}{"type": "claim", "claims": []interface{}{}}),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrInvalidPayload {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerifyManaged_StoreReadFailure(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, getErr: errors.New("store unavailable")}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrRpcReadFailed {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerifyManaged_StoreReadFailureDeposit(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, getErr: errors.New("store unavailable")}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		managedDepositEnvelope(cfg, channelId), reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrRpcReadFailed {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerifyManaged_StoreReadFailureRefund(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, getErr: errors.New("store unavailable")}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		refundEnvelope(cfg, voucherFields(channelId, "5000", dummySig), "0", "", ""),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrRpcReadFailed {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_ChargeCommitStorageError(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, inner, storedManagedChannel(cfg, channelId, nil))
	store := &hookStore{inner: inner, updateErr: errors.New("storage write failed")}

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "2000", dummySig), ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrChannelBusy {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_UnsupportedPayloadType(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		managedEnvelope(map[string]interface{}{"type": "settle", "receiver": managedReceiver, "token": managedToken}),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrInvalidPayload {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_InvalidSignatureWithoutLock(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	signer := newManagedSigner(t, &managedRPC{invalidSig: true})

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrVoucherSignatureInvalid {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_RefundWatermarkMismatch(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedIdentityConfig(auth.addr)
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{ChargedCumulativeAmount: "1000"}))
	deps := managedDeps(t, store, store, auth, nil)
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "svc", nil }
	bindManagedIdentity(t, deps.DelegatedAuthStore, channelId, "svc")

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "5000", dummySig), "1000", "", ""),
		managedIdentityRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrCumulativeAmountMismatch {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_HeldPathChannelIdMismatch(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, store, "0xpending", voucher)
	bad := cfg
	bad.Salt = managedSalt("01")

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(bad, voucher, "0xpending"),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrChannelIdMismatch {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_EmptyStoreBootstrapsFromOnchain(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	rpc := &managedRPC{totalClaimed: bigInt(0)}
	signer := newManagedSigner(t, rpc)

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got == nil || got.ChargedCumulativeAmount != "1000" {
		t.Fatalf("stored %+v", got)
	}
}

func TestVerifyManaged_MismatchWithoutRowOmitsVoucherState(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "5000", dummySig), ""), reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrCumulativeAmountMismatch {
		t.Fatalf("got %+v", resp)
	}
	vs, _ := resp.Extra["voucherState"].(map[string]interface{})
	if len(vs) != 0 {
		t.Fatalf("voucherState = %+v", vs)
	}
}

func TestVerifyManaged_CorruptStoredWatermarkIsMismatch(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{ChargedCumulativeAmount: "not-a-number"}))
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "2000", dummySig), ""), reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrCumulativeAmountMismatch {
		t.Fatalf("corrupt watermark must fail closed, got %+v", resp)
	}
}

func TestVerifyManaged_NonceFailureIsVoucherStoreUnavailable(t *testing.T) {
	oldCreateNonce := createNonce
	createNonce = func() (string, error) { return "", errors.New("rand down") }
	defer func() { createNonce = oldCreateNonce }()

	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "2000", dummySig), ""),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrVoucherStoreUnavailable {
		t.Fatalf("nonce failure is not RPC, got %+v", resp)
	}
}

func managedDepositEnvelope(cfg batchsettlement.ChannelConfig, channelId string) types.PaymentPayload {
	p := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Voucher:       voucherFields(channelId, "1000", dummySig),
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: "1000",
			Authorization: batchsettlement.BatchSettlementDepositAuthorization{
				Erc3009Authorization: goodErc3009Auth(),
			},
		},
	}
	return managedEnvelope(p.ToMap())
}

func managedDepositSigner(t *testing.T) *fakeFacilitatorSigner {
	t.Helper()
	return depositSignerWithBalances(t, 0, 1000)
}

// depositSignerWithBalances reads prior until the deposit write, then each post-write
// read takes the next balance from postWrite and repeats the last.
func depositSignerWithBalances(t *testing.T, prior int64, postWrite ...int64) *fakeFacilitatorSigner {
	t.Helper()
	var writeSeen bool
	postReads := 0
	return &fakeFacilitatorSigner{
		addresses: []string{managedFacilitator},
		chainId:   big.NewInt(84532),
		writeContract: func(functionName string, _ ...interface{}) (string, error) {
			if functionName != "deposit" {
				return "", errors.New("unexpected write " + functionName)
			}
			writeSeen = true
			return successTxHash, nil
		},
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
		},
		getBalance: func(string, string) (*big.Int, error) {
			return big.NewInt(10000), nil
		},
		readContract: func(functionName string, _ ...interface{}) (interface{}, error) {
			if functionName == "deposit" {
				return nil, nil
			}
			if functionName != evm.FunctionTryAggregate {
				return nil, errors.New("unexpected rpc")
			}
			if !writeSeen {
				return multicallChannelStateResult(t, big.NewInt(prior), big.NewInt(0), 0, big.NewInt(0)), nil
			}
			balance := postWrite[min(postReads, len(postWrite)-1)]
			postReads++
			return multicallChannelStateResult(t, big.NewInt(balance), big.NewInt(0), 0, big.NewInt(0)), nil
		},
	}
}

func TestSettleManagedDeposit_IdentityErrorFailsClosed(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedIdentityConfig(auth.addr)
	channelId := mustChannelId(t, cfg)
	deps := managedDeps(t, store, store, auth, managedDepositSigner(t))
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "", errors.New("idp down") }

	resp, err := SettleManaged(context.Background(), deps,
		managedDepositEnvelope(cfg, channelId),
		managedIdentityRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrDelegatedSettleUnauthenticated {
		t.Fatalf("identity failure must fail the deposit closed, got %+v", resp)
	}
	if got, _ := store.Get(context.Background(), channelId); got != nil {
		t.Fatal("failed deposit must not commit a channel row")
	}
	if binding, _ := deps.DelegatedAuthStore.Get(context.Background(), channelId, managedNetwork); binding != nil {
		t.Fatal("failed deposit must not leave a binding")
	}
}

// updateFailingStorage fails every channel write.
type updateFailingStorage struct {
	storage.ChannelStorage[*FacilitatorChannel]
}

func (updateFailingStorage) UpdateChannel(context.Context, string, func(*FacilitatorChannel) *FacilitatorChannel) (*storage.ChannelUpdateResult[*FacilitatorChannel], error) {
	return nil, errors.New("storage down")
}

func TestSettleManagedDeposit_VoucherCommitFailureReportsTxAndKeepsBinding(t *testing.T) {
	mem := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedIdentityConfig(auth.addr)
	channelId := mustChannelId(t, cfg)
	deps := managedDeps(t, updateFailingStorage{ChannelStorage: mem}, mem, auth, managedDepositSigner(t))
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "svc", nil }

	resp, err := SettleManaged(context.Background(), deps,
		signedManagedDeposit(t, cfg, channelId),
		managedIdentityRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrVoucherStoreUnavailable || resp.Transaction != successTxHash {
		t.Fatalf("commit failure must report failure with the deposit tx, got %+v", resp)
	}
	if binding, _ := deps.DelegatedAuthStore.Get(context.Background(), channelId, managedNetwork); binding == nil || binding.CallerIdentity != "svc" {
		t.Fatalf("confirmed deposit must keep the binding, got %+v", binding)
	}
}

func TestSettleManagedDeposit_BindingConflictFailsBeforeBroadcast(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedIdentityConfig(auth.addr)
	channelId := mustChannelId(t, cfg)
	signer := managedDepositSigner(t)
	deps := managedDeps(t, store, store, auth, signer)
	if _, err := deps.DelegatedAuthStore.Bind(context.Background(), storage.DelegatedAuthBinding{
		ChannelId: channelId, Network: managedNetwork, CallerIdentity: "owner-a",
	}); err != nil {
		t.Fatal(err)
	}
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "owner-b", nil }

	_, err := SettleManaged(context.Background(), deps,
		signedManagedDeposit(t, cfg, channelId),
		managedIdentityRequirements(auth.addr), nil, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrDelegatedSettleUnauthenticated {
		t.Fatalf("binding conflict must fail before broadcast, got %v", err)
	}
	if signer.writeCalls != 0 {
		t.Fatalf("conflict must not broadcast, writes=%d", signer.writeCalls)
	}
	binding, _ := deps.DelegatedAuthStore.Get(context.Background(), channelId, managedNetwork)
	if binding == nil || binding.CallerIdentity != "owner-a" {
		t.Fatalf("bind conflict must keep the first binding, got %+v", binding)
	}
}

func TestSettleManagedDeposit_SameIdentityRebindsIdempotently(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedIdentityConfig(auth.addr)
	channelId := mustChannelId(t, cfg)
	deps := managedDeps(t, store, store, auth, managedDepositSigner(t))
	if _, err := deps.DelegatedAuthStore.Bind(context.Background(), storage.DelegatedAuthBinding{
		ChannelId: channelId, Network: managedNetwork, CallerIdentity: "svc",
	}); err != nil {
		t.Fatal(err)
	}
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "svc", nil }

	resp, err := SettleManaged(context.Background(), deps,
		signedManagedDeposit(t, cfg, channelId),
		managedIdentityRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !resp.Success {
		t.Fatalf("same-identity rebind must succeed, got %+v", resp)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got == nil {
		t.Fatal("expected stored channel")
	}
	binding, _ := deps.DelegatedAuthStore.Get(context.Background(), channelId, managedNetwork)
	if binding == nil || binding.CallerIdentity != "svc" {
		t.Fatalf("delegated binding = %+v, want svc", binding)
	}
}

func TestSettleManagedDeposit_ServerRefundKeyDoesNotBindIdentity(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	serverEOA := addressOfKey(t, serverRefundKeyHex)
	cfg := managedConfigWithRefundAuthorizer(t, auth.addr, serverEOA)
	channelId := mustChannelId(t, cfg)
	deps := managedDeps(t, store, store, auth, managedDepositSigner(t))
	resolved := false
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) {
		resolved = true
		return "svc", nil
	}
	reqs := managedRequirements(auth.addr)
	reqs.Extra["refundAuthorizer"] = serverEOA

	resp, err := SettleManaged(context.Background(), deps, signedManagedDeposit(t, cfg, channelId), reqs, nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if resolved {
		t.Fatal("identity must not be resolved when the 402 names a server refund key")
	}
	if binding, _ := deps.DelegatedAuthStore.Get(context.Background(), channelId, managedNetwork); binding != nil {
		t.Fatalf("unexpected binding %+v", binding)
	}
}

func TestSettleManaged_SubstitutedVoucherPendingIdMismatch(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "2000", dummySig)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))
	deps := managedDeps(t, store, store, auth, nil)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	verified, err := VerifyManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, ""), reqs, nil)
	if err != nil || !verified.IsValid {
		t.Fatalf("verify: %+v %v", verified, err)
	}
	pendingId := pendingIdFrom(verified)
	rpcSigner := newManagedSigner(t, &managedRPC{})
	deps.Signer = rpcSigner

	sub := voucherFields(channelId, "9999", "0xdeadbeef")
	subReqs := managedRequirements(auth.addr)
	subReqs.Amount = "500"
	substituted, err := SettleManaged(context.Background(), deps, voucherEnvelope(cfg, sub, pendingId), subReqs, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if substituted.Success || substituted.ErrorReason != ErrPendingIdMismatch {
		t.Fatalf("got %+v", substituted)
	}
	held, _ := store.IsHeld(context.Background(), channelId, "")
	if !held {
		t.Fatal("reservation should remain live")
	}
	if rpcSigner.verifyCalls != 0 {
		t.Fatalf("verifyCalls=%d", rpcSigner.verifyCalls)
	}

	genuine, err := SettleManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, pendingId), subReqs, nil, nil)
	if err != nil || !genuine.Success {
		t.Fatalf("genuine: %+v %v", genuine, err)
	}
	held, _ = store.IsHeld(context.Background(), channelId, "")
	if held {
		t.Fatal("expected lock released")
	}
}

func TestSettleManaged_OmittedPendingIdWhileReservationLive(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, store, "0xother", voucher)
	rpc := &managedRPC{}
	rpcSigner := newManagedSigner(t, rpc)
	deps := managedDeps(t, store, store, auth, rpcSigner)

	result, err := SettleManaged(context.Background(), deps,
		voucherEnvelope(cfg, voucher, ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Success || result.ErrorReason != ErrPendingIdMismatch {
		t.Fatalf("got %+v", result)
	}
	if rpcSigner.verifyCalls != 0 || rpc.tryAggregate != 0 {
		t.Fatalf("verifyCalls=%d tryAggregate=%d, want 0", rpcSigner.verifyCalls, rpc.tryAggregate)
	}
	held, _ := store.IsHeld(context.Background(), channelId, "")
	if !held {
		t.Fatal("reservation should remain live")
	}
}

func TestSettleManaged_HeldPathRequirementMismatches(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "2000", dummySig)
	payload := voucherEnvelope(cfg, voucher, "0xpending")
	deps := managedDeps(t, store, store, auth, nil)

	acquireBound(t, store, "0xpending", voucher)
	assetReqs := managedRequirements(auth.addr)
	assetReqs.Asset = managedReceiver
	asset, err := SettleManaged(context.Background(), deps, payload, assetReqs, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if asset.ErrorReason != ErrTokenMismatch {
		t.Fatalf("asset: %+v", asset)
	}

	acquireBound(t, store, "0xpending", voucher)
	payToReqs := managedRequirements(auth.addr)
	payToReqs.PayTo = managedPayer
	payTo, err := SettleManaged(context.Background(), deps, payload, payToReqs, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if payTo.ErrorReason != ErrReceiverMismatch {
		t.Fatalf("payTo: %+v", payTo)
	}

	acquireBound(t, store, "0xpending", voucher)
	authReqs := managedRequirements(auth.addr)
	authReqs.Extra["receiverAuthorizer"] = "0x1111111111111111111111111111111111111111"
	mismatch, err := SettleManaged(context.Background(), deps, payload, authReqs, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if mismatch.ErrorReason != ErrReceiverAuthorizerMismatch {
		t.Fatalf("authorizer: %+v", mismatch)
	}
}

func TestSettleManaged_FallsThroughWhenPendingIdLockGone(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	rpc := &managedRPC{}
	signer := newManagedSigner(t, rpc)

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "0xpending"),
		managedRequirements(auth.addr), nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if rpc.tryAggregate == 0 {
		t.Fatal("expected onchain verify")
	}
}

func TestSettleManaged_LockLostManagedRequirementMismatch(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	rpc := &managedRPC{}
	signer := newManagedSigner(t, rpc)

	authReqs := managedRequirements(auth.addr)
	authReqs.Extra["receiverAuthorizer"] = "0x1111111111111111111111111111111111111111"
	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "0xstale"),
		authReqs, nil, nil)
	if err != nil || resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if resp.ErrorReason != ErrReceiverAuthorizerMismatch {
		t.Fatalf("authorizer: %+v", resp)
	}
	if rpc.tryAggregate != 0 {
		t.Fatal("expected managedRequirement check before onchain verify")
	}

	delayReqs := managedRequirements(auth.addr)
	delayReqs.Extra["withdrawDelay"] = 600
	delay, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "0xstale"),
		delayReqs, nil, nil)
	if err != nil || delay.Success {
		t.Fatalf("got %+v %v", delay, err)
	}
	if delay.ErrorReason != ErrWithdrawDelayMismatch {
		t.Fatalf("withdrawDelay: %+v", delay)
	}
}

func TestVerifyManaged_SkipsOnchainWhenCachedEOAFresh(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	cfg.PayerAuthorizer = managedPayer
	channelId := mustChannelId(t, cfg)
	sig := eoaVoucherSignature(t, channelId, "2000", managedNetwork)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		Balance:            "10000",
		TotalClaimed:       "0",
		OnchainSyncedAt:    time.Now().UnixMilli(),
		SignedMaxClaimable: "1000",
	}))
	rpc := &managedRPC{}
	signer := newManagedSigner(t, rpc)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "2000", sig), ""), reqs, nil)
	if err != nil || !resp.IsValid {
		t.Fatalf("got %+v %v", resp, err)
	}
	if rpc.tryAggregate != 0 {
		t.Fatalf("tryAggregate=%d, want cached path", rpc.tryAggregate)
	}
}

func TestVerifyManaged_StaleCacheFallsBackToOnchain(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	cfg.PayerAuthorizer = managedPayer
	channelId := mustChannelId(t, cfg)
	sig := eoaVoucherSignature(t, channelId, "2000", managedNetwork)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		Balance:         "10000",
		TotalClaimed:    "0",
		OnchainSyncedAt: 1,
	}))
	rpc := &managedRPC{}
	signer := newManagedSigner(t, rpc)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "2000", sig), ""), reqs, nil)
	if err != nil || !resp.IsValid {
		t.Fatalf("got %+v %v", resp, err)
	}
	if rpc.tryAggregate == 0 {
		t.Fatal("expected onchain fallback")
	}
}

func TestVerifyManaged_ZeroTtlAlwaysReadsOnchain(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		OnchainSyncedAt: time.Now().UnixMilli(),
	}))
	rpc := &managedRPC{}
	signer := newManagedSigner(t, rpc)
	deps := managedDeps(t, store, store, auth, signer)
	zero := int64(0)
	deps.OnchainStateTtlMs = &zero
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := VerifyManaged(context.Background(), deps,
		voucherEnvelope(cfg, voucherFields(channelId, "2000", dummySig), ""), reqs, nil)
	if err != nil || !resp.IsValid {
		t.Fatalf("got %+v %v", resp, err)
	}
	if rpc.tryAggregate == 0 {
		t.Fatal("expected onchain read")
	}
}

func TestVerifyManaged_RejectsEOASignatureBeforeLock(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	cfg.PayerAuthorizer = managedPayer
	channelId := mustChannelId(t, cfg)

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrVoucherSignatureInvalid {
		t.Fatalf("got %+v", resp)
	}
	held, _ := store.IsHeld(context.Background(), channelId, "")
	if held {
		t.Fatal("lock should not be taken")
	}
}

func TestVerifyManaged_RethrowsLockImplementationError(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, acquireErr: syntaxLockErr()}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)

	_, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil)
	if err == nil {
		t.Fatal("expected lock implementation error")
	}
}

func TestSettleManaged_ChargeCommitConflict(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, updateConflict: true}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrChannelBusy {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_ChargeExceedsSignedCap(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "500",
	}))
	voucher := voucherFields(channelId, "1000", dummySig)
	acquireBound(t, store, "0xpending", voucher)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"
	payload := voucherEnvelope(cfg, voucher, "0xpending")
	payload.Accepted.Amount = "500"

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		payload, reqs, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrChargeExceedsSignedCumulative {
		t.Fatalf("got %+v", resp)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.ChargedCumulativeAmount != "500" {
		t.Fatalf("charged = %q", got.ChargedCumulativeAmount)
	}
}

func TestSettleManaged_ReplayUnderDynamicPriceDoesNotDoubleCharge(t *testing.T) {
	store, deps, payload, reqs, channelId := heldDynamicVoucher(t, "100", "0", "100", "40")

	first, err := SettleManaged(context.Background(), deps, payload, reqs, nil, nil)
	if err != nil || !first.Success {
		t.Fatalf("first: %+v %v", first, err)
	}
	voucher := voucherFields(channelId, "100", dummySig)
	acquireBound(t, store, "0xpending", voucher)
	second, err := SettleManaged(context.Background(), deps, payload, reqs, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if second.Success || second.ErrorReason != ErrCumulativeAmountMismatch || second.Extra != nil {
		t.Fatalf("replay: %+v", second)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.ChargedCumulativeAmount != "40" || got.ChargeCount != 1 {
		t.Fatalf("stored charged=%s chargeCount=%d", got.ChargedCumulativeAmount, got.ChargeCount)
	}
}

func TestSettleManaged_ConcurrentSamePayloadChargesOnce(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "0",
		OnchainSyncedAt:         time.Now().UnixMilli(),
	}))
	voucher := voucherFields(channelId, "100", dummySig)
	payload := voucherEnvelope(cfg, voucher, "0xpending")
	payload.Accepted.Amount = "100"
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "40"
	deps := managedDeps(t, store, alwaysHeldLock{}, auth, nil)

	var wg sync.WaitGroup
	results := make([]*x402.SettleResponse, 2)
	errs := make([]error, 2)
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			results[i], errs[i] = SettleManaged(context.Background(), deps, payload, reqs, nil, nil)
		}()
	}
	wg.Wait()

	success := 0
	for i, resp := range results {
		if errs[i] != nil {
			t.Fatalf("err: %v", errs[i])
		}
		if resp.Success {
			success++
			continue
		}
		if resp.ErrorReason != ErrCumulativeAmountMismatch {
			t.Fatalf("loser: %+v", resp)
		}
	}
	if success != 1 {
		t.Fatalf("success=%d", success)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.ChargedCumulativeAmount != "40" || got.ChargeCount != 1 {
		t.Fatalf("stored charged=%s chargeCount=%d", got.ChargedCumulativeAmount, got.ChargeCount)
	}
}

func TestSettleManaged_DifferentAcceptedAmountStillCharges(t *testing.T) {
	store, deps, payload, reqs, channelId := heldDynamicVoucher(t, "100", "0", "100", "40")
	if _, err := SettleManaged(context.Background(), deps, payload, reqs, nil, nil); err != nil {
		t.Fatal(err)
	}

	next := voucherEnvelope(cfgFromPayload(t, payload), voucherFields(channelId, "100", dummySig), "0xpending")
	next.Accepted.Amount = "60"
	reqs.Amount = "60"
	acquireBound(t, store, "0xpending", voucherFields(channelId, "100", dummySig))
	resp, err := SettleManaged(context.Background(), deps, next, reqs, nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.ChargedCumulativeAmount != "100" {
		t.Fatalf("charged = %q", got.ChargedCumulativeAmount)
	}
}

func TestSettleManaged_FixedPriceStillCharges(t *testing.T) {
	_, deps, payload, reqs, channelId := heldDynamicVoucher(t, "100", "0", "100", "100")
	store := deps.Storage
	resp, err := SettleManaged(context.Background(), deps, payload, reqs, nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.ChargedCumulativeAmount != "100" || got.ChargeCount != 1 {
		t.Fatalf("stored charged=%s chargeCount=%d", got.ChargedCumulativeAmount, got.ChargeCount)
	}
}

func TestSettleManaged_ActualAboveAcceptedRejected(t *testing.T) {
	store, deps, payload, reqs, channelId := heldDynamicVoucher(t, "100", "0", "40", "50")
	resp, err := SettleManaged(context.Background(), deps, payload, reqs, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrChargeExceedsSignedCumulative {
		t.Fatalf("got %+v", resp)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.ChargedCumulativeAmount != "0" || got.ChargeCount != 0 {
		t.Fatalf("stored charged=%s chargeCount=%d", got.ChargedCumulativeAmount, got.ChargeCount)
	}
}

func TestSettleManaged_AcceptedAboveSignedCapRejected(t *testing.T) {
	_, deps, payload, reqs, _ := heldDynamicVoucher(t, "100", "0", "200", "40")
	resp, err := SettleManaged(context.Background(), deps, payload, reqs, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrInvalidPayload {
		t.Fatalf("got %+v", resp)
	}
}

// heldDynamicVoucher seeds a fresh row and holds the admission lock for one voucher.
func heldDynamicVoucher(t *testing.T, maxClaimable, charged, accepted, actual string) (
	*storage.InMemoryChannelStorage[*FacilitatorChannel],
	VoucherStoreDeps,
	types.PaymentPayload,
	types.PaymentRequirements,
	string,
) {
	t.Helper()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: charged,
		OnchainSyncedAt:         time.Now().UnixMilli(),
	}))
	voucher := voucherFields(channelId, maxClaimable, dummySig)
	acquireBound(t, store, "0xpending", voucher)
	payload := voucherEnvelope(cfg, voucher, "0xpending")
	payload.Accepted.Amount = accepted
	reqs := managedRequirements(auth.addr)
	reqs.Amount = actual
	return store, managedDeps(t, store, store, auth, nil), payload, reqs, channelId
}

func cfgFromPayload(t *testing.T, payload types.PaymentPayload) batchsettlement.ChannelConfig {
	t.Helper()
	raw, _ := payload.Payload["channelConfig"].(map[string]interface{})
	cfg, err := batchsettlement.ChannelConfigFromMap(raw)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

type alwaysHeldLock struct{}

func (alwaysHeldLock) Acquire(context.Context, string, string, int64) (bool, error) {
	return true, nil
}
func (alwaysHeldLock) Release(context.Context, string, string) error { return nil }
func (alwaysHeldLock) IsHeld(context.Context, string, string) (bool, error) {
	return true, nil
}

func TestSettleManaged_IncrementsChargeCount(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{ChargeCount: 2}))
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, store, "0xpending", voucher)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucher, "0xpending"), reqs, nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if extraInt(resp, "chargeCount") != 3 {
		t.Fatalf("chargeCount = %d", extraInt(resp, "chargeCount"))
	}
}

func TestSettleManaged_RefundWithoutConsent(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "1000",
	}))

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_RefundMalformedAmount(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "nope", "", ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAmountInvalid {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_RefundZeroAmount(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "0", "", ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAmountInvalid {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_RefundCallerIdentity(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedIdentityConfig(auth.addr)
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "1000",
	}))
	deps := managedDeps(t, store, store, auth, nil)
	bindManagedIdentity(t, deps.DelegatedAuthStore, channelId, "bound-service")
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "bound-service", nil }

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", ""),
		managedIdentityRequirements(auth.addr), nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
}

func TestSettleManaged_RefundIdentityMismatch(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedIdentityConfig(auth.addr)
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))
	deps := managedDeps(t, store, store, auth, nil)
	bindManagedIdentity(t, deps.DelegatedAuthStore, channelId, "bound-service")
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "other", nil }

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", ""),
		managedIdentityRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_RefundIdentityResolutionError(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedIdentityConfig(auth.addr)
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))
	deps := managedDeps(t, store, store, auth, nil)
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "", errors.New("boom") }

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", ""),
		managedIdentityRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_RefundDelegatedAuthLookupFailure(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedIdentityConfig(auth.addr)
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))
	deps := managedDeps(t, store, store, auth, nil)
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "svc", nil }
	deps.DelegatedAuthStore = failingDelegatedAuth{}

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", ""),
		managedIdentityRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_RefundMissingDelegatedAuthBinding(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedIdentityConfig(auth.addr)
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "5000",
		ChargeCount:             0,
	}))
	deps := managedDeps(t, store, store, auth, nil)
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "service-bound", nil }

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "5000", dummySig), "5000", "", ""),
		managedIdentityRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_CancelReleasesLock(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, store, "0xpending", voucher)

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		cancelEnvelope(cfg, voucher, "0xpending"),
		managedRequirements(auth.addr), nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	held, _ := store.IsHeld(context.Background(), channelId, "")
	if held {
		t.Fatal("expected released")
	}
}

func TestSettleManaged_ContinuesWhenLockReleaseFails(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, releaseErr: errors.New("release failed")}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, inner, storedManagedChannel(cfg, channelId, nil))
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, inner, "0xpending", voucher)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucher, "0xpending"), reqs, nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
}

func TestVerifyManaged_RefundAuthorizerSaltMismatch(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	reqs := managedRequirements(auth.addr)
	reqs.Extra["refundAuthorizer"] = managedPayer

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""), reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrRefundAuthorizerMismatch {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerifyManaged_NonAddressReceiverAuthorizer(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	reqs := managedRequirements(auth.addr)
	reqs.Extra["receiverAuthorizer"] = "not-an-address"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""), reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrReceiverAuthorizerMismatch {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerifyManaged_MismatchIncludesVoucherState(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		SignedMaxClaimable: "1000",
		Signature:          dummySig,
	}))
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "5000", dummySig), ""), reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrCumulativeAmountMismatch {
		t.Fatalf("got %+v", resp)
	}
	vs, _ := resp.Extra["voucherState"].(map[string]interface{})
	if extraString(vs, "signature") != dummySig {
		t.Fatalf("voucherState = %+v", vs)
	}
}

func TestSettleManaged_PartialRefundKeepsRow(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	refundAuth := auth.addr
	packed, err := batchsettlement.PackRefundAuthorizerSalt("0x"+strings.Repeat("11", 12), refundAuth)
	if err != nil {
		t.Fatal(err)
	}
	cfg := managedConfig(auth.addr, "00")
	cfg.Salt = packed
	channelId := mustChannelId(t, cfg)
	_, sig := signRefundConsent(t, channelId, "1000", "0", managedNetwork)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "5000",
		Balance:                 "10000",
		ChargeCount:             1,
	}))
	reqs := managedRequirements(auth.addr)
	reqs.Extra["refundAuthorizer"] = refundAuth

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		refundEnvelope(cfg, voucherFields(channelId, "5000", dummySig), "1000", "", sig),
		reqs, nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got == nil {
		t.Fatal("expected retained row")
	}
}

func TestSettleManaged_FullRefundDeletesRow(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	refundAuth := auth.addr
	packed, err := batchsettlement.PackRefundAuthorizerSalt("0x"+strings.Repeat("22", 12), refundAuth)
	if err != nil {
		t.Fatal(err)
	}
	cfg := managedConfig(auth.addr, "00")
	cfg.Salt = packed
	channelId := mustChannelId(t, cfg)
	_, sig := signRefundConsent(t, channelId, "10000", "0", managedNetwork)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "0",
		SignedMaxClaimable:      "0",
		Balance:                 "10000",
		ChargeCount:             0,
	}))
	reqs := managedRequirements(auth.addr)
	reqs.Extra["refundAuthorizer"] = refundAuth
	deps := managedDeps(t, store, store, auth, nil)
	bindManagedIdentity(t, deps.DelegatedAuthStore, channelId, "svc")

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "0", dummySig), "10000", "", sig),
		reqs, nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got != nil {
		t.Fatalf("expected deleted row, got %+v", got)
	}
	// The binding outlives the voucher row.
	if binding, _ := deps.DelegatedAuthStore.Get(context.Background(), channelId, managedNetwork); binding == nil || binding.CallerIdentity != "svc" {
		t.Fatalf("full refund must keep the delegated binding, got %+v", binding)
	}
}

func TestSettleManaged_KeepFinishedRowsRetainsFullRefund(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	refundAuth := auth.addr
	packed, err := batchsettlement.PackRefundAuthorizerSalt("0x"+strings.Repeat("23", 12), refundAuth)
	if err != nil {
		t.Fatal(err)
	}
	cfg := managedConfig(auth.addr, "00")
	cfg.Salt = packed
	channelId := mustChannelId(t, cfg)
	_, sig := signRefundConsent(t, channelId, "10000", "0", managedNetwork)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "0",
		SignedMaxClaimable:      "0",
		Balance:                 "10000",
	}))
	reqs := managedRequirements(auth.addr)
	reqs.Extra["refundAuthorizer"] = refundAuth
	deps := managedDeps(t, store, store, auth, nil)
	deps.KeepFinishedRows = true

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "0", dummySig), "10000", "", sig),
		reqs, nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, err := store.Get(context.Background(), channelId)
	if err != nil || got == nil {
		t.Fatalf("row = %+v %v", got, err)
	}
}

func TestVerifyManaged_RefundMatchesWatermark(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "1000",
	}))
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "0"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "", "", ""), reqs, nil)
	if err != nil || !resp.IsValid {
		t.Fatalf("got %+v %v", resp, err)
	}
}

type failingDelegatedAuth struct{}

func (failingDelegatedAuth) Bind(context.Context, storage.DelegatedAuthBinding) (bool, error) {
	return false, nil
}
func (failingDelegatedAuth) Get(_ context.Context, _, _ string) (*storage.DelegatedAuthBinding, error) {
	return nil, errors.New("auth store down")
}
func (failingDelegatedAuth) RevertBind(_ context.Context, _, _, _ string) error { return nil }

type countingChannelStore struct {
	*storage.InMemoryChannelStorage[*FacilitatorChannel]
	updates int
}

func (s *countingChannelStore) UpdateChannel(ctx context.Context, channelId string, update func(*FacilitatorChannel) *FacilitatorChannel) (*storage.ChannelUpdateResult[*FacilitatorChannel], error) {
	s.updates++
	return s.InMemoryChannelStorage.UpdateChannel(ctx, channelId, update)
}

// chainIdFailingSigner makes any typed-data voucher check fail with ErrChannelStateReadFailed.
type chainIdFailingSigner struct {
	*fakeFacilitatorSigner
}

func (chainIdFailingSigner) GetChainID(context.Context) (*big.Int, error) {
	return nil, errors.New("chain id unavailable")
}

func TestSettleManaged_HeldFreshMirrorSkipsRead(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	synced := time.Now().UnixMilli()
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{OnchainSyncedAt: synced}))
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, store, "0xpending", voucher)
	rpc := &managedRPC{balance: bigInt(7777)}

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, newManagedSigner(t, rpc)),
		voucherEnvelope(cfg, voucher, "0xpending"), managedRequirements(auth.addr), nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if rpc.tryAggregate != 0 || got.Balance != "10000" || got.OnchainSyncedAt != synced || got.ChargedCumulativeAmount != "2000" {
		t.Fatalf("tryAggregate=%d stored=%+v", rpc.tryAggregate, got)
	}
}

func TestSettleManaged_HeldStaleMirrorReadsOnceAndStampsSample(t *testing.T) {
	store := &countingChannelStore{InMemoryChannelStorage: storage.NewInMemoryChannelStorage[*FacilitatorChannel]()}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store.InMemoryChannelStorage, storedManagedChannel(cfg, channelId, &channelFields{OnchainSyncedAt: 1}))
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, store.InMemoryChannelStorage, "0xpending", voucher)
	rpc := &managedRPC{balance: bigInt(7777), totalClaimed: bigInt(300)}

	before := time.Now().UnixMilli()
	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, newManagedSigner(t, rpc)),
		voucherEnvelope(cfg, voucher, "0xpending"), managedRequirements(auth.addr), nil, nil)
	after := time.Now().UnixMilli()
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if rpc.tryAggregate != 1 || store.updates != 1 {
		t.Fatalf("tryAggregate=%d updates=%d, want 1 and 1", rpc.tryAggregate, store.updates)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.Balance != "7777" || got.TotalClaimed != "300" || got.OnchainSyncedAt < before || got.OnchainSyncedAt > after || got.ChargedCumulativeAmount != "2000" {
		t.Fatalf("stored %+v", got)
	}
}

func TestSettleManaged_HeldZeroTtlReadsEverySettle(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{OnchainSyncedAt: time.Now().UnixMilli() - 60_000}))
	rpc := &managedRPC{balance: bigInt(7777)}
	deps := managedDeps(t, store, store, auth, newManagedSigner(t, rpc))
	zero := int64(0)
	deps.OnchainStateTtlMs = &zero
	reqs := managedRequirements(auth.addr)

	before := time.Now().UnixMilli()
	for _, maxClaimable := range []string{"2000", "3000"} {
		voucher := voucherFields(channelId, maxClaimable, dummySig)
		acquireBound(t, store, "0xpending", voucher)
		resp, err := SettleManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, "0xpending"), reqs, nil, nil)
		if err != nil || !resp.Success {
			t.Fatalf("settle %s: %+v %v", maxClaimable, resp, err)
		}
	}
	after := time.Now().UnixMilli()
	got, _ := store.Get(context.Background(), channelId)
	if rpc.tryAggregate != 2 || got.Balance != "7777" || got.OnchainSyncedAt < before || got.OnchainSyncedAt > after || got.ChargedCumulativeAmount != "3000" {
		t.Fatalf("tryAggregate=%d stored=%+v", rpc.tryAggregate, got)
	}
}

func TestSettleManaged_HeldReadErrorChargesExistingRow(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{OnchainSyncedAt: 1}))
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, store, "0xpending", voucher)
	rpc := &managedRPC{readFail: true}

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, newManagedSigner(t, rpc)),
		voucherEnvelope(cfg, voucher, "0xpending"), managedRequirements(auth.addr), nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.Balance != "10000" || got.OnchainSyncedAt != 1 || got.ChargedCumulativeAmount != "2000" {
		t.Fatalf("stored %+v", got)
	}
}

func TestSettleManaged_HeldReadErrorWithoutRowFails(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "1000", dummySig)
	acquireBound(t, store, "0xpending", voucher)
	rpc := &managedRPC{readFail: true}

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, newManagedSigner(t, rpc)),
		voucherEnvelope(cfg, voucher, "0xpending"), managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRpcReadFailed {
		t.Fatalf("got %+v", resp)
	}
	if got, _ := store.Get(context.Background(), channelId); got != nil {
		t.Fatalf("stored %+v, want no row", got)
	}
}

func TestSettleManaged_HeldMissingRowCreatedInOneCommit(t *testing.T) {
	store := &countingChannelStore{InMemoryChannelStorage: storage.NewInMemoryChannelStorage[*FacilitatorChannel]()}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "1500", dummySig)
	acquireBound(t, store.InMemoryChannelStorage, "0xpending", voucher)
	rpc := &managedRPC{balance: bigInt(7777), totalClaimed: bigInt(500)}

	before := time.Now().UnixMilli()
	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, newManagedSigner(t, rpc)),
		voucherEnvelope(cfg, voucher, "0xpending"), managedRequirements(auth.addr), nil, nil)
	after := time.Now().UnixMilli()
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if rpc.tryAggregate != 1 || store.updates != 1 {
		t.Fatalf("tryAggregate=%d updates=%d, want 1 and 1", rpc.tryAggregate, store.updates)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.ChargedCumulativeAmount != "1500" || got.Balance != "7777" || got.TotalClaimed != "500" ||
		got.OnchainSyncedAt < before || got.OnchainSyncedAt > after || got.ChargeCount != 1 {
		t.Fatalf("stored %+v", got)
	}
}

func TestSettleManaged_HeldReadLosesToNewerRowStamp(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{OnchainSyncedAt: 1}))
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, store, "0xpending", voucher)
	rpc := &managedRPC{balance: bigInt(7777)}
	signer := newManagedSigner(t, rpc)
	read := signer.readContract
	var newer int64
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == evm.FunctionTryAggregate {
			newer = time.Now().UnixMilli() + 60_000
			seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{Balance: "5555", OnchainSyncedAt: newer}))
		}
		return read(functionName, args...)
	}

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucher, "0xpending"), managedRequirements(auth.addr), nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.Balance != "5555" || got.OnchainSyncedAt != newer || got.ChargedCumulativeAmount != "2000" {
		t.Fatalf("stored %+v", got)
	}
}

func TestSettleManaged_UnheldAcquiresFreshOwnerAndMirrorsVerifyRead(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{OnchainSyncedAt: 1}))
	voucher := voucherFields(channelId, "2000", dummySig)
	rpc := &managedRPC{balance: bigInt(7777)}
	signer := newManagedSigner(t, rpc)
	deps := managedDeps(t, store, store, auth, signer)
	reqs := managedRequirements(auth.addr)
	probed := false
	var during *x402.VerifyResponse
	read := signer.readContract
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == evm.FunctionTryAggregate && !probed {
			probed = true
			during, _ = VerifyManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, ""), reqs, nil)
		}
		return read(functionName, args...)
	}

	before := time.Now().UnixMilli()
	resp, err := SettleManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, "0xstale"), reqs, nil, nil)
	after := time.Now().UnixMilli()
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if during == nil || during.InvalidReason != ErrChannelBusy {
		t.Fatalf("verify during settle = %+v, want %s", during, ErrChannelBusy)
	}
	held, _ := store.IsHeld(context.Background(), channelId, "")
	got, _ := store.Get(context.Background(), channelId)
	if held || rpc.tryAggregate != 1 {
		t.Fatalf("held=%v tryAggregate=%d, want released and 1", held, rpc.tryAggregate)
	}
	if got.Balance != "7777" || got.OnchainSyncedAt < before || got.OnchainSyncedAt > after || got.ChargedCumulativeAmount != "2000" {
		t.Fatalf("stored %+v", got)
	}
}

func TestSettleManaged_UnheldAcquireErrorFailsBeforeVerify(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, acquireErr: errors.New("lock store down")}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, inner, storedManagedChannel(cfg, channelId, nil))
	rpc := &managedRPC{}

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, newManagedSigner(t, rpc)),
		voucherEnvelope(cfg, voucherFields(channelId, "2000", dummySig), ""), managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRpcReadFailed || rpc.tryAggregate != 0 {
		t.Fatalf("got %+v tryAggregate=%d", resp, rpc.tryAggregate)
	}
	got, _ := inner.Get(context.Background(), channelId)
	if got.ChargedCumulativeAmount != "1000" {
		t.Fatalf("charged = %q, want 1000", got.ChargedCumulativeAmount)
	}
}

func TestSettleManagedDeposit_ConfirmedReadStampsItsSample(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "06")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "0", Balance: "0", OnchainSyncedAt: 1,
	}))
	deps := managedDeps(t, store, store, auth, depositSignerWithBalances(t, 0, 0, 1000))

	before := time.Now().UnixMilli()
	resp, err := SettleManaged(context.Background(), deps, signedManagedDeposit(t, cfg, channelId), managedRequirements(auth.addr), nil, nil)
	after := time.Now().UnixMilli()
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.OnchainSyncedAt < before || got.OnchainSyncedAt > after || got.Balance != "1000" || got.ChargedCumulativeAmount != "1000" {
		t.Fatalf("stored %+v", got)
	}
}

func TestSettleManagedDeposit_ReconciledReplayDoesNotDoubleCharge(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "08")
	channelId := mustChannelId(t, cfg)
	signer := depositSignerWithBalances(t, 0, 1000)
	writes := 0
	write := signer.writeContract
	signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
		writes++
		return write(functionName, args...)
	}
	deps := managedDeps(t, store, store, auth, signer)
	payload := signedManagedDeposit(t, cfg, channelId)

	first, err := SettleManaged(context.Background(), deps, payload, managedRequirements(auth.addr), nil, nil)
	if err != nil || !first.Success {
		t.Fatalf("first: %+v %v", first, err)
	}
	dp, err := batchsettlement.DepositPayloadFromMap(payload.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := deps.PendingStore.Set(context.Background(), depositSettlementCacheKey(dp, batchsettlement.AssetTransferMethodEip3009), successTxHash); err != nil {
		t.Fatal(err)
	}

	second, err := SettleManaged(context.Background(), deps, payload, managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if second.Success || second.ErrorReason != ErrCumulativeAmountMismatch || second.Transaction != successTxHash {
		t.Fatalf("replay: %+v", second)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.ChargedCumulativeAmount != "1000" || writes != 1 {
		t.Fatalf("charged=%s writes=%d", got.ChargedCumulativeAmount, writes)
	}
}

func TestSettleManagedDeposit_ActualAboveAcceptedDoesNotBroadcast(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "09")
	channelId := mustChannelId(t, cfg)
	signer := depositSignerWithBalances(t, 0, 1000)
	writes := 0
	write := signer.writeContract
	signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
		writes++
		return write(functionName, args...)
	}
	deps := managedDeps(t, store, store, auth, signer)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "2000"

	resp, err := SettleManaged(context.Background(), deps, signedManagedDeposit(t, cfg, channelId), reqs, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrChargeExceedsSignedCumulative || writes != 0 {
		t.Fatalf("got %+v writes=%d", resp, writes)
	}
	if got, _ := store.Get(context.Background(), channelId); got != nil {
		t.Fatalf("stored %+v", got)
	}
}

func TestSettleManagedDeposit_OptimisticKeepsStoredStamp(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "06")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "0", Balance: "500", OnchainSyncedAt: 12_345,
	}))
	deps := managedDeps(t, store, store, auth, depositSignerWithBalances(t, 500, 500))

	resp, err := SettleManaged(context.Background(), deps, signedManagedDeposit(t, cfg, channelId), managedRequirements(auth.addr), nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.OnchainSyncedAt != 12_345 || got.Balance != "1500" {
		t.Fatalf("stored %+v", got)
	}
}

func TestSettleManagedDeposit_ReconcileKeepsStoredStamp(t *testing.T) {
	cases := []struct {
		name         string
		seedRow      bool
		wantSyncedAt int64
	}{
		{name: "existing row keeps its stamp", seedRow: true, wantSyncedAt: 12_345},
		{name: "new row has no stamp", seedRow: false, wantSyncedAt: 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
			auth := managedAuthorizer()
			cfg := managedConfig(auth.addr, "07")
			channelId := mustChannelId(t, cfg)
			if tc.seedRow {
				seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
					ChargedCumulativeAmount: "0", Balance: "500", OnchainSyncedAt: 12_345,
				}))
			}
			deps := managedDeps(t, store, store, auth, depositSignerWithBalances(t, 1500, 1500))
			payload := signedManagedDeposit(t, cfg, channelId)
			dp, err := batchsettlement.DepositPayloadFromMap(payload.Payload)
			if err != nil {
				t.Fatal(err)
			}
			if err := deps.PendingStore.Set(context.Background(), depositSettlementCacheKey(dp, batchsettlement.AssetTransferMethodEip3009), successTxHash); err != nil {
				t.Fatal(err)
			}

			resp, err := SettleManaged(context.Background(), deps, payload, managedRequirements(auth.addr), nil, nil)
			if err != nil || !resp.Success {
				t.Fatalf("got %+v %v", resp, err)
			}
			got, _ := store.Get(context.Background(), channelId)
			if got.OnchainSyncedAt != tc.wantSyncedAt || got.Balance != "1500" {
				t.Fatalf("stored %+v", got)
			}
		})
	}
}

func TestVerifyManaged_ClearedEoaVoucherSkipsTypedDataCheck(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	cfg.PayerAuthorizer = managedPayer
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{OnchainSyncedAt: 1}))
	sig := eoaVoucherSignature(t, channelId, "2000", managedNetwork)
	rpc := &managedRPC{}
	signer := chainIdFailingSigner{newManagedSigner(t, rpc)}

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "2000", sig), ""), managedRequirements(auth.addr), nil)
	if err != nil || !resp.IsValid {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if rpc.tryAggregate != 1 || got.OnchainSyncedAt != 1 {
		t.Fatalf("tryAggregate=%d onchainSyncedAt=%d, want 1 and 1", rpc.tryAggregate, got.OnchainSyncedAt)
	}
}

func TestVerifyManaged_ForgedEoaVoucherRejectedBeforeAcquire(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, acquireErr: errors.New("lock store down")}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	cfg.PayerAuthorizer = managedPayer
	channelId := mustChannelId(t, cfg)
	forged := voucherFields(channelId, "2000", eoaVoucherSignature(t, channelId, "1000", managedNetwork))
	rpc := &managedRPC{}

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, newManagedSigner(t, rpc)),
		voucherEnvelope(cfg, forged, ""), managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrVoucherSignatureInvalid || rpc.tryAggregate != 0 {
		t.Fatalf("got %+v tryAggregate=%d", resp, rpc.tryAggregate)
	}
}

func TestVerifyManaged_ForgedAcceptedAmountRejectedBeforeAcquire(t *testing.T) {
	auth := managedAuthorizer()
	reqs := managedRequirements(auth.addr)

	t.Run("voucher", func(t *testing.T) {
		inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
		store := &hookStore{inner: inner, acquireErr: errors.New("lock store down")}
		cfg := managedConfig(auth.addr, "00")
		channelId := mustChannelId(t, cfg)
		payload := voucherEnvelope(cfg, voucherFields(channelId, "2000", dummySig), "")
		payload.Accepted.Amount = "1"

		resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil), payload, reqs, nil)
		if err != nil {
			t.Fatal(err)
		}
		if resp.IsValid || resp.InvalidReason != ErrInvalidPayload {
			t.Fatalf("got %+v", resp)
		}
	})

	t.Run("deposit", func(t *testing.T) {
		inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
		store := &hookStore{inner: inner, acquireErr: errors.New("lock store down")}
		cfg := managedConfig(auth.addr, "01")
		channelId := mustChannelId(t, cfg)
		payload := managedDepositEnvelope(cfg, channelId)
		payload.Accepted.Amount = "1"

		resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil), payload, reqs, nil)
		if err != nil {
			t.Fatal(err)
		}
		if resp.IsValid || resp.InvalidReason != ErrInvalidPayload {
			t.Fatalf("got %+v", resp)
		}
	})
}

// A forged channelConfig must be rejected before the lock is taken.
func TestVerifyManaged_ForgedChannelConfigRejectedBeforeAcquire(t *testing.T) {
	auth := managedAuthorizer()
	reqs := managedRequirements(auth.addr)
	cfg := managedConfig(auth.addr, "00")
	otherCfg := managedConfig(auth.addr, "01")
	otherId := mustChannelId(t, otherCfg)

	wrongReceiver := managedConfig(auth.addr, "02")
	wrongReceiver.Receiver = "0x1111111111111111111111111111111111111111"
	wrongReceiverId := mustChannelId(t, wrongReceiver)

	cases := []struct {
		name   string
		cfg    batchsettlement.ChannelConfig
		id     string
		reason string
		build  func(cfg batchsettlement.ChannelConfig, id string) types.PaymentPayload
	}{
		{name: "voucher channelId mismatch", cfg: cfg, id: otherId, reason: ErrChannelIdMismatch, build: func(c batchsettlement.ChannelConfig, id string) types.PaymentPayload {
			return voucherEnvelope(c, voucherFields(id, "1000", dummySig), "")
		}},
		{name: "voucher receiver mismatch", cfg: wrongReceiver, id: wrongReceiverId, reason: ErrReceiverMismatch, build: func(c batchsettlement.ChannelConfig, id string) types.PaymentPayload {
			return voucherEnvelope(c, voucherFields(id, "1000", dummySig), "")
		}},
		{name: "refund channelId mismatch", cfg: cfg, id: otherId, reason: ErrChannelIdMismatch, build: func(c batchsettlement.ChannelConfig, id string) types.PaymentPayload {
			return refundEnvelope(c, voucherFields(id, "1000", dummySig), "", "", "")
		}},
		{name: "deposit channelId mismatch", cfg: cfg, id: otherId, reason: ErrChannelIdMismatch, build: managedDepositEnvelope},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
			store := &hookStore{inner: inner}
			payload := tc.build(tc.cfg, tc.id)
			caseReqs := reqs
			if batchsettlement.IsRefundPayload(payload.Payload) {
				caseReqs.Amount = "0"
				payload.Accepted.Amount = "0"
			}
			runForgedConfigCase(t, store, inner, auth, payload, caseReqs, tc.id, tc.reason)
		})
	}
}

func runForgedConfigCase(
	t *testing.T,
	store *hookStore,
	inner *storage.InMemoryChannelStorage[*FacilitatorChannel],
	auth *fakeAuthorizerSigner,
	payload types.PaymentPayload,
	reqs types.PaymentRequirements,
	channelId, wantReason string,
) {
	t.Helper()
	rpc := &managedRPC{}
	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, newManagedSigner(t, rpc)), payload, reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != wantReason {
		t.Fatalf("got %+v, want reason %s", resp, wantReason)
	}
	if store.acquireCalls != 0 || rpc.tryAggregate != 0 {
		t.Fatalf("acquire calls = %d, tryAggregate = %d, want none before stateless validation", store.acquireCalls, rpc.tryAggregate)
	}
	if held, _ := inner.IsHeld(context.Background(), channelId, ""); held {
		t.Fatal("lock must stay free")
	}
}

func TestVerifyManaged_ForgedEoaRefundRejectedBeforeAcquire(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	cfg.PayerAuthorizer = managedPayer
	channelId := mustChannelId(t, cfg)
	forged := voucherFields(channelId, "1000", eoaVoucherSignature(t, channelId, "999", managedNetwork))
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "0"
	payload := refundEnvelope(cfg, forged, "", "", "")
	payload.Accepted.Amount = "0"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil), payload, reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrVoucherSignatureInvalid {
		t.Fatalf("got %+v", resp)
	}
	if store.acquireCalls != 0 {
		t.Fatalf("acquire calls = %d, want 0", store.acquireCalls)
	}
	if held, _ := inner.IsHeld(context.Background(), channelId, ""); held {
		t.Fatal("lock must stay free")
	}
}

func TestVerifyManaged_ClearedEoaRefundSkipsTypedDataCheck(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	cfg.PayerAuthorizer = managedPayer
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{ChargedCumulativeAmount: "1000"}))
	sig := eoaVoucherSignature(t, channelId, "1000", managedNetwork)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "0"
	payload := refundEnvelope(cfg, voucherFields(channelId, "1000", sig), "", "", "")
	payload.Accepted.Amount = "0"
	signer := chainIdFailingSigner{newManagedSigner(t, &managedRPC{})}

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, signer), payload, reqs, nil)
	if err != nil || !resp.IsValid {
		t.Fatalf("got %+v %v", resp, err)
	}
}

func TestManaged_UnclearedVouchersRunTypedDataCheck(t *testing.T) {
	auth := managedAuthorizer()
	reqs := managedRequirements(auth.addr)
	eoaCfg := managedConfig(auth.addr, "00")
	eoaCfg.PayerAuthorizer = managedPayer
	eoaId := mustChannelId(t, eoaCfg)
	eoaVoucher := voucherFields(eoaId, "2000", eoaVoucherSignature(t, eoaId, "2000", managedNetwork))
	zeroCfg := managedConfig(auth.addr, "01")
	zeroId := mustChannelId(t, zeroCfg)

	cases := []struct {
		name string
		run  func(deps VoucherStoreDeps) (string, error)
	}{
		{name: "zero authorizer verify", run: func(deps VoucherStoreDeps) (string, error) {
			resp, err := VerifyManaged(context.Background(), deps, voucherEnvelope(zeroCfg, voucherFields(zeroId, "2000", dummySig), ""), reqs, nil)
			if err != nil {
				return "", err
			}
			return resp.InvalidReason, nil
		}},
		{name: "refund verify", run: func(deps VoucherStoreDeps) (string, error) {
			resp, err := VerifyManaged(context.Background(), deps, refundEnvelope(zeroCfg, voucherFields(zeroId, "2000", dummySig), "", "", ""), reqs, nil)
			if err != nil {
				return "", err
			}
			return resp.InvalidReason, nil
		}},
		{name: "unheld settle", run: func(deps VoucherStoreDeps) (string, error) {
			resp, err := SettleManaged(context.Background(), deps, voucherEnvelope(eoaCfg, eoaVoucher, ""), reqs, nil, nil)
			if err != nil {
				return "", err
			}
			return resp.ErrorReason, nil
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
			signer := chainIdFailingSigner{newManagedSigner(t, nil)}
			reason, err := tc.run(managedDeps(t, store, store, auth, signer))
			if err != nil {
				t.Fatal(err)
			}
			if reason != ErrChannelStateReadFailed {
				t.Fatalf("reason = %q, want %q", reason, ErrChannelStateReadFailed)
			}
		})
	}
}

func TestSettleManaged_RefundReadFailureFailsClosed(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedIdentityConfig(auth.addr)
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "1000",
		Balance:                 "10000",
		ChargeCount:             3,
	}))
	signer := newManagedSigner(t, &managedRPC{readFail: true})
	deps := managedDeps(t, store, store, auth, signer)
	bindManagedIdentity(t, deps.DelegatedAuthStore, channelId, "svc")
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "svc", nil }

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", ""),
		managedIdentityRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp == nil || resp.Success || resp.ErrorReason != ErrRpcReadFailed || resp.Transaction != "" {
		t.Fatalf("got %+v", resp)
	}
	if signer.writeCalls != 0 {
		t.Fatalf("writes = %d", signer.writeCalls)
	}
	got, err := store.Get(context.Background(), channelId)
	if err != nil || got.Balance != "10000" || got.RefundNonce != 0 || got.ChargeCount != 3 || got.PendingClaim != nil {
		t.Fatalf("stored %+v %v", got, err)
	}
}

func TestVerifyManaged_MalformedRequirementsAmountOnCachedPath(t *testing.T) {
	for _, amount := range []string{"", "abc", "-5", "+5", " 5 ", "1.5", "0x10", "1_0"} {
		t.Run(amount, func(t *testing.T) {
			store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
			auth := managedAuthorizer()
			cfg := managedConfig(auth.addr, "00")
			cfg.PayerAuthorizer = managedPayer
			channelId := mustChannelId(t, cfg)
			sig := eoaVoucherSignature(t, channelId, "2000", managedNetwork)
			seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
				Balance:            "10000",
				TotalClaimed:       "0",
				OnchainSyncedAt:    time.Now().UnixMilli(),
				SignedMaxClaimable: "1000",
			}))
			rpc := &managedRPC{}
			signer := newManagedSigner(t, rpc)
			reqs := managedRequirements(auth.addr)
			reqs.Amount = amount
			payment := voucherEnvelope(cfg, voucherFields(channelId, "2000", sig), "")
			payment.Accepted.Amount = amount

			resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, signer), payment, reqs, nil)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if resp.IsValid || resp.InvalidReason != ErrInvalidVoucherPayload {
				t.Fatalf("got %+v, want %s", resp, ErrInvalidVoucherPayload)
			}
		})
	}
}

func TestReadExtraTotalClaimed(t *testing.T) {
	cases := []struct {
		name  string
		value interface{}
		want  string
		ok    bool
	}{
		{"zero string", "0", "0", true},
		{"plain string", "19200", "19200", true},
		{"leading zeros", "007", "", false},
		{"signed", "+5", "", false},
		{"negative", "-1", "", false},
		{"whitespace", " 5", "", false},
		{"empty", "", "", false},
		{"float64 integer", float64(42), "42", true},
		{"float64 max safe", float64(1<<53 - 1), "9007199254740991", true},
		{"float64 above safe", float64(1 << 53), "", false},
		{"float64 fractional", 1.5, "", false},
		{"float64 negative", float64(-1), "", false},
		{"float64 NaN", math.NaN(), "", false},
		{"float64 Inf", math.Inf(1), "", false},
		{"missing", nil, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			extra := map[string]interface{}{}
			if tc.value != nil {
				extra["totalClaimed"] = tc.value
			}
			got, ok := readExtraTotalClaimed(extra)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("readExtraTotalClaimed(%v) = (%q, %v), want (%q, %v)", tc.value, got, ok, tc.want, tc.ok)
			}
		})
	}
}

// hotRefund drives a client-requested managed refund against a channel with unclaimed charges.
type hotRefund struct {
	t         *testing.T
	store     storage.ChannelStorage[*FacilitatorChannel]
	inner     *storage.InMemoryChannelStorage[*FacilitatorChannel]
	signer    *fakeFacilitatorSigner
	deps      VoucherStoreDeps
	cfg       batchsettlement.ChannelConfig
	channelID string
	charged   string
	reqs      types.PaymentRequirements
	// onWrite runs inside the first onchain write, after the refund was built.
	onWrite func()
	// refundAmount is the amount of the last single refundWithSignature write.
	refundAmount *big.Int
}

func newHotRefund(t *testing.T, fields *channelFields, planted *PendingClaim, wrap func(*storage.InMemoryChannelStorage[*FacilitatorChannel]) storage.ChannelStorage[*FacilitatorChannel]) *hotRefund {
	t.Helper()
	auth := managedAuthorizer()
	packed, err := batchsettlement.PackRefundAuthorizerSalt("0x"+strings.Repeat("11", 12), auth.addr)
	if err != nil {
		t.Fatal(err)
	}
	cfg := managedConfig(auth.addr, "00")
	cfg.Salt = packed
	channelID := mustChannelId(t, cfg)
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	row := storedManagedChannel(cfg, channelID, fields)
	row.PendingClaim = planted
	seedManagedChannel(t, inner, row)
	var store storage.ChannelStorage[*FacilitatorChannel] = inner
	if wrap != nil {
		store = wrap(inner)
	}
	signer := newManagedSigner(t, nil)
	h := &hotRefund{t: t, store: store, inner: inner, signer: signer, cfg: cfg, channelID: channelID, charged: row.ChargedCumulativeAmount}
	orig := signer.writeContract
	signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
		if functionName == "refundWithSignature" {
			for _, arg := range args {
				if n, ok := arg.(*big.Int); ok {
					h.refundAmount = n
					break
				}
			}
		}
		if h.onWrite != nil {
			h.onWrite()
		}
		return orig(functionName, args...)
	}
	h.deps = managedDeps(t, store, store.(storage.ChannelLockStorage), auth, signer)
	h.deps.SettleTargetStorage = storage.NewInMemorySettleTargetStorage()
	h.reqs = managedRequirements(auth.addr)
	h.reqs.Extra["refundAuthorizer"] = auth.addr
	return h
}

func (h *hotRefund) settle(amount string) (*x402.SettleResponse, error) {
	h.t.Helper()
	return h.settleWithPendingID(amount, "")
}

func (h *hotRefund) settleWithPendingID(amount, pendingID string) (*x402.SettleResponse, error) {
	h.t.Helper()
	_, sig := signRefundConsent(h.t, h.channelID, amount, "0", managedNetwork)
	return SettleManaged(context.Background(), h.deps,
		refundEnvelope(h.cfg, voucherFields(h.channelID, h.charged, dummySig), amount, pendingID, sig),
		h.reqs, nil, nil)
}

func (h *hotRefund) row() *FacilitatorChannel {
	h.t.Helper()
	got, err := h.inner.Get(context.Background(), h.channelID)
	if err != nil || got == nil {
		h.t.Fatalf("row missing: %v", err)
	}
	return got
}

func workerMarker() *PendingClaim {
	return &PendingClaim{AttestedCount: 4, ClaimedTo: "3000", StartedAt: time.Now().UnixMilli()}
}

func unclaimedFields() *channelFields {
	return &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		Balance:                 "10000",
		TotalClaimed:            "1000",
		ChargeCount:             6,
	}
}

func TestSettleManaged_RefundWithLiveWorkerMarkerSendsRefundOnly(t *testing.T) {
	marker := workerMarker()
	h := newHotRefund(t, unclaimedFields(), marker, nil)
	resp, err := h.settle("5000")
	if err != nil || resp == nil || !resp.Success {
		t.Fatalf("refund %+v %v", resp, err)
	}
	if !reflect.DeepEqual(h.signer.writeFns, []string{"refundWithSignature"}) {
		t.Fatalf("writes = %v, want the refund alone", h.signer.writeFns)
	}
	got := h.row()
	if got.PendingClaim == nil || *got.PendingClaim != *marker || got.ChargeCount != 6 {
		t.Fatalf("worker marker changed: %+v", got)
	}
	if got.ChargedCumulativeAmount != "5000" || got.Signature != dummySig || got.SignedMaxClaimable != "5000" {
		t.Fatalf("voucher not kept for the worker: %+v", got)
	}
	item := attestedClaim{ChannelID: h.channelID, Count: marker.AttestedCount, ClaimedTo: marker.ClaimedTo, StartedAt: marker.StartedAt}
	if err := finishAttestedClaim(context.Background(), h.inner, h.channelID, "3000", item, true); err != nil {
		t.Fatal(err)
	}
	if got := h.row(); got.PendingClaim != nil || got.ChargeCount != 2 {
		t.Fatalf("after worker finish: %+v", got)
	}
}

func TestSettleManaged_RefundOnlyCapsPartialAmountAtUnchargedBalance(t *testing.T) {
	h := newHotRefund(t, unclaimedFields(), workerMarker(), nil)
	resp, err := h.settle("9000")
	if err != nil || resp == nil || !resp.Success {
		t.Fatalf("refund %+v %v", resp, err)
	}
	if h.refundAmount == nil || h.refundAmount.String() != "5000" {
		t.Fatalf("refund amount = %v, want balance - charged = 5000", h.refundAmount)
	}
}

func TestSettleManaged_RefundWithoutUnchargedBalanceFails(t *testing.T) {
	fields := unclaimedFields()
	fields.ChargedCumulativeAmount = "10000"
	fields.SignedMaxClaimable = "10000"
	h := newHotRefund(t, fields, nil, nil)
	resp, err := h.settle("100")
	if err != nil || resp == nil || resp.Success || resp.ErrorReason != ErrRefundNoBalance {
		t.Fatalf("refund %+v %v", resp, err)
	}
	if len(h.signer.writeFns) != 0 || h.row().PendingClaim != nil {
		t.Fatalf("writes=%v row=%+v", h.signer.writeFns, h.row())
	}
}

func TestSettleManaged_RefundBundlesClaimWhenIdle(t *testing.T) {
	h := newHotRefund(t, unclaimedFields(), nil, nil)
	resp, err := h.settle("5000")
	if err != nil || resp == nil || !resp.Success {
		t.Fatalf("refund %+v %v", resp, err)
	}
	if !reflect.DeepEqual(h.signer.writeFns, []string{"multicall"}) {
		t.Fatalf("writes = %v, want one multicall", h.signer.writeFns)
	}
	if got := h.row(); got.PendingClaim != nil || got.ChargeCount != 0 || got.TotalClaimed != "5000" {
		t.Fatalf("after bundled claim: %+v", got)
	}
}

func TestSettleManaged_RefundAttestsChargeCountInMetadata(t *testing.T) {
	h := newHotRefund(t, unclaimedFields(), nil, nil)
	stub := &stubBuilderCode{}
	_, sig := signRefundConsent(h.t, h.channelID, "5000", "0", managedNetwork)
	resp, err := SettleManaged(context.Background(), h.deps,
		refundEnvelope(h.cfg, voucherFields(h.channelID, h.charged, dummySig), "5000", "", sig),
		h.reqs, recordingContext(stub), nil)
	if err != nil || resp == nil || !resp.Success {
		t.Fatalf("refund %+v %v", resp, err)
	}
	if counts := stub.chargeCounts(); !reflect.DeepEqual(counts, []uint64{6}) {
		t.Fatalf("counts = %v, want [6]", counts)
	}
	if got := h.row(); got.PendingClaim != nil || got.ChargeCount != 0 {
		t.Fatalf("after bundled claim: %+v", got)
	}
}

func TestSettleManaged_RefundNoOpClaimLegKeepsChargeCountPending(t *testing.T) {
	h := newHotRefund(t, unclaimedFields(), nil, nil)
	orig := h.signer.waitForReceipt
	h.signer.waitForReceipt = func(txHash string) (*evm.TransactionReceipt, error) {
		receipt, err := orig(txHash)
		if receipt == nil {
			return receipt, err
		}
		// The claim leg emitted no Claimed event.
		stripped := *receipt
		stripped.Logs = nil
		return &stripped, err
	}
	resp, err := h.settle("5000")
	if err != nil || resp == nil || !resp.Success {
		t.Fatalf("refund %+v %v", resp, err)
	}
	if got := h.row(); got.PendingClaim != nil || got.ChargeCount != 6 {
		t.Fatalf("a no-op claim leg must keep its count pending: %+v", got)
	}
}

// commitBeforeBegin commits a voucher the first time the refund touches the row.
type commitBeforeBegin struct {
	*storage.InMemoryChannelStorage[*FacilitatorChannel]
	once   sync.Once
	commit func()
}

func (s *commitBeforeBegin) UpdateChannel(ctx context.Context, channelID string, update func(*FacilitatorChannel) *FacilitatorChannel) (*storage.ChannelUpdateResult[*FacilitatorChannel], error) {
	s.once.Do(s.commit)
	return s.InMemoryChannelStorage.UpdateChannel(ctx, channelID, update)
}

func TestSettleManaged_RefundRejectsVoucherCommittedBeforeBegin(t *testing.T) {
	var h *hotRefund
	h = newHotRefund(t, unclaimedFields(), nil, func(inner *storage.InMemoryChannelStorage[*FacilitatorChannel]) storage.ChannelStorage[*FacilitatorChannel] {
		return &commitBeforeBegin{InMemoryChannelStorage: inner, commit: func() {
			commitVoucher(t, inner, h.channelID, "6000", "0xnewer")
		}}
	})
	resp, err := h.settle("5000")
	if err != nil || resp == nil || resp.Success || resp.ErrorReason != ErrCumulativeAmountMismatch {
		t.Fatalf("refund %+v %v", resp, err)
	}
	if len(h.signer.writeFns) != 0 {
		t.Fatalf("writes = %v, want none", h.signer.writeFns)
	}
	if got := h.row(); got.PendingClaim != nil || got.ChargeCount != 7 {
		t.Fatalf("row = %+v", got)
	}
}

func TestSettleManaged_RefundDoesNotLowerConcurrentTotalClaimed(t *testing.T) {
	h := newHotRefund(t, unclaimedFields(), workerMarker(), nil)
	h.onWrite = func() {
		_, err := h.inner.UpdateChannel(context.Background(), h.channelID, func(current *FacilitatorChannel) *FacilitatorChannel {
			next := current.Clone()
			next.TotalClaimed = "4000"
			return next
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	resp, err := h.settle("5000")
	if err != nil || resp == nil || !resp.Success {
		t.Fatalf("refund %+v %v", resp, err)
	}
	if got := h.row(); got.TotalClaimed != "4000" {
		t.Fatalf("totalClaimed = %s, want 4000 kept", got.TotalClaimed)
	}
}
