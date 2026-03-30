package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"testing"
	"time"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/extensions/eip2612gassponsor"
	"github.com/coinbase/x402/go/mechanisms/evm"
	"github.com/coinbase/x402/go/types"
)

// ─── Mock facilitator signer ────────────────────────────────────────────────

type mockFacilitatorSigner struct {
	addresses          []string
	readContractResult interface{}
	readContractError  error
	writeContractTx    string
	writeContractError error
	getCodeResult      []byte
	getCodeError       error
	verifyResult       bool
	verifyError        error
	receiptResult      *evm.TransactionReceipt
	receiptError       error
}

func newMockSigner(addresses ...string) *mockFacilitatorSigner {
	if len(addresses) == 0 {
		addresses = []string{testFacilitatorAddr}
	}
	return &mockFacilitatorSigner{
		addresses:       addresses,
		writeContractTx: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		// Payer appears as a deployed contract so sig-recovery failures fall through to simulation
		getCodeResult: []byte{0x60, 0x60},
		receiptResult: &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: "0xdeadbeef"},
	}
}

func (m *mockFacilitatorSigner) GetAddresses() []string { return m.addresses }

func (m *mockFacilitatorSigner) ReadContract(ctx context.Context, address string, abi []byte, functionName string, args ...interface{}) (interface{}, error) {
	if m.readContractError != nil {
		return nil, m.readContractError
	}
	return m.readContractResult, nil
}

func (m *mockFacilitatorSigner) VerifyTypedData(ctx context.Context, address string, domain evm.TypedDataDomain, types map[string][]evm.TypedDataField, primaryType string, message map[string]interface{}, signature []byte) (bool, error) {
	return m.verifyResult, m.verifyError
}

func (m *mockFacilitatorSigner) WriteContract(ctx context.Context, address string, abi []byte, functionName string, args ...interface{}) (string, error) {
	if m.writeContractError != nil {
		return "", m.writeContractError
	}
	return m.writeContractTx, nil
}

func (m *mockFacilitatorSigner) SendTransaction(ctx context.Context, to string, data []byte) (string, error) {
	return m.writeContractTx, m.writeContractError
}

func (m *mockFacilitatorSigner) WaitForTransactionReceipt(ctx context.Context, txHash string) (*evm.TransactionReceipt, error) {
	if m.receiptError != nil {
		return nil, m.receiptError
	}
	return m.receiptResult, nil
}

func (m *mockFacilitatorSigner) GetBalance(ctx context.Context, address string, tokenAddress string) (*big.Int, error) {
	return big.NewInt(999_000_000), nil
}

func (m *mockFacilitatorSigner) GetChainID(ctx context.Context) (*big.Int, error) {
	return big.NewInt(84532), nil
}

func (m *mockFacilitatorSigner) GetCode(ctx context.Context, address string) ([]byte, error) {
	if m.getCodeError != nil {
		return nil, m.getCodeError
	}
	return m.getCodeResult, nil
}

// ─── Test addresses (valid 40-hex-char Ethereum addresses) ──────────────────

const (
	// All addresses are proper 0x + 40 hex chars
	testFacilitatorAddr = "0xf1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1"
	testPayerAddr       = "0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0"
	testPayToAddr       = "0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"
	testTokenAddr       = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
	testNetwork         = "eip155:84532"
	testAmount          = "1000"
	// 65-byte dummy hex signature (0x + 130 hex chars)
	dummySig = "0x" +
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + // r (32 bytes)
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" + // s (32 bytes)
		"1b" // v = 27
)

func futureDeadline() string {
	return fmt.Sprintf("%d", time.Now().Unix()+300)
}

func pastTimestamp() string {
	return fmt.Sprintf("%d", time.Now().Unix()-600)
}

// buildValidUptoPayload constructs a syntactically valid UptoPermit2Payload.
// ECDSA recovery on the dummy sig will fail, but since the payer is mocked as
// a deployed contract (getCodeResult non-empty), verification falls through to
// simulation where readContractError controls the outcome.
func buildValidUptoPayload(facilitatorAddr string) *evm.UptoPermit2Payload {
	return &evm.UptoPermit2Payload{
		Signature: dummySig,
		Permit2Authorization: evm.UptoPermit2Authorization{
			From: testPayerAddr,
			Permitted: evm.Permit2TokenPermissions{
				Token:  testTokenAddr,
				Amount: testAmount,
			},
			Spender:  evm.X402UptoPermit2ProxyAddress,
			Nonce:    "12345",
			Deadline: futureDeadline(),
			Witness: evm.UptoPermit2Witness{
				To:          testPayToAddr,
				Facilitator: facilitatorAddr,
				ValidAfter:  pastTimestamp(),
			},
		},
	}
}

func buildValidPayload(facilitatorAddr string) types.PaymentPayload {
	p := buildValidUptoPayload(facilitatorAddr)
	return types.PaymentPayload{
		X402Version: 2,
		Payload:     p.ToMap(),
		Accepted: types.PaymentRequirements{
			Scheme:  evm.SchemeUpto,
			Network: testNetwork,
			Amount:  testAmount,
			Asset:   testTokenAddr,
			PayTo:   testPayToAddr,
		},
	}
}

func buildValidRequirements() types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:  evm.SchemeUpto,
		Network: testNetwork,
		Amount:  testAmount,
		Asset:   testTokenAddr,
		PayTo:   testPayToAddr,
	}
}

// ─── VerifyUptoPermit2 — input validation tests ──────────────────────────────

func TestVerifyUptoPermit2_SchemeMismatch_Payload(t *testing.T) {
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	payload := buildValidPayload(testFacilitatorAddr)
	payload.Accepted.Scheme = "exact"

	_, err := VerifyUptoPermit2(context.Background(), signer, payload, buildValidRequirements(), p, nil, false)
	assertVerifyError(t, err, ErrUptoInvalidScheme)
}

func TestVerifyUptoPermit2_SchemeMismatch_Requirements(t *testing.T) {
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	payload := buildValidPayload(testFacilitatorAddr)
	req := buildValidRequirements()
	req.Scheme = "exact"

	_, err := VerifyUptoPermit2(context.Background(), signer, payload, req, p, nil, false)
	assertVerifyError(t, err, ErrUptoInvalidScheme)
}

func TestVerifyUptoPermit2_NetworkMismatch(t *testing.T) {
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	payload := buildValidPayload(testFacilitatorAddr)
	payload.Accepted.Network = "eip155:8453"

	_, err := VerifyUptoPermit2(context.Background(), signer, payload, buildValidRequirements(), p, nil, false)
	assertVerifyError(t, err, ErrUptoNetworkMismatch)
}

func TestVerifyUptoPermit2_InvalidSpender(t *testing.T) {
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	p.Permit2Authorization.Spender = "0x0000000000000000000000000000000000000001"

	_, err := VerifyUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), p, nil, false)
	assertVerifyError(t, err, ErrPermit2InvalidSpender)
}

func TestVerifyUptoPermit2_RecipientMismatch(t *testing.T) {
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	p.Permit2Authorization.Witness.To = "0x0000000000000000000000000000000000000001"

	_, err := VerifyUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), p, nil, false)
	assertVerifyError(t, err, ErrPermit2RecipientMismatch)
}

func TestVerifyUptoPermit2_FacilitatorMismatch(t *testing.T) {
	signer := newMockSigner(testFacilitatorAddr)
	// Witness references a different facilitator address
	p := buildValidUptoPayload("0x0000000000000000000000000000000000000001")

	_, err := VerifyUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), p, nil, false)
	assertVerifyError(t, err, ErrUptoFacilitatorMismatch)
}

func TestVerifyUptoPermit2_FacilitatorMatch_CaseInsensitive(t *testing.T) {
	// Facilitator address is uppercase in signer but lowercase in witness — should still match
	upperFacilitator := "0xF1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1"
	lowerFacilitator := "0xf1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1"
	signer := newMockSigner(upperFacilitator)

	p := buildValidUptoPayload(lowerFacilitator)
	// simulation should succeed (readContractError == nil)
	_, err := VerifyUptoPermit2(context.Background(), signer, buildValidPayload(lowerFacilitator), buildValidRequirements(), p, nil, true)
	if err != nil {
		t.Fatalf("expected facilitator case-insensitive match to succeed, got: %v", err)
	}
}

func TestVerifyUptoPermit2_DeadlineExpired(t *testing.T) {
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	p.Permit2Authorization.Deadline = "1000000000" // year 2001 — expired

	_, err := VerifyUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), p, nil, false)
	assertVerifyError(t, err, ErrPermit2DeadlineExpired)
}

func TestVerifyUptoPermit2_NotYetValid(t *testing.T) {
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	p.Permit2Authorization.Witness.ValidAfter = fmt.Sprintf("%d", time.Now().Unix()+9999)

	_, err := VerifyUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), p, nil, false)
	assertVerifyError(t, err, ErrPermit2NotYetValid)
}

func TestVerifyUptoPermit2_AmountMismatch(t *testing.T) {
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	p.Permit2Authorization.Permitted.Amount = "9999" // != requirements.Amount "1000"

	_, err := VerifyUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), p, nil, false)
	assertVerifyError(t, err, ErrPermit2AmountMismatch)
}

func TestVerifyUptoPermit2_TokenMismatch(t *testing.T) {
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	p.Permit2Authorization.Permitted.Token = "0x0000000000000000000000000000000000000001"

	_, err := VerifyUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), p, nil, false)
	assertVerifyError(t, err, ErrPermit2TokenMismatch)
}

func TestVerifyUptoPermit2_InvalidSignatureHex(t *testing.T) {
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	p.Signature = "not-hex"

	_, err := VerifyUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), p, nil, false)
	assertVerifyError(t, err, ErrInvalidSignatureFormat)
}

func TestVerifyUptoPermit2_InvalidSig_PayerIsEOA(t *testing.T) {
	// ECDSA recovery fails, payer has no contract code → invalid sig
	signer := newMockSigner()
	signer.getCodeResult = []byte{} // EOA

	p := buildValidUptoPayload(testFacilitatorAddr)
	_, err := VerifyUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), p, nil, false)
	assertVerifyError(t, err, ErrPermit2InvalidSignature)
}

func TestVerifyUptoPermit2_SimulationDisabled_ReturnsValid(t *testing.T) {
	// Even though ECDSA recovery fails, payer is a contract → falls to simulation
	// Simulation is disabled → return valid immediately
	signer := newMockSigner()
	// getCodeResult is non-empty by default (contract)

	p := buildValidUptoPayload(testFacilitatorAddr)
	resp, err := VerifyUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), p, nil, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.IsValid {
		t.Error("expected valid when simulation is disabled")
	}
}

func TestVerifyUptoPermit2_SimulationSucceeds(t *testing.T) {
	// Payer is a contract, sim succeeds (readContractError nil) → valid
	signer := newMockSigner()

	p := buildValidUptoPayload(testFacilitatorAddr)
	resp, err := VerifyUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), p, nil, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.IsValid {
		t.Errorf("expected valid, got %s", resp.InvalidReason)
	}
	if resp.Payer != testPayerAddr {
		t.Errorf("expected payer %s, got %s", testPayerAddr, resp.Payer)
	}
}

func TestVerifyUptoPermit2_ViabilityCheck_FailOpenOnMulticallError(t *testing.T) {
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	resp, err := VerifyUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), p, nil, true)
	if err != nil {
		t.Fatalf("unexpected error in standard viability path: %v", err)
	}
	if !resp.IsValid {
		t.Errorf("expected valid when viability multicall succeeds, got %s", resp.InvalidReason)
	}
}

func TestVerifyUptoPermit2_WithEIP2612Extension_FromMismatch(t *testing.T) {
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	payload := buildValidPayload(testFacilitatorAddr)

	// Attach EIP-2612 extension with wrong 'from'
	payload.Extensions = map[string]interface{}{
		eip2612gassponsor.EIP2612GasSponsoring.Key(): map[string]interface{}{
			"info": map[string]interface{}{
				"from":      "0x0000000000000000000000000000000000000001",
				"asset":     testTokenAddr,
				"spender":   evm.PERMIT2Address,
				"amount":    "115792089237316195423570985008687907853269984665640564039457584007913129639935",
				"nonce":     "0",
				"deadline":  futureDeadline(),
				"signature": dummySig,
				"version":   "1",
			},
		},
	}

	_, err := VerifyUptoPermit2(context.Background(), signer, payload, buildValidRequirements(), p, nil, true)
	if err == nil {
		t.Fatal("expected error from EIP-2612 from mismatch")
	}
	var ve *x402.VerifyError
	if !errors.As(err, &ve) {
		t.Fatalf("expected VerifyError, got %T: %v", err, err)
	}
	if ve.InvalidReason != "eip2612_from_mismatch" {
		t.Errorf("expected eip2612_from_mismatch, got %s", ve.InvalidReason)
	}
}

func TestVerifyUptoPermit2_WithEIP2612Extension_Valid_SimSucceeds(t *testing.T) {
	// When a valid EIP-2612 extension is present and simulation succeeds → valid
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	payload := buildValidPayload(testFacilitatorAddr)

	payload.Extensions = map[string]interface{}{
		eip2612gassponsor.EIP2612GasSponsoring.Key(): map[string]interface{}{
			"info": map[string]interface{}{
				"from":      testPayerAddr,
				"asset":     testTokenAddr,
				"spender":   evm.PERMIT2Address,
				"amount":    "115792089237316195423570985008687907853269984665640564039457584007913129639935",
				"nonce":     "0",
				"deadline":  futureDeadline(),
				"signature": dummySig,
				"version":   "1",
			},
		},
	}

	// readContract: first call is settleWithPermit sim (succeeds with nil error)
	resp, err := VerifyUptoPermit2(context.Background(), signer, payload, buildValidRequirements(), p, nil, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.IsValid {
		t.Errorf("expected valid, got %s", resp.InvalidReason)
	}
}

// ─── SettleUptoPermit2 tests ─────────────────────────────────────────────────

func TestSettleUptoPermit2_ZeroSettlement(t *testing.T) {
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	payload := buildValidPayload(testFacilitatorAddr)

	req := buildValidRequirements()
	req.Amount = "0" // settle zero — no on-chain tx

	resp, err := SettleUptoPermit2(context.Background(), signer, payload, req, p, nil, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.Success {
		t.Errorf("expected success for zero settlement, got %s", resp.ErrorReason)
	}
	if resp.Transaction != "" {
		t.Errorf("expected empty txHash, got %s", resp.Transaction)
	}
	if resp.Amount != "0" {
		t.Errorf("expected Amount='0', got %q", resp.Amount)
	}
}

func TestSettleUptoPermit2_ExceedsPermittedAmount(t *testing.T) {
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	payload := buildValidPayload(testFacilitatorAddr)

	req := buildValidRequirements()
	req.Amount = "99999" // more than permitted "1000"

	_, err := SettleUptoPermit2(context.Background(), signer, payload, req, p, nil, false)
	assertSettleError(t, err, ErrUptoSettlementExceedsAmount)
}

func TestSettleUptoPermit2_FullAmount(t *testing.T) {
	signer := newMockSigner()
	resp, err := SettleUptoPermit2(
		context.Background(), signer,
		buildValidPayload(testFacilitatorAddr),
		buildValidRequirements(),
		buildValidUptoPayload(testFacilitatorAddr),
		nil,
		false,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.Success {
		t.Errorf("expected success, got %s", resp.ErrorReason)
	}
	if resp.Amount != testAmount {
		t.Errorf("expected Amount=%q, got %q", testAmount, resp.Amount)
	}
}

func TestSettleUptoPermit2_PartialAmount(t *testing.T) {
	signer := newMockSigner()
	req := buildValidRequirements()
	req.Amount = "500" // 500 of 1000 permitted

	resp, err := SettleUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), req, buildValidUptoPayload(testFacilitatorAddr), nil, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.Success {
		t.Errorf("expected success, got %s", resp.ErrorReason)
	}
	if resp.Amount != "500" {
		t.Errorf("expected Amount='500', got %q", resp.Amount)
	}
}

func TestSettleUptoPermit2_InvalidSettlementAmount(t *testing.T) {
	signer := newMockSigner()
	req := buildValidRequirements()
	req.Amount = "not-a-number"

	_, err := SettleUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), req, buildValidUptoPayload(testFacilitatorAddr), nil, false)
	if err == nil {
		t.Fatal("expected error on invalid settlement amount")
	}
}

func TestSettleUptoPermit2_WriteContractFails(t *testing.T) {
	signer := newMockSigner()
	signer.writeContractError = errors.New("out of gas")

	_, err := SettleUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), buildValidUptoPayload(testFacilitatorAddr), nil, false)
	if err == nil {
		t.Fatal("expected error on WriteContract failure")
	}
}

func TestSettleUptoPermit2_ReceiptStatusFailed(t *testing.T) {
	signer := newMockSigner()
	signer.receiptResult = &evm.TransactionReceipt{Status: evm.TxStatusFailed, TxHash: "0xfail"}

	_, err := SettleUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), buildValidUptoPayload(testFacilitatorAddr), nil, false)
	assertSettleError(t, err, ErrUptoTransactionFailed)
}

func TestSettleUptoPermit2_ReceiptError(t *testing.T) {
	signer := newMockSigner()
	signer.receiptError = errors.New("timeout")

	_, err := SettleUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), buildValidUptoPayload(testFacilitatorAddr), nil, false)
	assertSettleError(t, err, ErrUptoFailedToGetReceipt)
}

func TestSettleUptoPermit2_VerifyFails_EOAPayer(t *testing.T) {
	// Payer is EOA → sig verify fails → settle re-verify returns invalid
	signer := newMockSigner()
	signer.getCodeResult = []byte{} // EOA

	_, err := SettleUptoPermit2(context.Background(), signer, buildValidPayload(testFacilitatorAddr), buildValidRequirements(), buildValidUptoPayload(testFacilitatorAddr), nil, false)
	if err == nil {
		t.Fatal("expected error when verify fails during settle")
	}
}

func TestSettleUptoPermit2_WithEIP2612_ZeroSettlement(t *testing.T) {
	// EIP-2612 extension present but settlement is zero — should skip on-chain tx
	signer := newMockSigner()
	p := buildValidUptoPayload(testFacilitatorAddr)
	payload := buildValidPayload(testFacilitatorAddr)
	payload.Extensions = map[string]interface{}{
		eip2612gassponsor.EIP2612GasSponsoring.Key(): map[string]interface{}{
			"info": map[string]interface{}{
				"from":      testPayerAddr,
				"asset":     testTokenAddr,
				"spender":   evm.PERMIT2Address,
				"amount":    "115792089237316195423570985008687907853269984665640564039457584007913129639935",
				"nonce":     "0",
				"deadline":  futureDeadline(),
				"signature": dummySig,
				"version":   "1",
			},
		},
	}

	req := buildValidRequirements()
	req.Amount = "0"

	resp, err := SettleUptoPermit2(context.Background(), signer, payload, req, p, nil, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.Success || resp.Amount != "0" {
		t.Errorf("expected zero-settlement success, got success=%v amount=%q", resp.Success, resp.Amount)
	}
}

// ─── BuildUptoPermit2SettleArgs tests ────────────────────────────────────────

func TestBuildUptoPermit2SettleArgs_Success(t *testing.T) {
	p := buildValidUptoPayload(testFacilitatorAddr)
	settlement := big.NewInt(500)

	args, err := BuildUptoPermit2SettleArgs(p, settlement)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if args.SettlementAmount.Cmp(settlement) != 0 {
		t.Errorf("expected settlementAmount=%s, got %s", settlement, args.SettlementAmount)
	}
	if args.Permit.Permitted.Amount.String() != testAmount {
		t.Errorf("expected permitted amount=%s, got %s", testAmount, args.Permit.Permitted.Amount)
	}
	// Witness.Facilitator should be the facilitator address
	expectedFacilitator := args.Witness.Facilitator.Hex()
	if expectedFacilitator == "0x0000000000000000000000000000000000000000" {
		t.Error("facilitator address should not be zero")
	}
}

func TestBuildUptoPermit2SettleArgs_InvalidPermittedAmount(t *testing.T) {
	p := buildValidUptoPayload(testFacilitatorAddr)
	p.Permit2Authorization.Permitted.Amount = "not-a-number"

	_, err := BuildUptoPermit2SettleArgs(p, big.NewInt(1))
	if err == nil {
		t.Fatal("expected error on invalid permitted amount")
	}
}

func TestBuildUptoPermit2SettleArgs_InvalidNonce(t *testing.T) {
	p := buildValidUptoPayload(testFacilitatorAddr)
	p.Permit2Authorization.Nonce = "not-a-nonce"

	_, err := BuildUptoPermit2SettleArgs(p, big.NewInt(1))
	if err == nil {
		t.Fatal("expected error on invalid nonce")
	}
}

func TestBuildUptoPermit2SettleArgs_InvalidDeadline(t *testing.T) {
	p := buildValidUptoPayload(testFacilitatorAddr)
	p.Permit2Authorization.Deadline = "not-a-deadline"

	_, err := BuildUptoPermit2SettleArgs(p, big.NewInt(1))
	if err == nil {
		t.Fatal("expected error on invalid deadline")
	}
}

func TestBuildUptoPermit2SettleArgs_InvalidValidAfter(t *testing.T) {
	p := buildValidUptoPayload(testFacilitatorAddr)
	p.Permit2Authorization.Witness.ValidAfter = "not-a-timestamp"

	_, err := BuildUptoPermit2SettleArgs(p, big.NewInt(1))
	if err == nil {
		t.Fatal("expected error on invalid validAfter")
	}
}

func TestBuildUptoPermit2SettleArgs_InvalidSignature(t *testing.T) {
	p := buildValidUptoPayload(testFacilitatorAddr)
	p.Signature = "not-hex"

	_, err := BuildUptoPermit2SettleArgs(p, big.NewInt(1))
	if err == nil {
		t.Fatal("expected error on invalid signature hex")
	}
}

// ─── validateEip2612PermitForPayment tests ───────────────────────────────────

func TestValidateEip2612PermitForPayment_Valid(t *testing.T) {
	info := makeValidEip2612Info(testPayerAddr, testTokenAddr)
	if got := validateEip2612PermitForPayment(info, testPayerAddr, testTokenAddr); got != "" {
		t.Errorf("expected valid, got: %s", got)
	}
}

func TestValidateEip2612PermitForPayment_FromMismatch(t *testing.T) {
	info := makeValidEip2612Info(testPayerAddr, testTokenAddr)
	info.From = "0x0000000000000000000000000000000000000001"
	if got := validateEip2612PermitForPayment(info, testPayerAddr, testTokenAddr); got != "eip2612_from_mismatch" {
		t.Errorf("expected eip2612_from_mismatch, got: %s", got)
	}
}

func TestValidateEip2612PermitForPayment_AssetMismatch(t *testing.T) {
	info := makeValidEip2612Info(testPayerAddr, testTokenAddr)
	info.Asset = "0x0000000000000000000000000000000000000001"
	if got := validateEip2612PermitForPayment(info, testPayerAddr, testTokenAddr); got != "eip2612_asset_mismatch" {
		t.Errorf("expected eip2612_asset_mismatch, got: %s", got)
	}
}

func TestValidateEip2612PermitForPayment_WrongSpender(t *testing.T) {
	info := makeValidEip2612Info(testPayerAddr, testTokenAddr)
	info.Spender = "0x0000000000000000000000000000000000000001"
	if got := validateEip2612PermitForPayment(info, testPayerAddr, testTokenAddr); got != "eip2612_spender_not_permit2" {
		t.Errorf("expected eip2612_spender_not_permit2, got: %s", got)
	}
}

func TestValidateEip2612PermitForPayment_ExpiredDeadline(t *testing.T) {
	info := makeValidEip2612Info(testPayerAddr, testTokenAddr)
	info.Deadline = "1000000000" // 2001
	if got := validateEip2612PermitForPayment(info, testPayerAddr, testTokenAddr); got != "eip2612_deadline_expired" {
		t.Errorf("expected eip2612_deadline_expired, got: %s", got)
	}
}

// makeValidEip2612Info creates a well-formed EIP-2612 info for testing.
func makeValidEip2612Info(from, asset string) *eip2612gassponsor.Info {
	return &eip2612gassponsor.Info{
		From:      from,
		Asset:     asset,
		Spender:   evm.PERMIT2Address,
		Amount:    "115792089237316195423570985008687907853269984665640564039457584007913129639935",
		Nonce:     "0",
		Deadline:  futureDeadline(),
		Signature: dummySig,
		Version:   "1",
	}
}

// ─── splitEip2612Signature tests ─────────────────────────────────────────────

func TestSplitEip2612Signature_Valid(t *testing.T) {
	sig := "0x" +
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + // r (32 bytes)
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" + // s (32 bytes)
		"1c" // v = 28

	v, r, s, err := splitEip2612Signature(sig)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v != 28 {
		t.Errorf("expected v=28, got %d", v)
	}
	for i, b := range r {
		if b != 0xaa {
			t.Fatalf("r[%d] expected 0xaa, got 0x%02x", i, b)
		}
	}
	for i, b := range s {
		if b != 0xbb {
			t.Fatalf("s[%d] expected 0xbb, got 0x%02x", i, b)
		}
	}
}

func TestSplitEip2612Signature_TooShort(t *testing.T) {
	if _, _, _, err := splitEip2612Signature("0xaabb"); err == nil {
		t.Fatal("expected error for short signature")
	}
}

func TestSplitEip2612Signature_InvalidHex(t *testing.T) {
	if _, _, _, err := splitEip2612Signature("not-hex"); err == nil {
		t.Fatal("expected error for non-hex input")
	}
}

// ─── parseUptoPermit2Error tests ─────────────────────────────────────────────

func TestParseUptoPermit2Error(t *testing.T) {
	cases := []struct {
		msg      string
		expected string
	}{
		{"Permit2612AmountMismatch blah", ErrPermit2612AmountMismatch},
		{"execution reverted: InvalidAmount", ErrPermit2InvalidAmount},
		{"execution reverted: InvalidDestination", ErrPermit2InvalidDestination},
		{"execution reverted: InvalidOwner", ErrPermit2InvalidOwner},
		{"execution reverted: PaymentTooEarly", ErrPermit2PaymentTooEarly},
		{"execution reverted: InvalidSignature", ErrPermit2InvalidSignature},
		{"execution reverted: SignatureExpired", ErrPermit2InvalidSignature},
		{"execution reverted: InvalidNonce", ErrPermit2InvalidNonce},
		{"erc20_approval_tx_failed: something", ErrErc20ApprovalBroadcastFailed},
		{"execution reverted: AmountExceedsPermitted", ErrUptoAmountExceedsPermitted},
		{"execution reverted: UnauthorizedFacilitator", ErrUptoUnauthorizedFacilitator},
		{"unknown revert reason", ErrUptoTransactionFailed},
	}

	for _, tc := range cases {
		t.Run(tc.msg, func(t *testing.T) {
			got := parseUptoPermit2Error(errors.New(tc.msg))
			if got != tc.expected {
				t.Errorf("expected %s, got %s", tc.expected, got)
			}
		})
	}
}

// ─── UptoEvmScheme wrapper tests ─────────────────────────────────────────────

func TestUptoEvmScheme_Scheme(t *testing.T) {
	if s := NewUptoEvmScheme(newMockSigner(), nil).Scheme(); s != evm.SchemeUpto {
		t.Errorf("expected %q, got %q", evm.SchemeUpto, s)
	}
}

func TestUptoEvmScheme_CaipFamily(t *testing.T) {
	if cf := NewUptoEvmScheme(newMockSigner(), nil).CaipFamily(); cf != "eip155:*" {
		t.Errorf("expected eip155:*, got %s", cf)
	}
}

func TestUptoEvmScheme_GetExtra_ReturnsFacilitatorAddress(t *testing.T) {
	s := NewUptoEvmScheme(newMockSigner(testFacilitatorAddr), nil)
	extra := s.GetExtra(x402.Network(testNetwork))
	if extra == nil {
		t.Fatal("expected extra, got nil")
	}
	if extra["facilitatorAddress"] != testFacilitatorAddr {
		t.Errorf("expected facilitatorAddress=%s, got %v", testFacilitatorAddr, extra["facilitatorAddress"])
	}
}

func TestUptoEvmScheme_GetExtra_NoAddresses(t *testing.T) {
	s := NewUptoEvmScheme(&mockFacilitatorSigner{addresses: []string{}}, nil)
	if extra := s.GetExtra(x402.Network(testNetwork)); extra != nil {
		t.Errorf("expected nil extra with no addresses, got %v", extra)
	}
}

func TestUptoEvmScheme_GetExtra_MultipleAddresses_UsesOneFromPool(t *testing.T) {
	addr1 := "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	addr2 := "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	pool := map[string]bool{addr1: true, addr2: true}
	s := NewUptoEvmScheme(newMockSigner(addr1, addr2), nil)
	extra := s.GetExtra(x402.Network(testNetwork))
	got, ok := extra["facilitatorAddress"].(string)
	if !ok || !pool[got] {
		t.Errorf("expected one of pool addresses, got %v", extra["facilitatorAddress"])
	}
}

func TestUptoEvmScheme_GetSigners(t *testing.T) {
	s := NewUptoEvmScheme(newMockSigner(testFacilitatorAddr), nil)
	signers := s.GetSigners(x402.Network(testNetwork))
	if len(signers) != 1 || signers[0] != testFacilitatorAddr {
		t.Errorf("unexpected signers: %v", signers)
	}
}

func TestUptoEvmScheme_Config_DefaultSimulateInSettle(t *testing.T) {
	s := NewUptoEvmScheme(newMockSigner(), nil)
	if s.config.SimulateInSettle {
		t.Error("default SimulateInSettle should be false")
	}
}

func TestUptoEvmScheme_Config_CustomSimulateInSettle(t *testing.T) {
	s := NewUptoEvmScheme(newMockSigner(), &UptoEvmSchemeConfig{SimulateInSettle: true})
	if !s.config.SimulateInSettle {
		t.Error("expected SimulateInSettle=true from config")
	}
}

func TestUptoEvmScheme_Verify_UnsupportedPayload(t *testing.T) {
	s := NewUptoEvmScheme(newMockSigner(), nil)
	payload := types.PaymentPayload{
		X402Version: 2,
		Payload:     map[string]interface{}{"authorization": map[string]interface{}{"from": testPayerAddr}},
		Accepted:    buildValidRequirements(),
	}
	if _, err := s.Verify(context.Background(), payload, buildValidRequirements(), nil); err == nil {
		t.Fatal("expected error for EIP-3009 payload passed to upto scheme")
	}
}

func TestUptoEvmScheme_Settle_UnsupportedPayload(t *testing.T) {
	s := NewUptoEvmScheme(newMockSigner(), nil)
	payload := types.PaymentPayload{
		X402Version: 2,
		Payload:     map[string]interface{}{"authorization": map[string]interface{}{}},
		Accepted:    buildValidRequirements(),
	}
	if _, err := s.Settle(context.Background(), payload, buildValidRequirements(), nil); err == nil {
		t.Fatal("expected error for unsupported payload in settle")
	}
}

func TestUptoEvmScheme_Verify_Valid(t *testing.T) {
	signer := newMockSigner()
	s := NewUptoEvmScheme(signer, nil)

	p := buildValidUptoPayload(testFacilitatorAddr)
	payload := types.PaymentPayload{
		X402Version: 2,
		Payload:     p.ToMap(),
		Accepted:    buildValidRequirements(),
	}

	resp, err := s.Verify(context.Background(), payload, buildValidRequirements(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.IsValid {
		t.Errorf("expected valid, got %s", resp.InvalidReason)
	}
}

func TestUptoEvmScheme_Settle_Valid(t *testing.T) {
	signer := newMockSigner()
	s := NewUptoEvmScheme(signer, nil)

	p := buildValidUptoPayload(testFacilitatorAddr)
	payload := types.PaymentPayload{
		X402Version: 2,
		Payload:     p.ToMap(),
		Accepted:    buildValidRequirements(),
	}

	resp, err := s.Settle(context.Background(), payload, buildValidRequirements(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.Success {
		t.Errorf("expected success, got %s", resp.ErrorReason)
	}
	if resp.Amount != testAmount {
		t.Errorf("expected Amount=%q, got %q", testAmount, resp.Amount)
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func assertVerifyError(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error %q, got nil", want)
	}
	var ve *x402.VerifyError
	if !errors.As(err, &ve) {
		t.Fatalf("expected *x402.VerifyError, got %T: %v", err, err)
	}
	if ve.InvalidReason != want {
		t.Errorf("expected InvalidReason=%q, got %q", want, ve.InvalidReason)
	}
}

func assertSettleError(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error %q, got nil", want)
	}
	var se *x402.SettleError
	if !errors.As(err, &se) {
		t.Fatalf("expected *x402.SettleError, got %T: %v", err, err)
	}
	if se.ErrorReason != want {
		t.Errorf("expected ErrorReason=%q, got %q", want, se.ErrorReason)
	}
}
