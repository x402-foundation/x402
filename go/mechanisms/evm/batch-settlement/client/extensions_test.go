package client

import (
	"context"
	"math/big"
	"testing"

	"github.com/x402-foundation/x402/go/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/types"
)

const (
	extTestNetwork = "eip155:8453"
	extTestAsset   = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" // USDC Base
	extTestPayTo   = "0x3333333333333333333333333333333333333333"
	extTestSigner  = "0x4444444444444444444444444444444444444444"
)

// extReadSigner combines mockSigner with read-contract + tx-signing capabilities
// so the extension paths in extensions.go can resolve the signer through the
// `evm.ClientEvmSignerWithReadContract` and `evm.ClientEvmSignerWithTxSigning`
// type assertions.
type extReadSigner struct {
	*mockSigner
	allowance    *big.Int
	allowanceErr error
	noncesResult *big.Int
	noncesErr    error
	signTxResult []byte
	signTxErr    error
	feesPriority *big.Int
	feesMax      *big.Int
	feesErr      error
	txCount      uint64
	txCountErr   error
}

// ReadContract dispatches based on the function name so we can stub both the
// allowance lookup (for short-circuit checks) and the EIP-2612 nonces() call
// from the same fake signer.
func (r *extReadSigner) ReadContract(_ context.Context, _ string, _ []byte, function string, _ ...interface{}) (interface{}, error) {
	switch function {
	case "allowance":
		if r.allowanceErr != nil {
			return nil, r.allowanceErr
		}
		return r.allowance, nil
	case "nonces":
		if r.noncesErr != nil {
			return nil, r.noncesErr
		}
		return r.noncesResult, nil
	}
	return nil, nil
}

// SignTransaction satisfies ClientEvmSignerWithSignTransaction. The exact
// content doesn't matter — we only assert that the extension info ends up
// attached to the payload, not the binary correctness of the signed tx.
func (r *extReadSigner) SignTransaction(_ context.Context, _ interface{}) ([]byte, error) {
	if r.signTxErr != nil {
		return nil, r.signTxErr
	}
	return r.signTxResult, nil
}

func (r *extReadSigner) GetTransactionCount(_ context.Context, _ string) (uint64, error) {
	return r.txCount, r.txCountErr
}

func (r *extReadSigner) EstimateFeesPerGas(_ context.Context) (*big.Int, *big.Int, error) {
	if r.feesErr != nil {
		return nil, nil, r.feesErr
	}
	return r.feesMax, r.feesPriority, nil
}

func batchedExtSchemeWith(signer evm.ClientEvmSigner) *BatchSettlementEvmScheme {
	return NewBatchSettlementEvmScheme(signer, &BatchSettlementEvmSchemeOptions{
		Storage: NewInMemoryClientChannelStorage(),
	})
}

func extRequirementsPermit2() types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:  "batch-settlement",
		Network: extTestNetwork,
		Asset:   extTestAsset,
		Amount:  "100",
		PayTo:   extTestPayTo,
		Extra: map[string]interface{}{
			"name":                "USDC",
			"version":             "2",
			"assetTransferMethod": "permit2",
			"receiverAuthorizer":  "0x4444444444444444444444444444444444444444",
		},
		MaxTimeoutSeconds: 600,
	}
}

func eip2612OnlyDeclared() map[string]interface{} {
	return map[string]interface{}{
		eip2612gassponsor.EIP2612GasSponsoring.Key(): map[string]interface{}{},
	}
}

func bothExtensionsDeclared() map[string]interface{} {
	return map[string]interface{}{
		eip2612gassponsor.EIP2612GasSponsoring.Key():             map[string]interface{}{},
		erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): map[string]interface{}{},
	}
}

// TestCreatePaymentPayloadWithExtensions_NoExtensionsDeclared confirms that
// when the server's 402 has no extensions, the path is identical to plain
// CreatePaymentPayload — no enrichment, no extra RPC.
func TestCreatePaymentPayloadWithExtensions_NoExtensionsDeclared(t *testing.T) {
	signer := &extReadSigner{
		mockSigner: &mockSigner{address: extTestSigner, sig: []byte{0xab}},
		allowance:  big.NewInt(0),
	}
	scheme := batchedExtSchemeWith(signer)

	out, err := scheme.CreatePaymentPayloadWithExtensions(
		context.Background(),
		extRequirementsPermit2(),
		nil,
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out.Extensions != nil {
		t.Fatalf("expected no extensions when none advertised, got %+v", out.Extensions)
	}
}

// TestCreatePaymentPayloadWithExtensions_AllowanceShortCircuit confirms the
// EIP-2612 path is skipped when the user has already approved Permit2 for at
// least the deposit amount.
func TestCreatePaymentPayloadWithExtensions_AllowanceShortCircuit(t *testing.T) {
	// Deposit defaults to amount * DefaultDepositMultiplier (5) = 500.
	// Allowance of 1e18 is way more than enough → no permit signed.
	signer := &extReadSigner{
		mockSigner:   &mockSigner{address: extTestSigner, sig: []byte{0xab}},
		allowance:    new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil),
		noncesResult: big.NewInt(0),
	}
	scheme := batchedExtSchemeWith(signer)

	out, err := scheme.CreatePaymentPayloadWithExtensions(
		context.Background(),
		extRequirementsPermit2(),
		eip2612OnlyDeclared(),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out.Extensions != nil {
		t.Fatalf("expected allowance short-circuit (no extensions), got %+v", out.Extensions)
	}
}

// TestCreatePaymentPayloadWithExtensions_Eip2612SignedWhenAllowanceZero
// exercises the happy path: server advertises EIP-2612, user has zero
// allowance, signer can sign typed data → extension is attached with the
// expected DEPOSIT amount (not the per-request requirements.Amount).
func TestCreatePaymentPayloadWithExtensions_Eip2612SignedWhenAllowanceZero(t *testing.T) {
	signer := &extReadSigner{
		mockSigner:   &mockSigner{address: extTestSigner, sig: make([]byte, 65)},
		allowance:    big.NewInt(0),
		noncesResult: big.NewInt(0),
	}
	scheme := batchedExtSchemeWith(signer)

	out, err := scheme.CreatePaymentPayloadWithExtensions(
		context.Background(),
		extRequirementsPermit2(),
		eip2612OnlyDeclared(),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out.Extensions == nil {
		t.Fatal("expected extensions to be attached")
	}
	raw, ok := out.Extensions[eip2612gassponsor.EIP2612GasSponsoring.Key()]
	if !ok {
		t.Fatalf("eip2612GasSponsoring missing from extensions: %+v", out.Extensions)
	}
	wrapper, ok := raw.(map[string]interface{})
	if !ok {
		t.Fatalf("extension wrapper has wrong shape: %T", raw)
	}
	info, ok := wrapper["info"].(*eip2612gassponsor.Info)
	if !ok {
		t.Fatalf("info has wrong type: %T", wrapper["info"])
	}
	// The CRITICAL invariant: amount must equal the DEPOSIT amount, not
	// requirements.Amount. The Go facilitator's `validateBatchEip2612Permit`
	// rejects mismatches with invalid_batch_settlement_evm_eip2612_amount_mismatch.
	wantDeposit := "500" // 100 * DefaultDepositMultiplier (5)
	if info.Amount != wantDeposit {
		t.Fatalf("info.Amount = %q, want %q (deposit amount, not request amount)", info.Amount, wantDeposit)
	}
}

// TestCreatePaymentPayloadWithExtensions_Eip2612TakesPriorityOverErc20 pins
// priority: when both extensions are advertised, EIP-2612 is tried first; if it
// succeeds, the ERC-20 approval branch is NOT exercised.
func TestCreatePaymentPayloadWithExtensions_Eip2612TakesPriorityOverErc20(t *testing.T) {
	signer := &extReadSigner{
		mockSigner:   &mockSigner{address: extTestSigner, sig: make([]byte, 65)},
		allowance:    big.NewInt(0),
		noncesResult: big.NewInt(0),
	}
	scheme := batchedExtSchemeWith(signer)

	out, err := scheme.CreatePaymentPayloadWithExtensions(
		context.Background(),
		extRequirementsPermit2(),
		bothExtensionsDeclared(),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if _, has := out.Extensions[eip2612gassponsor.EIP2612GasSponsoring.Key()]; !has {
		t.Fatal("eip2612GasSponsoring should be attached (priority winner)")
	}
	if _, has := out.Extensions[erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key()]; has {
		t.Fatal("erc20ApprovalGasSponsoring should NOT be attached when EIP-2612 succeeded")
	}
}

// TestCreatePaymentPayloadWithExtensions_Eip2612SkippedWithoutNameVersion
// confirms that without name/version on requirements.Extra, the token's EIP-712
// domain is unknown and the client silently skips signing instead of erroring.
// The downstream request will then 402 with permit2_allowance_required (the
// standard Permit2 path's diagnosis).
func TestCreatePaymentPayloadWithExtensions_Eip2612SkippedWithoutNameVersion(t *testing.T) {
	signer := &extReadSigner{
		mockSigner: &mockSigner{address: extTestSigner, sig: []byte{0xab}},
		allowance:  big.NewInt(0),
	}
	scheme := batchedExtSchemeWith(signer)

	reqs := extRequirementsPermit2()
	delete(reqs.Extra, "name")
	delete(reqs.Extra, "version")

	out, err := scheme.CreatePaymentPayloadWithExtensions(
		context.Background(),
		reqs,
		eip2612OnlyDeclared(),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out.Extensions != nil {
		t.Fatalf("expected no extensions without name/version, got %+v", out.Extensions)
	}
}

// TestCreatePaymentPayloadWithExtensions_Eip2612DeadlineFromPermit2
// verifies the EIP-2612 deadline is taken from the just-signed Permit2
// authorization (not the fallback `now + maxTimeoutSeconds`). This keeps
// both signatures on the same expiry window. The mockSigner records the
// signed message, so we read the deadline from there.
func TestCreatePaymentPayloadWithExtensions_Eip2612DeadlineFromPermit2(t *testing.T) {
	signer := &extReadSigner{
		mockSigner:   &mockSigner{address: extTestSigner, sig: make([]byte, 65)},
		allowance:    big.NewInt(0),
		noncesResult: big.NewInt(0),
	}
	scheme := batchedExtSchemeWith(signer)

	out, err := scheme.CreatePaymentPayloadWithExtensions(
		context.Background(),
		extRequirementsPermit2(),
		eip2612OnlyDeclared(),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	wrapper := out.Extensions[eip2612gassponsor.EIP2612GasSponsoring.Key()].(map[string]interface{})
	info := wrapper["info"].(*eip2612gassponsor.Info)
	// Read the deadline straight off the deposit payload — the alignment
	// invariant being tested is that whatever value lands in the Permit2
	// authorization (`payload.deposit.authorization.permit2Authorization.deadline`)
	// is reused for the EIP-2612 permit. Inlined here because the helper
	// was removed (single-call site) and the path is short.
	dep, _ := out.Payload["deposit"].(map[string]interface{})
	auth, _ := dep["authorization"].(map[string]interface{})
	permit2, _ := auth["permit2Authorization"].(map[string]interface{})
	depDeadline, _ := permit2["deadline"].(string)
	if depDeadline == "" {
		t.Fatal("permit2 deadline missing from deposit payload")
	}
	if info.Deadline != depDeadline {
		t.Fatalf("eip2612 deadline = %q, permit2 deadline = %q — must match", info.Deadline, depDeadline)
	}
}
