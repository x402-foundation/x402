package facilitator_test

import (
	"context"
	"encoding/base64"
	"errors"
	"strconv"
	"sync/atomic"
	"testing"

	hiero "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/hedera"
	"github.com/x402-foundation/x402/go/v2/mechanisms/hedera/exact/facilitator"
	"github.com/x402-foundation/x402/go/v2/types"
)

type mockSigner struct {
	addresses []string
	submitTx  string
	submitErr error
	resolve   hedera.AccountResolution
	resolveEr error
	sig       hedera.SignatureCheck
	preflight hedera.SignatureCheck
	sigPayers []string
	prePayers []string
	awaitErr  error
	submits   int
	awaits    []string
}

type blockingSigner struct {
	*mockSigner
	started chan struct{}
	release chan struct{}
	calls   atomic.Int32
}

func (s *blockingSigner) SignAndSubmitTransaction(context.Context, string, string, string) (string, error) {
	if s.calls.Add(1) == 1 {
		close(s.started)
	}
	<-s.release
	return s.submitTx, s.submitErr
}

func (m *mockSigner) GetAddresses(context.Context, string) []string { return m.addresses }
func (m *mockSigner) SignAndSubmitTransaction(context.Context, string, string, string) (string, error) {
	m.submits++
	return m.submitTx, m.submitErr
}
func (m *mockSigner) AwaitTransaction(_ context.Context, transactionID, _ string) error {
	m.awaits = append(m.awaits, transactionID)
	return m.awaitErr
}
func (m *mockSigner) VerifyPayerSignature(_ context.Context, payer, _, _ string) hedera.SignatureCheck {
	m.sigPayers = append(m.sigPayers, payer)
	return m.sig
}
func (m *mockSigner) PreflightTransfer(_ context.Context, payer, _, _, _, _ string) hedera.SignatureCheck {
	m.prePayers = append(m.prePayers, payer)
	return m.preflight
}
func (m *mockSigner) ResolveAccount(context.Context, string, string) (hedera.AccountResolution, error) {
	return m.resolve, m.resolveEr
}

func newMockSigner() *mockSigner {
	return &mockSigner{
		addresses: []string{"0.0.5001"},
		submitTx:  "0.0.5001@1700000001.000000000",
		resolve:   hedera.AccountResolution{Exists: true, IsAlias: false},
		sig:       hedera.SignatureCheck{OK: true},
		preflight: hedera.SignatureCheck{OK: true},
	}
}

func baseRequirements() types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:            hedera.SchemeExact,
		Network:           hedera.HederaTestnetCAIP2,
		Asset:             "0.0.6001",
		Amount:            "1000",
		PayTo:             "0.0.7001",
		MaxTimeoutSeconds: 180,
		Extra:             map[string]interface{}{"feePayer": "0.0.5001"},
	}
}

func basePayload(req types.PaymentRequirements, txB64 string) types.PaymentPayload {
	return types.PaymentPayload{
		X402Version: 2,
		Resource: &types.ResourceInfo{
			URL:         "https://example.com",
			Description: "resource",
			MimeType:    "application/json",
		},
		Accepted: req,
		Payload:  map[string]interface{}{"transaction": txB64},
	}
}

func createTransferB64(t *testing.T, feePayer, payer, payTo, asset, amount string) string {
	t.Helper()
	client := hiero.ClientForTestnet()
	defer client.Close()

	feeID, err := hiero.AccountIDFromString(feePayer)
	if err != nil {
		t.Fatal(err)
	}
	payerID, err := hiero.AccountIDFromString(payer)
	if err != nil {
		t.Fatal(err)
	}
	payToID, err := hiero.AccountIDFromString(payTo)
	if err != nil {
		t.Fatal(err)
	}
	amt, err := strconv.ParseInt(amount, 10, 64)
	if err != nil {
		t.Fatal(err)
	}

	tx := hiero.NewTransferTransaction()
	if asset == hedera.HBARAssetID {
		tx.AddHbarTransfer(payerID, hiero.HbarFromTinybar(-amt))
		tx.AddHbarTransfer(payToID, hiero.HbarFromTinybar(amt))
	} else {
		tokenID, err := hiero.TokenIDFromString(asset)
		if err != nil {
			t.Fatal(err)
		}
		tx.AddTokenTransfer(tokenID, payerID, -amt)
		tx.AddTokenTransfer(tokenID, payToID, amt)
	}
	tx.SetTransactionID(hiero.TransactionIDGenerate(feeID))
	frozen, err := tx.FreezeWith(client)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := frozen.ToBytes()
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func createCustomTransferB64(
	t *testing.T,
	feePayer string,
	configure func(*hiero.TransferTransaction),
) string {
	t.Helper()
	client := hiero.ClientForTestnet()
	defer client.Close()
	feeID, err := hiero.AccountIDFromString(feePayer)
	if err != nil {
		t.Fatal(err)
	}
	tx := hiero.NewTransferTransaction().
		SetTransactionID(hiero.TransactionIDGenerate(feeID))
	configure(tx)
	frozen, err := tx.FreezeWith(client)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := frozen.ToBytes()
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func mustAccountID(t *testing.T, value string) hiero.AccountID {
	t.Helper()
	id, err := hiero.AccountIDFromString(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func mustTokenID(t *testing.T, value string) hiero.TokenID {
	t.Helper()
	id, err := hiero.TokenIDFromString(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func createTopicB64(t *testing.T, feePayer string) string {
	t.Helper()
	client := hiero.ClientForTestnet()
	defer client.Close()
	feeID, err := hiero.AccountIDFromString(feePayer)
	if err != nil {
		t.Fatal(err)
	}
	key, err := hiero.PrivateKeyGenerateEd25519()
	if err != nil {
		t.Fatal(err)
	}
	tx := hiero.NewTopicCreateTransaction().
		SetTransactionID(hiero.TransactionIDGenerate(feeID)).
		SetTopicMemo("x402-non-transfer").
		SetSubmitKey(key.PublicKey())
	frozen, err := tx.FreezeWith(client)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := frozen.ToBytes()
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func verifyReason(t *testing.T, err error) string {
	t.Helper()
	var ve *x402.VerifyError
	if !errors.As(err, &ve) {
		t.Fatalf("expected VerifyError, got %T %v", err, err)
	}
	return ve.InvalidReason
}

func TestFacilitatorVerifyValid(t *testing.T) {
	signer := newMockSigner()
	scheme := facilitator.NewExactHederaScheme(signer)
	req := baseRequirements()
	payload := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))

	resp, err := scheme.Verify(context.Background(), payload, req, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !resp.IsValid || resp.Payer != "0.0.9001" {
		t.Fatalf("resp=%+v", resp)
	}
}

func TestFacilitatorRejectsAssetMismatch(t *testing.T) {
	signer := newMockSigner()
	scheme := facilitator.NewExactHederaScheme(signer)
	req := baseRequirements()
	payload := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.1234", "1000"))
	_, err := scheme.Verify(context.Background(), payload, req, nil)
	if verifyReason(t, err) != facilitator.ErrAssetMismatch {
		t.Fatalf("reason=%s", verifyReason(t, err))
	}
}

func TestFacilitatorAliasPolicy(t *testing.T) {
	signer := newMockSigner()
	signer.resolve = hedera.AccountResolution{Exists: false, IsAlias: true}
	scheme := facilitator.NewExactHederaScheme(signer)
	req := baseRequirements()
	payload := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))
	_, err := scheme.Verify(context.Background(), payload, req, nil)
	if verifyReason(t, err) != facilitator.ErrPayToAliasNotAllowed {
		t.Fatalf("reason=%s", verifyReason(t, err))
	}

	scheme.WithAliasPolicy(hedera.AliasPolicyAllow)
	resp, err := scheme.Verify(context.Background(), payload, req, nil)
	if err != nil || !resp.IsValid {
		t.Fatalf("allow aliases: %v %+v", err, resp)
	}
}

func TestFacilitatorUndecodable(t *testing.T) {
	signer := newMockSigner()
	scheme := facilitator.NewExactHederaScheme(signer)
	req := baseRequirements()
	payload := basePayload(req, "not-a-valid-hedera-transaction")
	_, err := scheme.Verify(context.Background(), payload, req, nil)
	if verifyReason(t, err) != facilitator.ErrTransactionDecode {
		t.Fatalf("reason=%s", verifyReason(t, err))
	}
}

func TestFacilitatorSettle(t *testing.T) {
	signer := newMockSigner()
	scheme := facilitator.NewExactHederaScheme(signer)
	req := baseRequirements()
	payload := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))
	settled, err := scheme.Settle(context.Background(), payload, req, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !settled.Success || settled.Transaction != signer.submitTx {
		t.Fatalf("settled=%+v", settled)
	}
}

func TestFacilitatorTransferInvariants(t *testing.T) {
	const (
		feePayer = "0.0.5001"
		payer    = "0.0.9001"
		payTo    = "0.0.7001"
		third    = "0.0.7002"
		asset    = "0.0.6001"
	)

	t.Run("valid_hbar", func(t *testing.T) {
		req := baseRequirements()
		req.Asset = hedera.HBARAssetID
		req.Amount = "50"
		payload := basePayload(req, createTransferB64(t, feePayer, payer, payTo, req.Asset, req.Amount))
		resp, err := facilitator.NewExactHederaScheme(newMockSigner()).Verify(context.Background(), payload, req, nil)
		if err != nil || !resp.IsValid || resp.Payer != payer {
			t.Fatalf("resp=%+v err=%v", resp, err)
		}
	})

	t.Run("hbar_sum_non_zero", func(t *testing.T) {
		req := baseRequirements()
		req.Asset = hedera.HBARAssetID
		req.Amount = "50"
		tx := createCustomTransferB64(t, feePayer, func(tx *hiero.TransferTransaction) {
			tx.AddHbarTransfer(mustAccountID(t, payer), hiero.HbarFromTinybar(-49))
			tx.AddHbarTransfer(mustAccountID(t, payTo), hiero.HbarFromTinybar(50))
		})
		_, err := facilitator.NewExactHederaScheme(newMockSigner()).Verify(
			context.Background(), basePayload(req, tx), req, nil,
		)
		if verifyReason(t, err) != facilitator.ErrHbarSumNonZero {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("asset_sum_non_zero", func(t *testing.T) {
		req := baseRequirements()
		tx := createCustomTransferB64(t, feePayer, func(tx *hiero.TransferTransaction) {
			token := mustTokenID(t, asset)
			tx.AddTokenTransfer(token, mustAccountID(t, payer), -999)
			tx.AddTokenTransfer(token, mustAccountID(t, payTo), 1000)
		})
		_, err := facilitator.NewExactHederaScheme(newMockSigner()).Verify(
			context.Background(), basePayload(req, tx), req, nil,
		)
		if verifyReason(t, err) != facilitator.ErrAssetSumNonZero {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("extra_positive_recipient", func(t *testing.T) {
		req := baseRequirements()
		tx := createCustomTransferB64(t, feePayer, func(tx *hiero.TransferTransaction) {
			token := mustTokenID(t, asset)
			tx.AddTokenTransfer(token, mustAccountID(t, payer), -1100)
			tx.AddTokenTransfer(token, mustAccountID(t, payTo), 1000)
			tx.AddTokenTransfer(token, mustAccountID(t, third), 100)
		})
		_, err := facilitator.NewExactHederaScheme(newMockSigner()).Verify(
			context.Background(), basePayload(req, tx), req, nil,
		)
		if verifyReason(t, err) != facilitator.ErrExtraPositiveTransfers {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("unexpected_hbar_with_token", func(t *testing.T) {
		req := baseRequirements()
		tx := createCustomTransferB64(t, feePayer, func(tx *hiero.TransferTransaction) {
			token := mustTokenID(t, asset)
			payerID := mustAccountID(t, payer)
			payToID := mustAccountID(t, payTo)
			tx.AddTokenTransfer(token, payerID, -1000)
			tx.AddTokenTransfer(token, payToID, 1000)
			tx.AddHbarTransfer(payerID, hiero.HbarFromTinybar(-1))
			tx.AddHbarTransfer(payToID, hiero.HbarFromTinybar(1))
		})
		_, err := facilitator.NewExactHederaScheme(newMockSigner()).Verify(
			context.Background(), basePayload(req, tx), req, nil,
		)
		if verifyReason(t, err) != facilitator.ErrUnexpectedHbarTransfers {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("fee_payer_debits_token", func(t *testing.T) {
		req := baseRequirements()
		tx := createCustomTransferB64(t, feePayer, func(tx *hiero.TransferTransaction) {
			token := mustTokenID(t, asset)
			tx.AddTokenTransfer(token, mustAccountID(t, feePayer), -1000)
			tx.AddTokenTransfer(token, mustAccountID(t, payTo), 1000)
		})
		_, err := facilitator.NewExactHederaScheme(newMockSigner()).Verify(
			context.Background(), basePayload(req, tx), req, nil,
		)
		if verifyReason(t, err) != facilitator.ErrFeePayerTransferringFunds {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("all_payers_are_verified_and_preflighted", func(t *testing.T) {
		const secondPayer = "0.0.9002"
		req := baseRequirements()
		tx := createCustomTransferB64(t, feePayer, func(tx *hiero.TransferTransaction) {
			token := mustTokenID(t, asset)
			tx.AddTokenTransfer(token, mustAccountID(t, payer), -600)
			tx.AddTokenTransfer(token, mustAccountID(t, secondPayer), -400)
			tx.AddTokenTransfer(token, mustAccountID(t, payTo), 1000)
		})
		signer := newMockSigner()
		resp, err := facilitator.NewExactHederaScheme(signer).Verify(
			context.Background(), basePayload(req, tx), req, nil,
		)
		if err != nil || !resp.IsValid {
			t.Fatalf("resp=%+v err=%v", resp, err)
		}
		if len(signer.sigPayers) != 2 || len(signer.prePayers) != 2 {
			t.Fatalf("signature payers=%v preflight payers=%v", signer.sigPayers, signer.prePayers)
		}
	})
}

func TestFacilitatorSettleFailureReleasesClaim(t *testing.T) {
	cache := hedera.NewSettlementCache()
	signer := newMockSigner()
	signer.submitErr = errors.New("submit failed")
	scheme := facilitator.NewExactHederaScheme(signer, cache)
	req := baseRequirements()
	payload := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))

	_, err := scheme.Settle(context.Background(), payload, req, nil)
	var settleErr *x402.SettleError
	if !errors.As(err, &settleErr) || settleErr.ErrorReason != facilitator.ErrTransactionFailed {
		t.Fatalf("expected transaction_failed, got %T %v", err, err)
	}

	signer.submitErr = nil
	settled, err := scheme.Settle(context.Background(), payload, req, nil)
	if err != nil || !settled.Success {
		t.Fatalf("retry after failed submit: resp=%+v err=%v", settled, err)
	}
}

func TestFacilitatorSubmittedFailureKeepsClaim(t *testing.T) {
	cache := hedera.NewSettlementCache()
	signer := newMockSigner()
	signer.submitErr = &hedera.TransactionSubmittedError{
		TransactionID: signer.submitTx,
		Err:           errors.New("exceptional receipt status: INSUFFICIENT_TOKEN_BALANCE"),
	}
	scheme := facilitator.NewExactHederaScheme(signer, cache)
	req := baseRequirements()
	payload := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))

	_, err := scheme.Settle(context.Background(), payload, req, nil)
	var settleErr *x402.SettleError
	if !errors.As(err, &settleErr) || settleErr.ErrorReason != facilitator.ErrTransactionFailed {
		t.Fatalf("expected transaction_failed, got %T %v", err, err)
	}
	if settleErr.Transaction != signer.submitTx {
		t.Fatalf("transaction=%q want %q", settleErr.Transaction, signer.submitTx)
	}

	signer.submitErr = nil
	_, err = scheme.Settle(context.Background(), payload, req, nil)
	if !errors.As(err, &settleErr) || settleErr.ErrorReason != facilitator.ErrReplay {
		t.Fatalf("expected replay after failed receipt, got %T %v", err, err)
	}
	if len(signer.awaits) != 0 {
		t.Fatalf("terminal failure reconciled: %v", signer.awaits)
	}
}

func settleReason(t *testing.T, err error) *x402.SettleError {
	t.Helper()
	var settleErr *x402.SettleError
	if !errors.As(err, &settleErr) {
		t.Fatalf("expected SettleError, got %T %v", err, err)
	}
	return settleErr
}

func unknownOutcome(txID string) error {
	return &hedera.TransactionSubmittedError{TransactionID: txID, OutcomeUnknown: true, Err: context.DeadlineExceeded}
}

func TestFacilitatorPendingSettlementReconcilesOnce(t *testing.T) {
	signer := newMockSigner()
	signer.submitErr = unknownOutcome(signer.submitTx)
	scheme := facilitator.NewExactHederaScheme(signer)
	req := baseRequirements()
	payload := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))

	_, err := scheme.Settle(context.Background(), payload, req, nil)
	pending := settleReason(t, err)
	if pending.ErrorReason != x402.ErrSettlementPending || pending.Transaction != signer.submitTx || pending.Payer != "0.0.9001" {
		t.Fatalf("first settle=%+v", pending)
	}

	signer.awaitErr = unknownOutcome(signer.submitTx)
	_, err = scheme.Settle(context.Background(), payload, req, nil)
	if got := settleReason(t, err); got.ErrorReason != x402.ErrSettlementPending || got.Transaction != signer.submitTx {
		t.Fatalf("still unknown=%+v", got)
	}

	signer.awaitErr = nil
	settled, err := scheme.Settle(context.Background(), payload, req, nil)
	if err != nil || !settled.Success || settled.Transaction != signer.submitTx || settled.Payer != "0.0.9001" {
		t.Fatalf("reconciled=%+v err=%v", settled, err)
	}

	_, err = scheme.Settle(context.Background(), payload, req, nil)
	if got := settleReason(t, err); got.ErrorReason != facilitator.ErrReplay {
		t.Fatalf("after reconcile reason=%s, want %s", got.ErrorReason, facilitator.ErrReplay)
	}
	if signer.submits != 1 || len(signer.awaits) != 2 {
		t.Fatalf("submits=%d awaits=%v", signer.submits, signer.awaits)
	}
}

func TestFacilitatorPendingSettlementTerminalReceipt(t *testing.T) {
	signer := newMockSigner()
	signer.submitErr = unknownOutcome(signer.submitTx)
	scheme := facilitator.NewExactHederaScheme(signer)
	req := baseRequirements()
	payload := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))

	if _, err := scheme.Settle(context.Background(), payload, req, nil); settleReason(t, err).ErrorReason != x402.ErrSettlementPending {
		t.Fatalf("first settle err=%v", err)
	}
	signer.awaitErr = &hedera.TransactionSubmittedError{TransactionID: signer.submitTx, Err: errors.New("INSUFFICIENT_TOKEN_BALANCE")}
	_, err := scheme.Settle(context.Background(), payload, req, nil)
	if got := settleReason(t, err); got.ErrorReason != facilitator.ErrTransactionFailed || got.Transaction != signer.submitTx {
		t.Fatalf("terminal receipt=%+v", got)
	}
	_, err = scheme.Settle(context.Background(), payload, req, nil)
	if got := settleReason(t, err); got.ErrorReason != facilitator.ErrReplay {
		t.Fatalf("after terminal reason=%s", got.ErrorReason)
	}
	if signer.submits != 1 {
		t.Fatalf("submits=%d want 1", signer.submits)
	}
}

func TestFacilitatorPendingKeyBindsPayloadAndRequirements(t *testing.T) {
	signer := newMockSigner()
	signer.submitErr = unknownOutcome(signer.submitTx)
	scheme := facilitator.NewExactHederaScheme(signer)
	req := baseRequirements()
	payload := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))
	if _, err := scheme.Settle(context.Background(), payload, req, nil); settleReason(t, err).ErrorReason != x402.ErrSettlementPending {
		t.Fatalf("first settle err=%v", err)
	}

	other := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))
	signer.submitErr = nil
	if settled, err := scheme.Settle(context.Background(), other, req, nil); err != nil || !settled.Success {
		t.Fatalf("other payload=%+v err=%v", settled, err)
	}

	tx := payload.Payload["transaction"].(string)
	mainnet := req
	mainnet.Network = hedera.HederaMainnetCAIP2
	otherPayTo := req
	otherPayTo.PayTo = "0.0.7002"
	for name, mismatched := range map[string]types.PaymentRequirements{"network": mainnet, "payTo": otherPayTo} {
		_, err := scheme.Settle(context.Background(), basePayload(mismatched, tx), mismatched, nil)
		if got := settleReason(t, err); got.ErrorReason == x402.ErrSettlementPending || got.Transaction != "" {
			t.Fatalf("pending record reused across %s: %+v", name, got)
		}
	}
	if len(signer.awaits) != 0 {
		t.Fatalf("unexpected reconcile: %v", signer.awaits)
	}

	signer.awaitErr = nil
	settled, err := scheme.Settle(context.Background(), payload, req, nil)
	if err != nil || !settled.Success || len(signer.awaits) != 1 {
		t.Fatalf("original requirements did not reconcile: %+v err=%v awaits=%v", settled, err, signer.awaits)
	}
}

type failingPendingStore struct{ x402.PendingSettlementStore }

func (failingPendingStore) Set(context.Context, string, string) error {
	return errors.New("store down")
}

func TestFacilitatorPendingStoreFailureIsTerminal(t *testing.T) {
	signer := newMockSigner()
	signer.submitErr = unknownOutcome(signer.submitTx)
	scheme := facilitator.NewExactHederaScheme(signer)
	scheme.SetPendingSettlementStore(failingPendingStore{x402.NewInMemoryPendingSettlementStore()})
	req := baseRequirements()
	payload := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))

	_, err := scheme.Settle(context.Background(), payload, req, nil)
	if got := settleReason(t, err); got.ErrorReason != facilitator.ErrTransactionFailed || got.Transaction != signer.submitTx {
		t.Fatalf("store failure=%+v", got)
	}
}

func TestFacilitatorConcurrentSettlementClaimsOnce(t *testing.T) {
	signer := &blockingSigner{
		mockSigner: newMockSigner(),
		started:    make(chan struct{}),
		release:    make(chan struct{}),
	}
	scheme := facilitator.NewExactHederaScheme(signer)
	req := baseRequirements()
	payload := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))

	firstDone := make(chan error, 1)
	go func() {
		_, err := scheme.Settle(context.Background(), payload, req, nil)
		firstDone <- err
	}()
	<-signer.started

	_, secondErr := scheme.Settle(context.Background(), payload, req, nil)
	var settleErr *x402.SettleError
	if !errors.As(secondErr, &settleErr) || settleErr.ErrorReason != facilitator.ErrReplay {
		t.Fatalf("expected replay while first settlement is in flight, got %T %v", secondErr, secondErr)
	}
	close(signer.release)
	if err := <-firstDone; err != nil {
		t.Fatalf("first settlement failed: %v", err)
	}
	if calls := signer.calls.Load(); calls != 1 {
		t.Fatalf("submit calls=%d want 1", calls)
	}
}

func TestFacilitatorReasonMatrix(t *testing.T) {
	signer := newMockSigner()
	scheme := facilitator.NewExactHederaScheme(signer)
	req := baseRequirements()

	t.Run("unsupported_scheme", func(t *testing.T) {
		bad := req
		bad.Scheme = "other"
		payload := basePayload(bad, "")
		_, err := scheme.Verify(context.Background(), payload, req, nil)
		if verifyReason(t, err) != facilitator.ErrUnsupportedScheme {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("accepted_mismatch", func(t *testing.T) {
		payload := basePayload(req, "")
		payload.Accepted.Amount = "999"
		_, err := scheme.Verify(context.Background(), payload, req, nil)
		if verifyReason(t, err) != facilitator.ErrAcceptedMismatch {
			t.Fatal(verifyReason(t, err))
		}
	})

	for _, tt := range []struct {
		name   string
		method interface{}
		reason string
	}{
		{name: "transfer_executor", method: hedera.AssetTransferMethodTransferExecutor, reason: facilitator.ErrUnsupportedAssetTransferMethod},
		{name: "unknown_method", method: "eip3009", reason: facilitator.ErrInvalidAssetTransferMethod},
		{name: "non_string_method", method: 1, reason: facilitator.ErrInvalidAssetTransferMethod},
	} {
		t.Run(tt.name, func(t *testing.T) {
			bad := req
			bad.Extra = map[string]interface{}{"feePayer": "0.0.5001", "assetTransferMethod": tt.method}
			_, err := scheme.Verify(context.Background(), basePayload(bad, ""), bad, nil)
			if verifyReason(t, err) != tt.reason {
				t.Fatal(verifyReason(t, err))
			}
		})
	}

	t.Run("explicit_crypto_transfer", func(t *testing.T) {
		explicit := req
		explicit.Extra = map[string]interface{}{"feePayer": "0.0.5001", "assetTransferMethod": hedera.AssetTransferMethodCryptoTransfer}
		payload := basePayload(explicit, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))
		if resp, err := scheme.Verify(context.Background(), payload, explicit, nil); err != nil || !resp.IsValid {
			t.Fatalf("resp=%+v err=%v", resp, err)
		}
	})

	t.Run("accepted_method_mismatch", func(t *testing.T) {
		executor := req
		executor.Extra = map[string]interface{}{"feePayer": "0.0.5001", "assetTransferMethod": hedera.AssetTransferMethodTransferExecutor}
		_, err := scheme.Verify(context.Background(), basePayload(req, ""), executor, nil)
		if verifyReason(t, err) != facilitator.ErrAcceptedMismatch {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("network_mismatch", func(t *testing.T) {
		payload := basePayload(req, "")
		payload.Accepted.Network = hedera.HederaMainnetCAIP2
		_, err := scheme.Verify(context.Background(), payload, req, nil)
		if verifyReason(t, err) != facilitator.ErrNetworkMismatch {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("invalid_asset", func(t *testing.T) {
		bad := req
		bad.Asset = "invalid"
		payload := basePayload(bad, "")
		_, err := scheme.Verify(context.Background(), payload, bad, nil)
		if verifyReason(t, err) != facilitator.ErrInvalidAsset {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("invalid_amount", func(t *testing.T) {
		bad := req
		bad.Amount = "1.23"
		payload := basePayload(bad, "")
		_, err := scheme.Verify(context.Background(), payload, bad, nil)
		if verifyReason(t, err) != facilitator.ErrInvalidAmount {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("missing_fee_payer", func(t *testing.T) {
		bad := req
		bad.Extra = map[string]interface{}{}
		payload := basePayload(bad, "")
		_, err := scheme.Verify(context.Background(), payload, bad, nil)
		if verifyReason(t, err) != facilitator.ErrMissingFeePayer {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("fee_payer_not_managed", func(t *testing.T) {
		s := newMockSigner()
		s.addresses = []string{"0.0.9999"}
		_, err := facilitator.NewExactHederaScheme(s).Verify(context.Background(), basePayload(req, ""), req, nil)
		if verifyReason(t, err) != facilitator.ErrFeePayerNotManaged {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("fee_payer_mismatch", func(t *testing.T) {
		payload := basePayload(req, createTransferB64(t, "0.0.5002", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))
		_, err := scheme.Verify(context.Background(), payload, req, nil)
		if verifyReason(t, err) != facilitator.ErrFeePayerMismatch {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("non_transfer", func(t *testing.T) {
		payload := basePayload(req, createTopicB64(t, "0.0.5001"))
		_, err := scheme.Verify(context.Background(), payload, req, nil)
		if verifyReason(t, err) != facilitator.ErrNonTransferOps {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("signature_invalid", func(t *testing.T) {
		s := newMockSigner()
		s.sig = hedera.SignatureCheck{OK: false, Reason: "bad_sig", Message: "nope"}
		payload := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))
		_, err := facilitator.NewExactHederaScheme(s).Verify(context.Background(), payload, req, nil)
		if verifyReason(t, err) != facilitator.ErrSignatureInvalid {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("preflight_failed", func(t *testing.T) {
		s := newMockSigner()
		s.preflight = hedera.SignatureCheck{OK: false, Reason: "insufficient_balance", Message: "low"}
		payload := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000"))
		_, err := facilitator.NewExactHederaScheme(s).Verify(context.Background(), payload, req, nil)
		if verifyReason(t, err) != facilitator.ErrPreflightFailed {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("amount_mismatch", func(t *testing.T) {
		payload := basePayload(req, createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "500"))
		_, err := scheme.Verify(context.Background(), payload, req, nil)
		if verifyReason(t, err) != facilitator.ErrAmountMismatch {
			t.Fatal(verifyReason(t, err))
		}
	})

	t.Run("fee_payer_debit_hbar", func(t *testing.T) {
		hbarReq := req
		hbarReq.Asset = hedera.HBARAssetID
		hbarReq.Amount = "50"
		payload := basePayload(hbarReq, createTransferB64(t, "0.0.5001", "0.0.5001", "0.0.7001", hedera.HBARAssetID, "50"))
		_, err := scheme.Verify(context.Background(), payload, hbarReq, nil)
		reason := verifyReason(t, err)
		if reason != facilitator.ErrFeePayerTransferringHbar && reason != facilitator.ErrFeePayerTransferringFunds {
			t.Fatalf("reason=%s", reason)
		}
	})

	t.Run("replay", func(t *testing.T) {
		cache := hedera.NewSettlementCache()
		s := newMockSigner()
		scheme := facilitator.NewExactHederaScheme(s, cache)
		tx := createTransferB64(t, "0.0.5001", "0.0.9001", "0.0.7001", "0.0.6001", "1000")
		payload := basePayload(req, tx)
		if _, err := scheme.Settle(context.Background(), payload, req, nil); err != nil {
			t.Fatal(err)
		}
		_, err := scheme.Verify(context.Background(), payload, req, nil)
		if verifyReason(t, err) != facilitator.ErrReplay {
			t.Fatal(verifyReason(t, err))
		}
	})
}

func TestFacilitatorGetExtraAndSigners(t *testing.T) {
	signer := newMockSigner()
	scheme := facilitator.NewExactHederaScheme(signer)
	if scheme.Scheme() != hedera.SchemeExact || scheme.CaipFamily() != "hedera:*" {
		t.Fatal("scheme identity")
	}
	extra := scheme.GetExtra(x402.Network(hedera.HederaTestnetCAIP2))
	if fee, _ := extra["feePayer"].(string); fee != "0.0.5001" {
		t.Fatalf("extra=%v", extra)
	}
	signers := scheme.GetSigners(x402.Network(hedera.HederaTestnetCAIP2))
	if len(signers) != 1 || signers[0] != "0.0.5001" {
		t.Fatalf("signers=%v", signers)
	}
}
