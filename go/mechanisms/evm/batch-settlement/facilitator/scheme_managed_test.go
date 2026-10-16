package facilitator

import (
	"bytes"
	"context"
	"math/big"
	"strings"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestScheme_DirectSubmitModeRequiresSubmitter(t *testing.T) {
	_, err := NewBatchSettlementEvmSchemeWithConfig(
		&fakeFacilitatorSigner{addresses: []string{managedFacilitator}},
		managedAuthorizer(),
		&BatchSettlementEvmSchemeConfig{SubmitMode: SubmitModeDirect},
	)
	if err == nil || !strings.Contains(err.Error(), `submitMode "direct" requires authorizerSubmitter`) {
		t.Fatalf("got %v", err)
	}
}

func TestScheme_DirectSubmitModeRejectsMismatchedSubmitter(t *testing.T) {
	_, err := NewBatchSettlementEvmSchemeWithConfig(
		&fakeFacilitatorSigner{addresses: []string{managedFacilitator}},
		managedAuthorizer(),
		&BatchSettlementEvmSchemeConfig{
			SubmitMode:          SubmitModeDirect,
			AuthorizerSubmitter: &fakeFacilitatorSigner{addresses: []string{managedFacilitator}},
		},
	)
	if err == nil || !strings.Contains(err.Error(), "authorizerSubmitter.getAddresses() must be exactly [authorizerSigner.address]") {
		t.Fatalf("got %v", err)
	}
}

func TestScheme_GetExtraAdvertisesVoucherStore(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(
		newManagedSigner(t, nil),
		managedAuthorizer(),
		&BatchSettlementEvmSchemeConfig{
			VoucherStore: &VoucherStoreConfig{Storage: store},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	got := scheme.GetExtra(x402.Network(managedNetwork))
	managers, _ := got["voucherManager"].([]string)
	if len(managers) != 2 || managers[0] != "server" || managers[1] != "facilitator" {
		t.Fatalf("extra = %+v", got)
	}
	if _, has := got["voucherStore"]; has {
		t.Fatalf("legacy voucherStore must not be advertised: %+v", got)
	}
	if _, has := got["refundAuthorizer"]; has {
		t.Fatalf("refundAuthorizer must be omitted when not configured: %+v", got)
	}
	if got["withdrawDelay"] != 900 {
		t.Fatalf("withdrawDelay = %v", got["withdrawDelay"])
	}
}

func TestScheme_VoucherStoreRequiresAuthorizer(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	_, err := NewBatchSettlementEvmSchemeWithConfig(
		newManagedSigner(t, nil),
		nil,
		&BatchSettlementEvmSchemeConfig{
			VoucherStore: &VoucherStoreConfig{Storage: store},
		},
	)
	if err == nil || !strings.Contains(err.Error(), "voucherStore requires authorizerSigner") {
		t.Fatalf("got %v", err)
	}
}

func TestScheme_ManagedVerifyUnavailableWithoutStore(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(newManagedSigner(t, nil), managedAuthorizer())
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	resp, err := scheme.Verify(context.Background(),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrVoucherStoreUnavailable {
		t.Fatalf("got %+v", resp)
	}
}

func TestScheme_ManagedSettleUnavailableWithoutStore(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(newManagedSigner(t, nil), managedAuthorizer())
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	resp, err := scheme.Settle(context.Background(),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrVoucherStoreUnavailable {
		t.Fatalf("got %+v", resp)
	}
}

func TestScheme_CreateChannelManagerRequiresStore(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(newManagedSigner(t, nil), managedAuthorizer())
	_, err := scheme.CreateChannelManager(nil)
	if err == nil || !strings.Contains(err.Error(), "voucherStore") {
		t.Fatalf("got %v", err)
	}
}

func TestScheme_CreateChannelManagerWithStore(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(
		newManagedSigner(t, nil),
		managedAuthorizer(),
		&BatchSettlementEvmSchemeConfig{VoucherStore: &VoucherStoreConfig{Storage: store}},
	)
	if err != nil {
		t.Fatal(err)
	}
	mgr, err := scheme.CreateChannelManager(nil)
	if err != nil || mgr == nil {
		t.Fatalf("mgr=%v err=%v", mgr, err)
	}
}

func TestScheme_ManagedClaimAfterClaim(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Signature:               "0xcafe",
		ChargeCount:             4,
	}))
	signer := newManagedSigner(t, nil)
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(signer, auth, &BatchSettlementEvmSchemeConfig{
		VoucherStore: &VoucherStoreConfig{Storage: store},
	})
	if err != nil {
		t.Fatal(err)
	}
	claim := batchsettlement.BatchSettlementVoucherClaim{Signature: "0xcafe", TotalClaimed: "1000"}
	claim.Voucher.Channel = cfg
	claim.Voucher.MaxClaimableAmount = "1000"
	payload := managedEnvelope((&batchsettlement.BatchSettlementClaimPayload{
		Type:   "claim",
		Claims: []batchsettlement.BatchSettlementVoucherClaim{claim},
	}).ToMap())

	stub := &stubBuilderCode{}
	resp, err := scheme.Settle(context.Background(), payload, managedRequirements(auth.addr), recordingContext(stub))
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.TotalClaimed != "1000" || got.ChargeCount != 0 {
		t.Fatalf("stored %+v", got)
	}
	if counts := stub.chargeCounts(); len(counts) != 1 || counts[0] != 4 {
		t.Fatalf("attested counts = %v", counts)
	}
}

func TestScheme_ManagedClaimNoOpRowKeepsChargeCountPending(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Signature:               "0xcafe",
		ChargeCount:             4,
	}))
	// The claim lands but its row emits no Claimed event, as if an out-of-band claim won the race.
	signer := newManagedSigner(t, &managedRPC{noopChannels: map[string]struct{}{strings.ToLower(channelId): {}}})
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(signer, auth, &BatchSettlementEvmSchemeConfig{
		VoucherStore: &VoucherStoreConfig{Storage: store},
	})
	if err != nil {
		t.Fatal(err)
	}
	claim := batchsettlement.BatchSettlementVoucherClaim{Signature: "0xcafe", TotalClaimed: "1000"}
	claim.Voucher.Channel = cfg
	claim.Voucher.MaxClaimableAmount = "1000"
	payload := managedEnvelope((&batchsettlement.BatchSettlementClaimPayload{
		Type:   "claim",
		Claims: []batchsettlement.BatchSettlementVoucherClaim{claim},
	}).ToMap())

	resp, err := scheme.Settle(context.Background(), payload, managedRequirements(auth.addr), builderContext(nil))
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.ChargeCount != 4 || got.PendingClaim != nil {
		t.Fatalf("no-op row must keep its count pending and clear the marker: %+v", got)
	}
}

func TestScheme_ManagedClaimComposesBuilderSuffix(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargeCount: 6, Signature: "0xcafe",
	}))
	signer := newManagedSigner(t, nil)
	var attested int
	origWrite := signer.writeContract
	signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
		row, _ := store.Get(context.Background(), channelId)
		if row != nil && row.PendingClaim != nil {
			attested = row.PendingClaim.AttestedCount
		}
		return origWrite(functionName, args...)
	}
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(signer, auth, &BatchSettlementEvmSchemeConfig{
		VoucherStore: &VoucherStoreConfig{Storage: store},
	})
	if err != nil {
		t.Fatal(err)
	}
	claim := batchsettlement.BatchSettlementVoucherClaim{Signature: "0xcafe", TotalClaimed: "1000"}
	claim.Voucher.Channel = cfg
	claim.Voucher.MaxClaimableAmount = "1000"
	payload := managedEnvelope((&batchsettlement.BatchSettlementClaimPayload{
		Type:   "claim",
		Claims: []batchsettlement.BatchSettlementVoucherClaim{claim},
	}).ToMap())
	builder := []byte{0x80, 0x21, 0xab, 0xcd}
	stub := &stubBuilderCode{suffix: builder}

	resp, err := scheme.Settle(context.Background(), payload, managedRequirements(auth.addr), recordingContext(stub))
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if !bytes.Equal(signer.lastDataSuffix, builder) {
		t.Fatalf("suffix = %x, want the single resolved suffix %x", signer.lastDataSuffix, builder)
	}
	counts := stub.chargeCounts()
	if len(counts) != 1 || counts[0] != 6 || attested != 6 {
		t.Fatalf("counts = %v attested = %d", counts, attested)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.ChargeCount != 0 || got.PendingClaim != nil {
		t.Fatalf("stored %+v", got)
	}
}

func TestScheme_ManagedClaimSimulationLeavesStore(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{ChargeCount: 4}))
	signer := newManagedSigner(t, &managedRPC{simFail: "claimWithSignature"})
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(signer, auth, &BatchSettlementEvmSchemeConfig{
		VoucherStore: &VoucherStoreConfig{Storage: store},
	})
	if err != nil {
		t.Fatal(err)
	}
	claim := batchsettlement.BatchSettlementVoucherClaim{Signature: dummySig, TotalClaimed: "1000"}
	claim.Voucher.Channel = cfg
	claim.Voucher.MaxClaimableAmount = "1000"
	payload := managedEnvelope((&batchsettlement.BatchSettlementClaimPayload{
		Type:   "claim",
		Claims: []batchsettlement.BatchSettlementVoucherClaim{claim},
	}).ToMap())

	resp, err := scheme.Settle(context.Background(), payload, managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success {
		t.Fatalf("expected failure %+v", resp)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.ChargeCount != 4 || got.PendingClaim != nil {
		t.Fatalf("store mutated: %+v", got)
	}
}

func TestScheme_ManagedVoucherSettleIncrementsChargeCount(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	serverEOA := addressOfKey(t, serverRefundKeyHex)
	cfg := managedConfigWithRefundAuthorizer(t, auth.addr, serverEOA)
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{ChargeCount: 2}))
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(newManagedSigner(t, nil), auth, &BatchSettlementEvmSchemeConfig{
		VoucherStore: &VoucherStoreConfig{Storage: store},
	})
	if err != nil {
		t.Fatal(err)
	}
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, store, "0xpending", voucher)
	reqs := managedRequirements(auth.addr)
	reqs.Extra["refundAuthorizer"] = serverEOA
	reqs.Amount = "1000"

	resp, err := scheme.Settle(context.Background(), voucherEnvelope(cfg, voucher, "0xpending"), reqs, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if extraInt(resp, "chargeCount") != 3 {
		t.Fatalf("chargeCount = %d", extraInt(resp, "chargeCount"))
	}
}

func TestScheme_SelfManagedRefundIdentityMismatch(t *testing.T) {
	auth := managedAuthorizer()
	delegated := storage.NewInMemoryDelegatedAuthStore()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	if _, err := delegated.Bind(context.Background(), storage.DelegatedAuthBinding{
		ChannelId: channelId, Network: managedNetwork, CallerIdentity: "bound-service",
	}); err != nil {
		t.Fatal(err)
	}
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(newManagedSigner(t, nil), auth, &BatchSettlementEvmSchemeConfig{
		ResolveCallerIdentity: func(DelegatedSettleContext) (string, error) { return "other-service", nil },
		DelegatedAuthStore:    delegated,
	})
	if err != nil {
		t.Fatal(err)
	}
	payload := managedEnvelope((&batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Voucher:       voucherFields(channelId, "0", dummySig),
		Amount:        "1000",
		RefundNonce:   "0",
	}).ToMap())
	reqs := types.PaymentRequirements{
		Scheme:  batchsettlement.SchemeBatched,
		Network: managedNetwork,
		Amount:  "1000",
		Asset:   managedToken,
		PayTo:   managedReceiver,
		Extra:   map[string]interface{}{"receiverAuthorizer": auth.addr},
	}

	resp, err := scheme.Settle(context.Background(), payload, reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestScheme_SelfManagedRefundMissingBinding(t *testing.T) {
	auth := managedAuthorizer()
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(newManagedSigner(t, nil), auth, &BatchSettlementEvmSchemeConfig{
		ResolveCallerIdentity: func(DelegatedSettleContext) (string, error) { return "svc", nil },
		DelegatedAuthStore:    storage.NewInMemoryDelegatedAuthStore(),
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	payload := managedEnvelope((&batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Voucher:       voucherFields(channelId, "0", dummySig),
		Amount:        "1000",
		RefundNonce:   "0",
	}).ToMap())
	reqs := types.PaymentRequirements{
		Scheme:  batchsettlement.SchemeBatched,
		Network: managedNetwork,
		Extra:   map[string]interface{}{"receiverAuthorizer": auth.addr},
	}
	resp, err := scheme.Settle(context.Background(), payload, reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestScheme_SelfManagedRefundMalformedAmount(t *testing.T) {
	auth := managedAuthorizer()
	delegated := storage.NewInMemoryDelegatedAuthStore()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	if _, err := delegated.Bind(context.Background(), storage.DelegatedAuthBinding{ChannelId: channelId, Network: managedNetwork, CallerIdentity: "svc"}); err != nil {
		t.Fatal(err)
	}
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(newManagedSigner(t, nil), auth, &BatchSettlementEvmSchemeConfig{
		ResolveCallerIdentity: func(DelegatedSettleContext) (string, error) { return "svc", nil },
		DelegatedAuthStore:    delegated,
	})
	if err != nil {
		t.Fatal(err)
	}
	payload := managedEnvelope((&batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Voucher:       voucherFields(channelId, "0", dummySig),
		Amount:        "nope",
		RefundNonce:   "0",
	}).ToMap())
	reqs := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: managedNetwork}
	resp, err := scheme.Settle(context.Background(), payload, reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAmountInvalid {
		t.Fatalf("got %+v", resp)
	}
}

func TestScheme_DirectModeDispatchesUnsignedClaim(t *testing.T) {
	auth := managedAuthorizer()
	submitter := newManagedSigner(t, nil)
	submitter.addresses = []string{auth.addr}
	relay := newManagedSigner(t, nil)
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(relay, auth, &BatchSettlementEvmSchemeConfig{
		SubmitMode:          SubmitModeDirect,
		AuthorizerSubmitter: submitter,
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := managedConfig(auth.addr, "00")
	claim := batchsettlement.BatchSettlementVoucherClaim{Signature: dummySig, TotalClaimed: "1000"}
	claim.Voucher.Channel = cfg
	claim.Voucher.MaxClaimableAmount = "1000"
	payload := managedEnvelope((&batchsettlement.BatchSettlementClaimPayload{
		Type:   "claim",
		Claims: []batchsettlement.BatchSettlementVoucherClaim{claim},
	}).ToMap())
	reqs := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: managedNetwork}

	resp, err := scheme.Settle(context.Background(), payload, reqs, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if submitter.writeCalls == 0 {
		t.Fatal("expected authorizer submitter write")
	}
	if relay.writeCalls != 0 {
		t.Fatalf("relay writes = %d", relay.writeCalls)
	}
	if got := submitter.writeFns; len(got) == 0 || got[0] != "claim" {
		t.Fatalf("writeFns = %v", got)
	}
}

func TestScheme_DirectModeRelaysPresignedClaim(t *testing.T) {
	auth := managedAuthorizer()
	submitter := newManagedSigner(t, nil)
	submitter.addresses = []string{auth.addr}
	relay := newManagedSigner(t, nil)
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(relay, auth, &BatchSettlementEvmSchemeConfig{
		SubmitMode:          SubmitModeDirect,
		AuthorizerSubmitter: submitter,
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := managedConfig(auth.addr, "00")
	claim := batchsettlement.BatchSettlementVoucherClaim{Signature: dummySig, TotalClaimed: "1000"}
	claim.Voucher.Channel = cfg
	claim.Voucher.MaxClaimableAmount = "1000"
	payload := managedEnvelope((&batchsettlement.BatchSettlementClaimPayload{
		Type:                     "claim",
		Claims:                   []batchsettlement.BatchSettlementVoucherClaim{claim},
		ClaimAuthorizerSignature: "0x" + strings.Repeat("ab", 65),
	}).ToMap())
	reqs := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: managedNetwork}

	resp, err := scheme.Settle(context.Background(), payload, reqs, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if relay.writeCalls == 0 {
		t.Fatal("expected relay write")
	}
	if submitter.writeCalls != 0 {
		t.Fatalf("submitter writes = %d", submitter.writeCalls)
	}
}

func TestScheme_GetExtraDelegatedRefundTracksCallerIdentity(t *testing.T) {
	cases := []struct {
		name   string
		config *BatchSettlementEvmSchemeConfig
		want   bool
	}{
		{
			name: "caller identity configured",
			config: &BatchSettlementEvmSchemeConfig{
				ResolveCallerIdentity: identityResolver("svc"),
				DelegatedAuthStore:    storage.NewInMemoryDelegatedAuthStore(),
			},
			want: true,
		},
		{name: "no caller identity", config: &BatchSettlementEvmSchemeConfig{}, want: false},
		{name: "nil config", config: nil, want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scheme, err := NewBatchSettlementEvmSchemeWithConfig(newManagedSigner(t, nil), managedAuthorizer(), tc.config)
			if err != nil {
				t.Fatal(err)
			}
			got := scheme.GetExtra(x402.Network(managedNetwork))
			if got["delegatedRefund"] != tc.want {
				t.Fatalf("delegatedRefund = %v, want %v", got["delegatedRefund"], tc.want)
			}
			if _, has := got["refundAuthorizer"]; has {
				t.Fatalf("refundAuthorizer must never be advertised: %+v", got)
			}
			if _, has := got["refundAuth"]; has {
				t.Fatalf("legacy refundAuth must not be advertised: %+v", got)
			}
		})
	}
}

func TestScheme_ResolveCallerIdentityRequiresDelegatedAuthStore(t *testing.T) {
	_, err := NewBatchSettlementEvmSchemeWithConfig(newManagedSigner(t, nil), managedAuthorizer(), &BatchSettlementEvmSchemeConfig{
		ResolveCallerIdentity: func(DelegatedSettleContext) (string, error) { return "svc", nil },
	})
	if err == nil {
		t.Fatal("expected constructor error without a DelegatedAuthStore")
	}
}

func TestScheme_ManagedClaimFinishFailureKeepsMarker(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, inner, storedManagedChannel(cfg, channelId, &channelFields{
		ChargeCount: 4, Signature: "0xcafe",
	}))
	store := &allowNUpdates{InMemoryChannelStorage: inner, allow: 2}
	signer := newManagedSigner(t, nil)
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(signer, auth, &BatchSettlementEvmSchemeConfig{
		VoucherStore: &VoucherStoreConfig{Storage: store},
	})
	if err != nil {
		t.Fatal(err)
	}
	claim := batchsettlement.BatchSettlementVoucherClaim{Signature: "0xcafe", TotalClaimed: "1000"}
	claim.Voucher.Channel = cfg
	claim.Voucher.MaxClaimableAmount = "1000"
	payload := managedEnvelope((&batchsettlement.BatchSettlementClaimPayload{
		Type:   "claim",
		Claims: []batchsettlement.BatchSettlementVoucherClaim{claim},
	}).ToMap())

	resp, err := scheme.Settle(context.Background(), payload, managedRequirements(auth.addr), nil)
	if err != nil || resp == nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, err := inner.Get(context.Background(), channelId)
	if err != nil || got.ChargeCount != 4 || got.PendingClaim == nil || got.PendingClaim.AttestedCount != 4 || got.PendingClaim.ClaimedTo != "1000" {
		t.Fatalf("marker = %+v err=%v", got, err)
	}

	repairRPC := &managedRPC{totalClaimed: big.NewInt(1000), balance: big.NewInt(10000)}
	repair := newTestManager(t, newManagedSigner(t, repairRPC), inner, auth, false, nil)
	results, err := repair.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 || repair.signer.(*fakeFacilitatorSigner).writeCalls != 0 {
		t.Fatalf("repair results=%+v", results)
	}
	got, err = inner.Get(context.Background(), channelId)
	if err != nil || got.ChargeCount != 0 || got.PendingClaim != nil || got.TotalClaimed != "1000" {
		t.Fatalf("repaired %+v %v", got, err)
	}
}

func TestScheme_ManagedClaimSupersededReturnsChannelBusy(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	// The row already holds a newer voucher than the one in the claim payload.
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "1500",
		SignedMaxClaimable:      "1500",
		Signature:               "0xnewer",
		ChargeCount:             5,
	}))
	signer := newManagedSigner(t, nil)
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(signer, auth, &BatchSettlementEvmSchemeConfig{
		VoucherStore: &VoucherStoreConfig{Storage: store},
	})
	if err != nil {
		t.Fatal(err)
	}
	claim := batchsettlement.BatchSettlementVoucherClaim{Signature: "0xcafe", TotalClaimed: "1000"}
	claim.Voucher.Channel = cfg
	claim.Voucher.MaxClaimableAmount = "1000"
	payload := managedEnvelope((&batchsettlement.BatchSettlementClaimPayload{
		Type:   "claim",
		Claims: []batchsettlement.BatchSettlementVoucherClaim{claim},
	}).ToMap())

	resp, err := scheme.Settle(context.Background(), payload, managedRequirements(auth.addr), nil)
	if err != nil || resp == nil || resp.Success || resp.ErrorReason != ErrChannelBusy {
		t.Fatalf("got %+v %v", resp, err)
	}
	if signer.writeCalls != 0 {
		t.Fatalf("writeCalls = %d, want none", signer.writeCalls)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.PendingClaim != nil || got.ChargeCount != 5 || got.TotalClaimed != "0" {
		t.Fatalf("stored %+v", got)
	}
}
