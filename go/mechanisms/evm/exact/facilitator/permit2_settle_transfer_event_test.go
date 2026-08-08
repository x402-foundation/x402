package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	goethtypes "github.com/ethereum/go-ethereum/core/types"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	permit2TestPayer   = "0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0"
	permit2TestPayTo   = "0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"
	permit2TestToken   = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
	permit2TestNetwork = "eip155:84532"
	permit2TestAmount  = "1000"
	permit2DummySig    = "0x" +
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" +
		"1b"
)

// permit2SettleMockSigner is a minimal FacilitatorEvmSigner for Permit2 settle transfer-event tests.
// The payer is treated as a deployed contract so a dummy signature falls through to settle when
// simulation is disabled (same pattern as the upto Permit2 settle suite).
type permit2SettleMockSigner struct {
	receipt *evm.TransactionReceipt
	txHash  string
}

func (m *permit2SettleMockSigner) GetAddresses() []string {
	return []string{"0xf1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1"}
}

func (m *permit2SettleMockSigner) ReadContract(ctx context.Context, address string, abi []byte, functionName string, args ...interface{}) (interface{}, error) {
	return nil, nil
}

func (m *permit2SettleMockSigner) VerifyTypedData(ctx context.Context, address string, domain evm.TypedDataDomain, types map[string][]evm.TypedDataField, primaryType string, message map[string]interface{}, signature []byte) (bool, error) {
	return false, nil
}

func (m *permit2SettleMockSigner) WriteContract(ctx context.Context, address string, abi []byte, functionName string, dataSuffix []byte, args ...interface{}) (string, error) {
	if m.txHash != "" {
		return m.txHash, nil
	}
	return "0x" + strings.Repeat("ab", 32), nil
}

func (m *permit2SettleMockSigner) SendTransaction(ctx context.Context, to string, data []byte) (string, error) {
	return m.WriteContract(ctx, to, nil, "", nil)
}

func (m *permit2SettleMockSigner) WaitForTransactionReceipt(ctx context.Context, txHash string) (*evm.TransactionReceipt, error) {
	if m.receipt != nil {
		return m.receipt, nil
	}
	return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
}

func (m *permit2SettleMockSigner) GetBalance(ctx context.Context, address string, tokenAddress string) (*big.Int, error) {
	return big.NewInt(999_000_000), nil
}

func (m *permit2SettleMockSigner) GetChainID(ctx context.Context) (*big.Int, error) {
	return big.NewInt(84532), nil
}

func (m *permit2SettleMockSigner) GetCode(ctx context.Context, address string) ([]byte, error) {
	normalized := strings.ToLower(address)
	if normalized == strings.ToLower(permit2TestToken) || normalized == strings.ToLower(permit2TestPayer) {
		return []byte{0x60, 0x60}, nil
	}
	return []byte{}, nil
}

func buildExactPermit2SettleFixture() (types.PaymentPayload, types.PaymentRequirements, *evm.ExactPermit2Payload) {
	now := time.Now().Unix()
	permit2Payload := &evm.ExactPermit2Payload{
		Signature: permit2DummySig,
		Permit2Authorization: evm.Permit2Authorization{
			From: permit2TestPayer,
			Permitted: evm.Permit2TokenPermissions{
				Token:  permit2TestToken,
				Amount: permit2TestAmount,
			},
			Spender:  evm.X402ExactPermit2ProxyAddress,
			Nonce:    "12345",
			Deadline: fmt.Sprintf("%d", now+300),
			Witness: evm.Permit2Witness{
				To:         permit2TestPayTo,
				ValidAfter: fmt.Sprintf("%d", now-600),
			},
		},
	}
	requirements := types.PaymentRequirements{
		Scheme:  evm.SchemeExact,
		Network: permit2TestNetwork,
		Asset:   permit2TestToken,
		Amount:  permit2TestAmount,
		PayTo:   permit2TestPayTo,
	}
	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     permit2Payload.ToMap(),
	}
	return payload, requirements, permit2Payload
}

func TestSettlePermit2_RejectsUnderpayingTransferEvent(t *testing.T) {
	payload, requirements, permit2Payload := buildExactPermit2SettleFixture()
	txHash := "0x" + strings.Repeat("ab", 32)
	token := common.HexToAddress(permit2TestToken)
	payer := common.HexToAddress(permit2TestPayer)
	payTo := common.HexToAddress(permit2TestPayTo)

	signer := &permit2SettleMockSigner{
		txHash: txHash,
		receipt: &evm.TransactionReceipt{
			Status: evm.TxStatusSuccess,
			TxHash: txHash,
			Logs: []*goethtypes.Log{
				makeTransferLog(token, payer, payTo, big.NewInt(900)),
			},
		},
	}

	_, err := SettlePermit2(context.Background(), signer, payload, requirements, permit2Payload, nil, &Permit2FacilitatorConfig{SimulateInSettle: false})
	assertPermit2SettleTransferMismatch(t, err, txHash)
}

func TestSettlePermit2_RejectsEmptyLogs(t *testing.T) {
	payload, requirements, permit2Payload := buildExactPermit2SettleFixture()
	txHash := "0x" + strings.Repeat("cd", 32)

	signer := &permit2SettleMockSigner{
		txHash: txHash,
		receipt: &evm.TransactionReceipt{
			Status: evm.TxStatusSuccess,
			TxHash: txHash,
			Logs:   []*goethtypes.Log{},
		},
	}

	_, err := SettlePermit2(context.Background(), signer, payload, requirements, permit2Payload, nil, &Permit2FacilitatorConfig{SimulateInSettle: false})
	assertPermit2SettleTransferMismatch(t, err, txHash)
}

func TestSettlePermit2_AcceptsMatchingTransferEvent(t *testing.T) {
	payload, requirements, permit2Payload := buildExactPermit2SettleFixture()
	txHash := "0x" + strings.Repeat("ef", 32)
	token := common.HexToAddress(permit2TestToken)
	payer := common.HexToAddress(permit2TestPayer)
	payTo := common.HexToAddress(permit2TestPayTo)

	signer := &permit2SettleMockSigner{
		txHash: txHash,
		receipt: &evm.TransactionReceipt{
			Status: evm.TxStatusSuccess,
			TxHash: txHash,
			Logs: []*goethtypes.Log{
				makeTransferLog(token, payer, payTo, big.NewInt(1000)),
			},
		},
	}

	resp, err := SettlePermit2(context.Background(), signer, payload, requirements, permit2Payload, nil, &Permit2FacilitatorConfig{SimulateInSettle: false})
	if err != nil {
		t.Fatalf("expected settle success, got error: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected resp.Success = true, got %+v", resp)
	}
	if resp.Transaction != txHash {
		t.Fatalf("expected transaction %q, got %q", txHash, resp.Transaction)
	}
}

func assertPermit2SettleTransferMismatch(t *testing.T, err error, txHash string) {
	t.Helper()
	if err == nil {
		t.Fatal("expected transfer event mismatch error, got nil")
	}
	se := &x402.SettleError{}
	if !errors.As(err, &se) {
		t.Fatalf("expected *x402.SettleError, got %T: %v", err, err)
	}
	if se.ErrorReason != ErrTransferEventMismatch {
		t.Fatalf("expected reason %q, got %q", ErrTransferEventMismatch, se.ErrorReason)
	}
	if se.Transaction != txHash {
		t.Fatalf("expected transaction %q, got %q", txHash, se.Transaction)
	}
}
