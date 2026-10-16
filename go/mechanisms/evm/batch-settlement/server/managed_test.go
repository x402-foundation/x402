package server

import (
	"context"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

func buildManagedServer(t *testing.T, store SessionStorage, enforceMinDeposit bool) *BatchSettlementEvmScheme {
	t.Helper()
	if store == nil {
		store = NewInMemoryChannelStorage()
	}
	return NewBatchSettlementEvmScheme(testConfig().Receiver, &BatchSettlementEvmSchemeServerConfig{
		VoucherStoreMode:       VoucherStoreModeFacilitator,
		Storage:                store,
		EnforceMinDeposit:      enforceMinDeposit,
		RefundAuthorizerSigner: &mockAuthorizerSigner{address: "0xrefundauth", sig: []byte{0xab, 0xcd}},
	})
}

func managedReqs() stubRequirements {
	cfg := testConfig()
	return stubRequirements{
		scheme:  batchsettlement.SchemeBatched,
		network: "eip155:8453",
		asset:   cfg.Token,
		amount:  "1000",
		payTo:   cfg.Receiver,
		extra: map[string]interface{}{
			"receiverAuthorizer": cfg.ReceiverAuthorizer,
			"withdrawDelay":      cfg.WithdrawDelay,
			"voucherManager":     "facilitator",
		},
	}
}

func managedPayload(data map[string]interface{}) *types.PaymentPayload {
	return &types.PaymentPayload{
		X402Version: 2,
		Payload:     data,
		Accepted: types.PaymentRequirements{
			Scheme:  batchsettlement.SchemeBatched,
			Network: "eip155:8453",
		},
	}
}

func managedCancelContext(payload x402.PaymentPayloadView, reason x402.VerifiedPaymentCancellationReason) x402.VerifiedPaymentCanceledContext {
	return x402.VerifiedPaymentCanceledContext{
		SettleContext: x402.SettleContext{
			Payload:      payload,
			Requirements: managedReqs(),
			Phase:        x402.SettlePhaseCancel,
		},
		Reason: reason,
	}
}

func TestManagedBeforeVerify_RejectsClientPendingId(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	raw := voucherPayload(id, "1000", "0xdeadbeef")
	raw["pendingId"] = "0xclient"
	res, err := handleManagedBeforeVerify(s, x402.VerifyContext{
		Payload:      managedPayload(raw),
		Requirements: managedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != batchsettlement.ErrUnexpectedPendingId {
		t.Fatalf("got %+v", res)
	}
}

func TestManagedBeforeVerify_RejectsClientCancel(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	raw := voucherPayload(id, "1000", "0xdeadbeef")
	raw["cancel"] = true
	res, err := handleManagedBeforeVerify(s, x402.VerifyContext{
		Payload:      managedPayload(raw),
		Requirements: managedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != batchsettlement.ErrUnexpectedCancel {
		t.Fatalf("got %+v", res)
	}
}

func TestManagedBeforeVerify_AbortsDepositBelowMin(t *testing.T) {
	s := buildManagedServer(t, nil, true)
	id := testChannelId(t)
	reqs := managedReqs()
	reqs.extra["minDeposit"] = "10000"
	reqs.amount = "1000"
	res, err := handleManagedBeforeVerify(s, x402.VerifyContext{
		Payload:      managedPayload(depositPayloadWithAmount(id, "1000", "0xdeadbeef", "1000")),
		Requirements: reqs,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != batchsettlement.ErrDepositBelowMinDeposit {
		t.Fatalf("got %+v", res)
	}
}

func TestManagedBeforeVerify_AbortsChannelIdMismatch(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	res, err := handleManagedBeforeVerify(s, x402.VerifyContext{
		Payload:      managedPayload(voucherPayload(testChA, "1000", "0xdeadbeef")),
		Requirements: managedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != batchsettlement.ErrChannelIdMismatch {
		t.Fatalf("got %+v", res)
	}
}

func TestManagedBeforeSettle_ForwardsWithoutShortCircuit(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	res, err := handleManagedBeforeSettle(s, x402.SettleContext{})
	if err != nil || res != nil {
		t.Fatalf("got res=%+v err=%v", res, err)
	}
}

func TestManagedBeforeVerify_IgnoresClaimPayload(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	res, err := handleManagedBeforeVerify(s, x402.VerifyContext{
		Payload: managedPayload(map[string]interface{}{
			"type":   "claim",
			"claims": []interface{}{},
		}),
		Requirements: managedReqs(),
	})
	if err != nil || res != nil {
		t.Fatalf("got res=%+v err=%v", res, err)
	}
}

func TestManagedAfterVerify_MismatchWithoutResyncOmitsCorrective(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "1000", "0xdeadbeef"))
	_, err := handleManagedAfterVerify(s, x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{Payload: pp, Requirements: managedReqs()},
		Result: &x402.VerifyResponse{
			IsValid:       false,
			InvalidReason: batchsettlement.ErrCumulativeAmountMismatch,
			Extra:         map[string]interface{}{},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if rc := s.ReadRequestContext(pp); rc != nil && rc.CorrectiveChannelState != nil {
		t.Fatalf("unexpected corrective: %+v", rc)
	}
}

func TestManagedAfterVerify_NonMismatchFailureDoesNotStashCorrective(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "1000", "0xdeadbeef"))
	_, err := handleManagedAfterVerify(s, x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{Payload: pp, Requirements: managedReqs()},
		Result:        &x402.VerifyResponse{IsValid: false, InvalidReason: batchsettlement.ErrChannelBusy},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if rc := s.ReadRequestContext(pp); rc != nil && rc.CorrectiveChannelState != nil {
		t.Fatalf("unexpected corrective: %+v", rc)
	}
}

func TestManagedEnrichPaymentRequired_MissingVoucherProof(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "1000", "0xdeadbeef"))
	s.MergeRequestContext(pp, BatchSettlementRequestContext{
		CorrectiveChannelState: &batchsettlement.BatchSettlementChannelStateExtra{
			ChannelId: id, Balance: "10000", ChargedCumulativeAmount: "0",
		},
	})
	reqs := []types.PaymentRequirements{{
		Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453", Extra: map[string]interface{}{"voucherManager": "facilitator"},
	}}
	handleManagedEnrichPaymentRequiredResponse(s, x402.PaymentRequiredContext{
		Requirements:   reqs,
		PaymentPayload: pp,
		Error:          batchsettlement.ErrCumulativeAmountMismatch,
	})
	if reqs[0].Extra["voucherState"] != nil {
		t.Fatalf("expected no voucherState, got %+v", reqs[0].Extra)
	}
}

func TestManagedAfterSettle_DepositUsesVerifySnapshotFallback(t *testing.T) {
	store := NewInMemoryChannelStorage()
	s := buildManagedServer(t, store, false)
	id := testChannelId(t)
	cfg := testConfig()
	pp := managedPayload(depositPayloadFor(id, "2000", "0xabc"))
	s.MergeRequestContext(pp, BatchSettlementRequestContext{
		ChannelSnapshot: &ChannelSession{
			ChannelId: id, ChannelConfig: cfg, ChargedCumulativeAmount: "1000",
			SignedMaxClaimable: "1000", Signature: "0xold", Balance: "5000",
		},
	})
	if err := handleManagedAfterSettle(s, x402.SettleResultContext{
		SettleContext: x402.SettleContext{Payload: pp, Requirements: managedReqs()},
		Result: &x402.SettleResponse{
			Success: true, Transaction: "0xdep",
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId": id, "balance": "6000", "totalClaimed": "0",
					"withdrawRequestedAt": 0.0, "refundNonce": "0",
				},
			},
		},
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, err := store.Get(context.Background(), id)
	if err != nil || got == nil {
		t.Fatalf("get: %v %+v", err, got)
	}
	if got.ChargedCumulativeAmount != "1000" || got.Balance != "6000" || got.SignedMaxClaimable != "2000" {
		t.Fatalf("got %+v", got)
	}
}

func TestManagedAfterVerify_StashesVoucherProofWithoutChannelState(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "1000", "0xdeadbeef"))
	_, err := handleManagedAfterVerify(s, x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{Payload: pp, Requirements: managedReqs()},
		Result: &x402.VerifyResponse{
			IsValid: false, InvalidReason: batchsettlement.ErrCumulativeAmountMismatch,
			Extra: map[string]interface{}{
				"voucherState": map[string]interface{}{"signedMaxClaimable": "4000", "signature": "0xonly"},
			},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	rc := s.ReadRequestContext(pp)
	if rc == nil || rc.CorrectiveVoucherState == nil || rc.CorrectiveVoucherState.Signature != "0xonly" {
		t.Fatalf("got %+v", rc)
	}
	if rc.CorrectiveChannelState != nil {
		t.Fatalf("unexpected channel state: %+v", rc.CorrectiveChannelState)
	}
}

func TestManagedEnrichSettlementPayload_RefundFromSnapshot(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	cfg := testConfig()
	raw := refundPayload(id, "5000", "0xdeadbeef")
	raw["amount"] = "1000"
	pp := managedPayload(raw)
	s.MergeRequestContext(pp, BatchSettlementRequestContext{
		PendingId: "0xabc123",
		ChannelSnapshot: &ChannelSession{
			ChannelId: id, ChannelConfig: cfg, ChargedCumulativeAmount: "3000",
			SignedMaxClaimable: "5000", Signature: "0xdeadbeef",
			Balance: "10000", TotalClaimed: "2000", RefundNonce: 1,
		},
	})
	fields, err := handleManagedEnrichSettlementPayload(s, x402.SettleContext{
		Payload:      pp,
		Requirements: managedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if fields["pendingId"] != "0xabc123" || fields["refundNonce"] != "1" {
		t.Fatalf("got %+v", fields)
	}
	if _, ok := fields["amount"]; ok {
		t.Fatalf("requested amount must not be rewritten: %+v", fields)
	}
	if _, ok := fields["claimAuthorizerSignature"]; ok {
		t.Fatalf("managed refund must omit claim authorizer signature: %+v", fields)
	}
	if _, ok := fields["refundAuthorizerSignature"].(string); !ok {
		t.Fatalf("expected refund signature, got %+v", fields)
	}
}

func TestManagedEnrichSettlementPayload_RefundMissingSnapshot(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	_, err := handleManagedEnrichSettlementPayload(s, x402.SettleContext{
		Payload:      managedPayload(refundPayload(id, "1000", "0xdead")),
		Requirements: managedReqs(),
	})
	if err == nil || err.Error() != batchsettlement.ErrMissingChannel {
		t.Fatalf("got %v", err)
	}
}

func TestManagedAfterVerify_IgnoresSettlePayload(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	pp := managedPayload(map[string]interface{}{
		"type": "settle", "receiver": testConfig().Receiver, "token": testConfig().Token,
	})
	_, err := handleManagedAfterVerify(s, x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{Payload: pp, Requirements: managedReqs()},
		Result:        &x402.VerifyResponse{IsValid: true, Payer: "0xpayer"},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if s.ReadRequestContext(pp) != nil {
		t.Fatal("expected no request context")
	}
}

func TestManagedAfterSettle_IgnoresFailedResult(t *testing.T) {
	store := NewInMemoryChannelStorage()
	s := buildManagedServer(t, store, false)
	id := testChannelId(t)
	seedStore(t, store, id, &ChannelSession{
		ChannelId: id, ChannelConfig: testConfig(), ChargedCumulativeAmount: "1000",
		SignedMaxClaimable: "1000", Signature: "0xdeadbeef", Balance: "10000",
	})
	if err := handleManagedAfterSettle(s, x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      managedPayload(voucherPayload(id, "1000", "0xdeadbeef")),
			Requirements: managedReqs(),
		},
		Result: &x402.SettleResponse{Success: false, ErrorReason: "invalid_voucher_signature"},
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := store.Get(context.Background(), id)
	if got == nil || got.ChargedCumulativeAmount != "1000" {
		t.Fatalf("got %+v", got)
	}
}

func TestManagedLifecycleNoops(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	if _, err := handleManagedVerifyFailure(s, x402.VerifyFailureContext{}); err != nil {
		t.Fatal(err)
	}
	if _, err := handleManagedSettleFailure(s, x402.SettleFailureContext{}); err != nil {
		t.Fatal(err)
	}
	if err := handleManagedVerifiedPaymentCanceled(s, x402.VerifiedPaymentCanceledContext{}); err != nil {
		t.Fatal(err)
	}
	if fields, err := handleManagedEnrichSettlementResponse(s, x402.SettleResultContext{}); err != nil || fields != nil {
		t.Fatalf("got %v %v", fields, err)
	}
}

func TestManagedSettleOnCancel_ZeroAmountForCancelReasons(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	reasons := []x402.VerifiedPaymentCancellationReason{
		x402.CancellationReasonHandlerFailed,
		x402.CancellationReasonHandlerThrew,
		x402.CancellationReasonAfterVerifyAborted,
	}
	for _, reason := range reasons {
		pp := managedPayload(voucherPayload(id, "1000", "0xdeadbeef"))
		got, err := handleManagedSettleOnCancel(managedCancelContext(pp, reason))
		if err != nil || got == nil || got.Amount != "0" {
			t.Fatalf("reason %s: got %+v err=%v", reason, got, err)
		}
		schemeGot, err := s.SettleOnCancel(managedCancelContext(pp, reason))
		if err != nil || schemeGot == nil || schemeGot.Amount != "0" {
			t.Fatalf("scheme reason %s: got %+v err=%v", reason, schemeGot, err)
		}
	}
}

func TestManagedEnrichSettlementPayload_CancelStampsPendingId(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "1000", "0xdeadbeef"))
	s.MergeRequestContext(pp, BatchSettlementRequestContext{PendingId: "0xabc123"})
	fields, err := handleManagedEnrichSettlementPayload(s, x402.SettleContext{
		Payload:      pp,
		Requirements: managedReqs(),
		Phase:        x402.SettlePhaseCancel,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if fields["pendingId"] != "0xabc123" || fields["cancel"] != true {
		t.Fatalf("got %+v", fields)
	}
}

func TestManagedEnrichSettlementPayload_CancelWithoutRefundFields(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	for _, raw := range []map[string]interface{}{
		depositPayloadFor(id, "1000", "0xdeadbeef"),
		refundPayload(id, "1000", "0xdeadbeef"),
	} {
		fields, err := handleManagedEnrichSettlementPayload(s, x402.SettleContext{
			Payload:      managedPayload(raw),
			Requirements: managedReqs(),
			Phase:        x402.SettlePhaseCancel,
		})
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if fields["cancel"] != true || fields["refundNonce"] != nil {
			t.Fatalf("got %+v", fields)
		}
	}
}

func TestSettleOnCancel_SelfManagedIsNoop(t *testing.T) {
	s := NewBatchSettlementEvmScheme(testConfig().Receiver, nil)
	id := testChannelId(t)
	got, err := s.SettleOnCancel(managedCancelContext(managedPayload(voucherPayload(id, "1000", "0xsig")), x402.CancellationReasonHandlerFailed))
	if err != nil || got != nil {
		t.Fatalf("got %+v err=%v", got, err)
	}
}

func TestManagedAfterSettle_CancelDoesNotUpsertReplica(t *testing.T) {
	store := NewInMemoryChannelStorage()
	s := buildManagedServer(t, store, false)
	id := testChannelId(t)
	seedStore(t, store, id, &ChannelSession{
		ChannelId: id, ChannelConfig: testConfig(), ChargedCumulativeAmount: "1000",
		SignedMaxClaimable: "1000", Signature: "0xdeadbeef", Balance: "10000",
	})
	if err := handleManagedAfterSettle(s, x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      managedPayload(voucherPayload(id, "1000", "0xdeadbeef")),
			Requirements: managedReqs(),
			Phase:        x402.SettlePhaseCancel,
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{"balance": "1", "totalClaimed": "999", "chargedCumulativeAmount": "1000"},
			},
		},
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := store.Get(context.Background(), id)
	if got == nil || got.ChargedCumulativeAmount != "1000" || got.Balance != "10000" {
		t.Fatalf("got %+v", got)
	}
}

func TestManagedAfterVerify_RecordsSnapshot(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "1000", "0xdeadbeef"))
	_, err := handleManagedAfterVerify(s, x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{Payload: pp, Requirements: managedReqs()},
		Result: &x402.VerifyResponse{
			IsValid: true, Payer: "0xpayer",
			Extra: map[string]interface{}{
				"balance": "10000", "totalClaimed": "1000",
				"withdrawRequestedAt": 2.0, "refundNonce": 3.0,
			},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	rc := s.ReadRequestContext(pp)
	if rc == nil || rc.ChannelSnapshot == nil {
		t.Fatal("expected snapshot")
	}
	if rc.ChannelSnapshot.Balance != "10000" || rc.ChannelSnapshot.ChargedCumulativeAmount != "0" || rc.PendingId != "" {
		t.Fatalf("got %+v", rc)
	}
}

func TestManagedAfterVerify_StashesPendingIdAndEchoesOnSettle(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "1000", "0xdeadbeef"))
	_, err := handleManagedAfterVerify(s, x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{Payload: pp, Requirements: managedReqs()},
		Result: &x402.VerifyResponse{
			IsValid: true, Payer: "0xpayer",
			Extra: map[string]interface{}{"balance": "10000", "totalClaimed": "1000", "pendingId": "0xabc123"},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	rc := s.ReadRequestContext(pp)
	if rc == nil || rc.PendingId != "0xabc123" || !reservationCommitted(rc) {
		t.Fatalf("got %+v", rc)
	}
	fields, err := handleManagedEnrichSettlementPayload(s, x402.SettleContext{
		Payload: pp, Requirements: managedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(fields) != 1 || fields["pendingId"] != "0xabc123" {
		t.Fatalf("got %+v", fields)
	}
}

func TestManagedAfterVerify_RefundSkipsHandler(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(refundPayload(id, "1000", "0xdeadbeef"))
	res, err := handleManagedAfterVerify(s, x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{Payload: pp, Requirements: managedReqs()},
		Result: &x402.VerifyResponse{
			IsValid: true, Payer: "0xpayer",
			Extra: map[string]interface{}{"balance": "10000", "chargedCumulativeAmount": "1000"},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.SkipHandler || res.Response == nil {
		t.Fatalf("got %+v", res)
	}
}

func TestManagedAfterVerify_StashesCorrectiveExtras(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "7000", "0xdeadbeef"))
	_, err := handleManagedAfterVerify(s, x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{Payload: pp, Requirements: managedReqs()},
		Result: &x402.VerifyResponse{
			IsValid: false, InvalidReason: batchsettlement.ErrCumulativeAmountMismatch,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId": id, "balance": "10000", "totalClaimed": "1000", "chargedCumulativeAmount": "5000",
				},
				"voucherState": map[string]interface{}{"signedMaxClaimable": "5000", "signature": "0xstored"},
			},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	rc := s.ReadRequestContext(pp)
	if rc == nil || rc.CorrectiveChannelState == nil || rc.CorrectiveVoucherState == nil {
		t.Fatalf("got %+v", rc)
	}
	if rc.CorrectiveChannelState.Balance != "10000" || rc.CorrectiveVoucherState.Signature != "0xstored" {
		t.Fatalf("got %+v", rc)
	}
}

func TestManagedEnrichPaymentRequired_CopiesCorrectiveExtras(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "1000", "0xdeadbeef"))
	s.MergeRequestContext(pp, BatchSettlementRequestContext{
		CorrectiveChannelState: &batchsettlement.BatchSettlementChannelStateExtra{
			ChannelId: id, Balance: "10000", TotalClaimed: "1000", ChargedCumulativeAmount: "5000",
		},
		CorrectiveVoucherState: &batchsettlement.BatchSettlementVoucherStateExtra{
			SignedMaxClaimable: "5000", Signature: "0xstored",
		},
	})
	reqs := []types.PaymentRequirements{{
		Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453", Extra: map[string]interface{}{"voucherManager": "facilitator"},
	}}
	handleManagedEnrichPaymentRequiredResponse(s, x402.PaymentRequiredContext{
		Requirements:   reqs,
		PaymentPayload: pp,
		Error:          batchsettlement.ErrCumulativeAmountMismatch,
	})
	vs, _ := reqs[0].Extra["voucherState"].(map[string]interface{})
	if vs == nil || vs["signature"] != "0xstored" {
		t.Fatalf("voucherState = %+v", reqs[0].Extra)
	}
}

func TestManagedEnrichPaymentRequired_CopiesCorrectiveExtrasBelowClaimed(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "1000", "0xdeadbeef"))
	s.MergeRequestContext(pp, BatchSettlementRequestContext{
		CorrectiveChannelState: &batchsettlement.BatchSettlementChannelStateExtra{
			ChannelId: id, Balance: "10000", TotalClaimed: "1000", ChargedCumulativeAmount: "5000",
		},
		CorrectiveVoucherState: &batchsettlement.BatchSettlementVoucherStateExtra{
			SignedMaxClaimable: "5000", Signature: "0xstored",
		},
	})
	reqs := []types.PaymentRequirements{{
		Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453", Extra: map[string]interface{}{"voucherManager": "facilitator"},
	}}
	handleManagedEnrichPaymentRequiredResponse(s, x402.PaymentRequiredContext{
		Requirements:   reqs,
		PaymentPayload: pp,
		Error:          batchsettlement.ErrCumulativeBelowClaimed,
	})
	vs, _ := reqs[0].Extra["voucherState"].(map[string]interface{})
	if vs == nil || vs["signedMaxClaimable"] != "5000" || vs["signature"] != "0xstored" {
		t.Fatalf("voucherState = %+v", reqs[0].Extra)
	}
}

func TestManagedEnrichSettlementPayload_NonRefundReturnsNil(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	fields, err := handleManagedEnrichSettlementPayload(s, x402.SettleContext{
		Payload:      managedPayload(voucherPayload(id, "1000", "0xdeadbeef")),
		Requirements: managedReqs(),
	})
	if err != nil || fields != nil {
		t.Fatalf("got %v %v", fields, err)
	}
}

func TestManagedAfterSettle_IgnoresClaimPayload(t *testing.T) {
	store := NewInMemoryChannelStorage()
	s := buildManagedServer(t, store, false)
	id := testChannelId(t)
	seedStore(t, store, id, &ChannelSession{
		ChannelId: id, ChannelConfig: testConfig(), ChargedCumulativeAmount: "1000", Balance: "10000",
	})
	if err := handleManagedAfterSettle(s, x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      managedPayload(map[string]interface{}{"type": "claim", "claims": []interface{}{}}),
			Requirements: managedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra:   map[string]interface{}{"channelState": map[string]interface{}{"balance": "9999"}},
		},
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := store.Get(context.Background(), id)
	if got.Balance != "10000" {
		t.Fatalf("got %+v", got)
	}
}

func TestManagedAfterSettle_UsesSnapshotWhenChannelStateMissing(t *testing.T) {
	store := NewInMemoryChannelStorage()
	s := buildManagedServer(t, store, false)
	id := testChannelId(t)
	cfg := testConfig()
	pp := managedPayload(voucherPayload(id, "3000", "0xnew"))
	s.MergeRequestContext(pp, BatchSettlementRequestContext{
		ChannelSnapshot: &ChannelSession{
			ChannelId: id, ChannelConfig: cfg, ChargedCumulativeAmount: "1800",
			Balance: "8000", TotalClaimed: "500", RefundNonce: 1,
		},
	})
	if err := handleManagedAfterSettle(s, x402.SettleResultContext{
		SettleContext: x402.SettleContext{Payload: pp, Requirements: managedReqs()},
		Result:        &x402.SettleResponse{Success: true, Extra: map[string]interface{}{}},
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := store.Get(context.Background(), id)
	if got == nil || got.ChargedCumulativeAmount != "1800" || got.Balance != "8000" || got.TotalClaimed != "500" {
		t.Fatalf("got %+v", got)
	}
}

func TestManagedAfterSettle_FallsBackToSnapshotCharged(t *testing.T) {
	store := NewInMemoryChannelStorage()
	s := buildManagedServer(t, store, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "3000", "0xnew"))
	s.MergeRequestContext(pp, BatchSettlementRequestContext{
		ChannelSnapshot: &ChannelSession{
			ChannelId: id, ChannelConfig: testConfig(), ChargedCumulativeAmount: "2500",
			Balance: "8000", TotalClaimed: "500", RefundNonce: 1,
		},
	})
	if err := handleManagedAfterSettle(s, x402.SettleResultContext{
		SettleContext: x402.SettleContext{Payload: pp, Requirements: managedReqs()},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId": id, "balance": "7500", "totalClaimed": "1000", "refundNonce": "2",
				},
			},
		},
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := store.Get(context.Background(), id)
	if got == nil || got.ChargedCumulativeAmount != "2500" || got.Balance != "7500" || got.RefundNonce != 2 {
		t.Fatalf("got %+v", got)
	}
}

func TestManagedAfterSettle_SkipsWriteWhenIncomingWatermarkLower(t *testing.T) {
	store := NewInMemoryChannelStorage()
	s := buildManagedServer(t, store, false)
	id := testChannelId(t)
	seedStore(t, store, id, &ChannelSession{
		ChannelId: id, ChannelConfig: testConfig(), ChargedCumulativeAmount: "5000",
		SignedMaxClaimable: "5000", Signature: "0xstored", Balance: "10000",
		TotalClaimed: "0", RefundNonce: 0,
	})
	if err := handleManagedAfterSettle(s, x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      managedPayload(voucherPayload(id, "1000", "0xnew")),
			Requirements: managedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true, Transaction: "0xvoucher",
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId": id, "balance": "9999", "totalClaimed": "0",
					"chargedCumulativeAmount": "1000", "withdrawRequestedAt": 0.0, "refundNonce": "0",
				},
			},
		},
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := store.Get(context.Background(), id)
	if got == nil || got.ChargedCumulativeAmount != "5000" || got.Balance != "10000" {
		t.Fatalf("got %+v", got)
	}
}

func TestManagedAfterSettle_PropagatesClearedWithdrawOnEqualWatermark(t *testing.T) {
	store := NewInMemoryChannelStorage()
	s := buildManagedServer(t, store, false)
	id := testChannelId(t)
	seedStore(t, store, id, &ChannelSession{
		ChannelId: id, ChannelConfig: testConfig(), ChargedCumulativeAmount: "1000",
		SignedMaxClaimable: "1000", Signature: "0xstored", Balance: "10000",
		TotalClaimed: "0", WithdrawRequestedAt: 456, RefundNonce: 0,
	})
	if err := handleManagedAfterSettle(s, x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      managedPayload(voucherPayload(id, "1000", "0xnew")),
			Requirements: managedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true, Transaction: "0xvoucher",
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId": id, "balance": "10000", "totalClaimed": "0",
					"chargedCumulativeAmount": "1000", "withdrawRequestedAt": 0.0, "refundNonce": "0",
				},
			},
		},
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := store.Get(context.Background(), id)
	if got == nil || got.ChargedCumulativeAmount != "1000" || got.WithdrawRequestedAt != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestManagedAfterVerify_NonObjectCorrectiveExtrasIgnored(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "1000", "0xdeadbeef"))
	_, err := handleManagedAfterVerify(s, x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{Payload: pp, Requirements: managedReqs()},
		Result: &x402.VerifyResponse{
			IsValid: false, InvalidReason: batchsettlement.ErrCumulativeAmountMismatch,
			Extra: map[string]interface{}{"channelState": "not-an-object", "voucherState": nil},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if s.ReadRequestContext(pp) != nil {
		t.Fatal("expected no context")
	}
}

func TestManagedEnrichPaymentRequired_SkipsWithoutPayload(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	reqs := []types.PaymentRequirements{{
		Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453", Extra: map[string]interface{}{},
	}}
	handleManagedEnrichPaymentRequiredResponse(s, x402.PaymentRequiredContext{
		Requirements: reqs,
		Error:        batchsettlement.ErrCumulativeAmountMismatch,
	})
	if reqs[0].Extra["voucherState"] != nil {
		t.Fatalf("got %+v", reqs[0].Extra)
	}
}

func TestManagedEnrichPaymentRequired_SkipsNonMismatchError(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "1000", "0xdeadbeef"))
	s.MergeRequestContext(pp, BatchSettlementRequestContext{
		CorrectiveChannelState: &batchsettlement.BatchSettlementChannelStateExtra{ChannelId: id, Balance: "10000"},
		CorrectiveVoucherState: &batchsettlement.BatchSettlementVoucherStateExtra{SignedMaxClaimable: "5000", Signature: "0xstored"},
	})
	reqs := []types.PaymentRequirements{{
		Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453", Extra: map[string]interface{}{},
	}}
	handleManagedEnrichPaymentRequiredResponse(s, x402.PaymentRequiredContext{
		Requirements:   reqs,
		PaymentPayload: pp,
		Error:          batchsettlement.ErrChannelBusy,
	})
	if reqs[0].Extra["voucherState"] != nil {
		t.Fatalf("got %+v", reqs[0].Extra)
	}
}

func TestManagedEnrichPaymentRequired_SkipsNetworkMismatch(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "1000", "0xdeadbeef"))
	s.MergeRequestContext(pp, BatchSettlementRequestContext{
		CorrectiveChannelState: &batchsettlement.BatchSettlementChannelStateExtra{ChannelId: id, Balance: "10000"},
		CorrectiveVoucherState: &batchsettlement.BatchSettlementVoucherStateExtra{SignedMaxClaimable: "5000", Signature: "0xstored"},
	})
	reqs := []types.PaymentRequirements{{
		Scheme: batchsettlement.SchemeBatched, Network: "eip155:1", Extra: map[string]interface{}{},
	}}
	handleManagedEnrichPaymentRequiredResponse(s, x402.PaymentRequiredContext{
		Requirements:   reqs,
		PaymentPayload: pp,
		Error:          batchsettlement.ErrCumulativeAmountMismatch,
	})
	if reqs[0].Extra["voucherState"] != nil {
		t.Fatalf("got %+v", reqs[0].Extra)
	}
}

func TestManagedBeforeVerify_RefundPassesBinding(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	res, err := handleManagedBeforeVerify(s, x402.VerifyContext{
		Payload:      managedPayload(refundPayload(id, "1000", "0xdeadbeef")),
		Requirements: managedReqs(),
	})
	if err != nil || res != nil {
		t.Fatalf("got %+v err=%v", res, err)
	}
}

func TestManagedAfterSettle_PartialRefundUpdatesReplica(t *testing.T) {
	store := NewInMemoryChannelStorage()
	s := buildManagedServer(t, store, false)
	id := testChannelId(t)
	seedStore(t, store, id, &ChannelSession{
		ChannelId: id, ChannelConfig: testConfig(), ChargedCumulativeAmount: "3000",
		SignedMaxClaimable: "5000", Signature: "0xdeadbeef", Balance: "10000", TotalClaimed: "2000",
	})
	if err := handleManagedAfterSettle(s, x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      managedPayload(refundPayload(id, "5000", "0xdeadbeef")),
			Requirements: managedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId": id, "balance": "9000", "totalClaimed": "2000",
					"chargedCumulativeAmount": "2000", "withdrawRequestedAt": 1.0, "refundNonce": "1",
				},
			},
		},
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := store.Get(context.Background(), id)
	if got == nil || got.Balance != "9000" || got.ChargedCumulativeAmount != "2000" || got.RefundNonce != 1 {
		t.Fatalf("got %+v", got)
	}
}

func TestManagedAfterSettle_FullRefundDeletesReplica(t *testing.T) {
	store := NewInMemoryChannelStorage()
	s := buildManagedServer(t, store, false)
	id := testChannelId(t)
	seedStore(t, store, id, &ChannelSession{
		ChannelId: id, ChannelConfig: testConfig(), ChargedCumulativeAmount: "5000",
		SignedMaxClaimable: "5000", Signature: "0xdeadbeef", Balance: "10000", TotalClaimed: "5000",
	})
	if err := handleManagedAfterSettle(s, x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      managedPayload(refundPayload(id, "5000", "0xdeadbeef")),
			Requirements: managedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId": id, "balance": "5000", "totalClaimed": "5000", "chargedCumulativeAmount": "5000",
				},
			},
		},
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := store.Get(context.Background(), id)
	if got != nil {
		t.Fatalf("expected deleted, got %+v", got)
	}
}

func TestManagedSchemeHooks_BeforeSettleDoesNotAbortEmptyReplica(t *testing.T) {
	s := buildManagedServer(t, NewInMemoryChannelStorage(), false)
	id := testChannelId(t)
	res, err := s.BeforeSettleHook()(x402.SettleContext{
		Payload:      managedPayload(voucherPayload(id, "1000", "0xdeadbeef")),
		Requirements: managedReqs(),
	})
	if err != nil || res != nil {
		t.Fatalf("got %+v err=%v", res, err)
	}
}

func TestManagedSchemeHooks_AfterVerifyRefundSkipsHandler(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(refundPayload(id, "5000", "0xdeadbeef"))
	res, err := s.AfterVerifyHook()(x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{Payload: pp, Requirements: managedReqs()},
		Result: &x402.VerifyResponse{
			IsValid: true, Payer: "0xpayer",
			Extra: map[string]interface{}{"balance": "10000", "chargedCumulativeAmount": "5000"},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.SkipHandler {
		t.Fatalf("got %+v", res)
	}
	if s.ReadRequestContext(pp).ChannelSnapshot.ChargedCumulativeAmount != "5000" {
		t.Fatalf("snapshot = %+v", s.ReadRequestContext(pp))
	}
}

func TestManagedSchemeHooks_EnrichPaymentRequiredFromStash(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "7000", "0xdeadbeef"))
	pp.Accepted.Extra = map[string]interface{}{"voucherManager": "facilitator"}
	s.MergeRequestContext(pp, BatchSettlementRequestContext{
		CorrectiveChannelState: &batchsettlement.BatchSettlementChannelStateExtra{
			ChannelId: id, Balance: "10000", ChargedCumulativeAmount: "5000",
		},
		CorrectiveVoucherState: &batchsettlement.BatchSettlementVoucherStateExtra{
			SignedMaxClaimable: "5000", Signature: "0xdeadbeef",
		},
	})
	reqs := []types.PaymentRequirements{{
		Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453", Extra: map[string]interface{}{"voucherManager": "facilitator"},
	}}
	s.EnrichPaymentRequiredResponse(x402.PaymentRequiredContext{
		Requirements:   reqs,
		PaymentPayload: pp,
		Error:          batchsettlement.ErrCumulativeAmountMismatch,
	})
	vs, _ := reqs[0].Extra["voucherState"].(map[string]interface{})
	if vs["signature"] != "0xdeadbeef" {
		t.Fatalf("got %+v", reqs[0].Extra)
	}
}

func TestManagedSchemeHooks_AfterSettleUpsertsReplica(t *testing.T) {
	store := NewInMemoryChannelStorage()
	s := buildManagedServer(t, store, false)
	id := testChannelId(t)
	if err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      managedPayload(voucherPayload(id, "1000", "0xdeadbeef")),
			Requirements: managedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"channelId": id, "balance": "10000", "chargedCumulativeAmount": "1000",
				},
			},
		},
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := store.Get(context.Background(), id)
	if got == nil || got.ChargedCumulativeAmount != "1000" || got.SignedMaxClaimable != "1000" {
		t.Fatalf("got %+v", got)
	}
}

func TestManagedSchemeHooks_AfterVerifyStashesCorrective(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(voucherPayload(id, "7000", "0xdeadbeef"))
	_, err := s.AfterVerifyHook()(x402.VerifyResultContext{
		VerifyContext: x402.VerifyContext{Payload: pp, Requirements: managedReqs()},
		Result: &x402.VerifyResponse{
			IsValid: false, InvalidReason: batchsettlement.ErrCumulativeAmountMismatch,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{"channelId": id, "balance": "10000"},
				"voucherState": map[string]interface{}{"signedMaxClaimable": "5000", "signature": "0xdeadbeef"},
			},
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	rc := s.ReadRequestContext(pp)
	if rc == nil || rc.CorrectiveChannelState == nil || rc.CorrectiveVoucherState == nil {
		t.Fatalf("got %+v", rc)
	}
}

func TestManagedSchemeHooks_EnrichRefundOmitsClaimAuthorizer(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	pp := managedPayload(refundPayload(id, "5000", "0xdeadbeef"))
	s.MergeRequestContext(pp, BatchSettlementRequestContext{
		ChannelSnapshot: &ChannelSession{
			ChannelId: id, ChannelConfig: testConfig(), ChargedCumulativeAmount: "5000",
			SignedMaxClaimable: "5000", Signature: "0xdeadbeef", Balance: "10000",
		},
	})
	fields, err := s.EnrichSettlementPayload(x402.SettleContext{Payload: pp, Requirements: managedReqs()})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if fields["claimAuthorizerSignature"] != nil {
		t.Fatalf("got %+v", fields)
	}
	if _, ok := fields["refundAuthorizerSignature"].(string); !ok {
		t.Fatalf("expected refund signature: %+v", fields)
	}
	if fields["amount"] != "5000" {
		t.Fatalf("amount = %v", fields["amount"])
	}
}

func TestManagedSchemeHooks_BeforeVerifyIgnoresClaim(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	pp := managedPayload(map[string]interface{}{"type": "claim", "claims": []interface{}{}})
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{Payload: pp, Requirements: managedReqs()})
	if err != nil || res != nil {
		t.Fatalf("got %+v err=%v", res, err)
	}
	if s.ReadRequestContext(pp) != nil {
		t.Fatal("expected no context")
	}
}

func TestManagedSchemeHooks_ModeMismatchAborts(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	id := testChannelId(t)
	res, err := s.BeforeVerifyHook()(x402.VerifyContext{
		Payload:      managedPayload(voucherPayload(id, "1000", "0xdeadbeef")),
		Requirements: batchedReqs(),
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res == nil || !res.Abort || res.Reason != batchsettlement.ErrVoucherStoreModeMismatch {
		t.Fatalf("got %+v", res)
	}
}

func TestManagedAfterSettle_FailedSchemeHookLeavesReplica(t *testing.T) {
	store := NewInMemoryChannelStorage()
	s := buildManagedServer(t, store, false)
	id := testChannelId(t)
	seedStore(t, store, id, &ChannelSession{ChannelId: id, ChargedCumulativeAmount: "1000", Balance: "10000"})
	if err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      managedPayload(voucherPayload(id, "1000", "0xdeadbeef")),
			Requirements: managedReqs(),
		},
		Result: &x402.SettleResponse{Success: false, ErrorReason: "invalid_voucher_signature"},
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := store.Get(context.Background(), id)
	if got == nil || got.ChargedCumulativeAmount != "1000" {
		t.Fatalf("got %+v", got)
	}
}

func TestManagedAfterSettle_PartialRefundViaSchemeHook(t *testing.T) {
	store := NewInMemoryChannelStorage()
	s := buildManagedServer(t, store, false)
	id := testChannelId(t)
	seedStore(t, store, id, &ChannelSession{
		ChannelId: id, ChannelConfig: testConfig(), ChargedCumulativeAmount: "5000", Balance: "10000",
	})
	if err := s.AfterSettleHook()(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Payload:      managedPayload(refundPayload(id, "5000", "0xdeadbeef")),
			Requirements: managedReqs(),
		},
		Result: &x402.SettleResponse{
			Success: true,
			Extra: map[string]interface{}{
				"channelState": map[string]interface{}{
					"balance": "6000", "totalClaimed": "5000", "chargedCumulativeAmount": "5000", "refundNonce": "1",
				},
			},
		},
	}); err != nil {
		t.Fatalf("err: %v", err)
	}
	got, _ := store.Get(context.Background(), id)
	if got == nil || got.Balance != "6000" || got.RefundNonce != 1 {
		t.Fatalf("got %+v", got)
	}
}

func TestManagedSettleOnCancel_IgnoresUnknownReason(t *testing.T) {
	id := testChannelId(t)
	got, err := handleManagedSettleOnCancel(managedCancelContext(
		managedPayload(voucherPayload(id, "1000", "0xsig")),
		x402.VerifiedPaymentCancellationReason("other"),
	))
	if err != nil || got != nil {
		t.Fatalf("got %+v err=%v", got, err)
	}
}

func TestManagedIsFacilitatorManaged(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	if !s.IsFacilitatorManagedVoucherStore("eip155:8453") {
		t.Fatal("expected facilitator-managed")
	}
	self := NewBatchSettlementEvmScheme("0xreceiver", nil)
	if self.IsFacilitatorManagedVoucherStore("eip155:8453") {
		t.Fatal("expected self-managed")
	}
}

func TestManagedRefundAuthorizerSigner(t *testing.T) {
	s := buildManagedServer(t, nil, false)
	if s.GetRefundAuthorizerSigner() == nil || s.GetReceiverAuthorizerSigner() != nil {
		t.Fatal("managed mode should expose refund signer only")
	}
}
