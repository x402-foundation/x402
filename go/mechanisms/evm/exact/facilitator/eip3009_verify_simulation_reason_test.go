package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// contractPayerMockSigner models a deployed ERC-1271 payer whose off-chain signature check
// succeeds, so verify reaches the transfer simulation. simulateErr is what the simulated
// transferWithAuthorization returns: either an on-chain revert (terminal) or a transport
// failure (retryable). diagnosticCalls counts the diagnostic probe's multicall.
type contractPayerMockSigner struct {
	simulateErr     error
	diagnosticCalls int
}

func (m *contractPayerMockSigner) GetAddresses() []string { return []string{"0xFac11"} }

func (m *contractPayerMockSigner) ReadContract(ctx context.Context, address string, abi []byte, functionName string, args ...interface{}) (interface{}, error) {
	switch functionName {
	case "isValidSignature":
		// The payer's own validator accepts the signature: this is a valid ERC-1271 payer.
		return [4]byte{0x16, 0x26, 0xba, 0x7e}, nil
	case evm.FunctionTransferWithAuthorization:
		return nil, m.simulateErr
	case evm.FunctionTryAggregate:
		m.diagnosticCalls++
		return nil, m.simulateErr
	}
	return nil, nil
}

func (m *contractPayerMockSigner) VerifyTypedData(ctx context.Context, address string, domain evm.TypedDataDomain, types map[string][]evm.TypedDataField, primaryType string, message map[string]interface{}, signature []byte) (bool, error) {
	return false, nil
}

func (m *contractPayerMockSigner) WriteContract(ctx context.Context, address string, abi []byte, functionName string, dataSuffix []byte, args ...interface{}) (string, error) {
	return "0x" + strings.Repeat("ab", 32), nil
}

func (m *contractPayerMockSigner) SendTransaction(ctx context.Context, to string, data []byte) (string, error) {
	return "0x" + strings.Repeat("cd", 32), nil
}

func (m *contractPayerMockSigner) WaitForTransactionReceipt(ctx context.Context, txHash string) (*evm.TransactionReceipt, error) {
	return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
}

func (m *contractPayerMockSigner) GetBalance(ctx context.Context, address string, tokenAddress string) (*big.Int, error) {
	return big.NewInt(1_000_000_000), nil
}

func (m *contractPayerMockSigner) GetChainID(ctx context.Context) (*big.Int, error) {
	return big.NewInt(84532), nil
}

func (m *contractPayerMockSigner) GetCode(ctx context.Context, address string) ([]byte, error) {
	// Both the payer and the asset are deployed contracts.
	return []byte{0x60, 0x60}, nil
}

// contractPayerPayload builds a payment from a deployed smart-account payer. The signature is
// deliberately not 65 bytes so it is classified as a smart-wallet signature and verified via
// ERC-1271 rather than ecrecover.
func contractPayerPayload(t *testing.T) (types.PaymentPayload, types.PaymentRequirements) {
	t.Helper()
	const (
		payer = "0x4906Ae16bBCb3b366F82F7E4a612bd764B4B315D"
		payTo = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0"
		token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
	)
	p := &evm.ExactEIP3009Payload{
		Signature: "0x" + strings.Repeat("77", 96),
		Authorization: evm.ExactEIP3009Authorization{
			From:        payer,
			To:          payTo,
			Value:       "1000000",
			ValidAfter:  "0",
			ValidBefore: fmt.Sprintf("%d", time.Now().Unix()+3600),
			Nonce:       "0x" + strings.Repeat("22", 32),
		},
	}
	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:84532",
		Amount:  "1000000",
		Asset:   token,
		PayTo:   payTo,
		Extra:   map[string]interface{}{"name": "USDC", "version": "2"},
	}
	return types.PaymentPayload{X402Version: 2, Payload: p.ToMap(), Accepted: requirements}, requirements
}

// verifyReasonFor runs verify with the given simulation error and returns the reported reason
// along with the signer, so callers can assert on whether the diagnostic probe ran.
func verifyReasonFor(t *testing.T, simulateErr error) (string, *contractPayerMockSigner) {
	t.Helper()
	payload, requirements := contractPayerPayload(t)
	signer := &contractPayerMockSigner{simulateErr: simulateErr}
	scheme := NewExactEvmScheme(signer, &ExactEvmSchemeConfig{})

	_, err := scheme.Verify(context.Background(), payload, requirements, nil)
	if err == nil {
		t.Fatalf("expected verify to fail, got success")
	}
	ve := &x402.VerifyError{}
	if !errors.As(err, &ve) {
		t.Fatalf("expected *x402.VerifyError, got %T: %v", err, err)
	}
	return ve.InvalidReason, signer
}

// A token whose transferWithAuthorization verifies with ecrecover only rejects every contract
// payer: no retry, no funding and no configuration change makes this payment succeed. The
// on-chain revert reason says so, and settle already maps that reason to ErrInvalidSignature
// through parseEIP3009TransferError. Verify must report the same terminal reason.
func TestVerifyEIP3009_RevertedSimulationReportsTheRevertsOwnReason(t *testing.T) {
	reason, _ := verifyReasonFor(t, errors.New("execution reverted: EIP3009: invalid signature"))

	if reason == ErrEip3009SimulationFailed {
		t.Fatalf("terminal on-chain rejection reported as %q, the code #2062 introduced for "+
			"payloads that are valid but whose simulation could not run; callers cannot tell it "+
			"apart from a transport failure and will retry a payment that can never succeed",
			reason)
	}
	if reason != ErrInvalidSignature {
		t.Fatalf("expected %q, got %q", ErrInvalidSignature, reason)
	}
}

// A transport failure says nothing about the payload, so the retryable code stays correct — and
// the diagnostic probe must not run, since it would send four more reads down the same dead path.
func TestVerifyEIP3009_TransportFailureKeepsRetryableReasonWithoutProbing(t *testing.T) {
	reason, signer := verifyReasonFor(t, errors.New("dial tcp 10.0.0.1:8545: connect: connection refused"))

	if reason != ErrEip3009SimulationFailed {
		t.Fatalf("expected %q for a transport failure, got %q", ErrEip3009SimulationFailed, reason)
	}
	if signer.diagnosticCalls != 0 {
		t.Fatalf("diagnostic probe ran %d time(s) after a transport failure; the node is "+
			"already unreachable, so the probe cannot answer either", signer.diagnosticCalls)
	}
}

// A revert whose reason no parser recognises still deserves the probe: the node answered, so the
// diagnostic reads can run and may identify a used nonce or an insufficient balance.
func TestVerifyEIP3009_UnrecognisedRevertStillProbes(t *testing.T) {
	reason, signer := verifyReasonFor(t, errors.New("execution reverted: Pausable: paused"))

	if signer.diagnosticCalls == 0 {
		t.Fatalf("diagnostic probe did not run for a revert the parser could not classify")
	}
	if reason != ErrEip3009SimulationFailed {
		t.Fatalf("expected the probe to fall through to %q, got %q", ErrEip3009SimulationFailed, reason)
	}
}
