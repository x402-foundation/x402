package facilitator

import (
	"context"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	goethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

var uptoTransferEventTopic = crypto.Keccak256Hash([]byte("Transfer(address,address,uint256)"))

func makeUptoTransferLog(token common.Address, from common.Address, to common.Address, value *big.Int) *goethtypes.Log {
	return &goethtypes.Log{
		Address: token,
		Topics: []common.Hash{
			uptoTransferEventTopic,
			common.BytesToHash(common.LeftPadBytes(from.Bytes(), 32)),
			common.BytesToHash(common.LeftPadBytes(to.Bytes(), 32)),
		},
		Data: common.LeftPadBytes(value.Bytes(), 32),
	}
}

func TestSettleUptoPermit2_RejectsUnderpayingTransferEvent(t *testing.T) {
	txHash := "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	token := common.HexToAddress(testTokenAddr)
	payer := common.HexToAddress(testPayerAddr)
	payTo := common.HexToAddress(testPayToAddr)

	signer := newMockSigner()
	signer.writeContractTx = txHash
	signer.receiptResult = &evm.TransactionReceipt{
		Status: evm.TxStatusSuccess,
		TxHash: txHash,
		Logs: []*goethtypes.Log{
			makeUptoTransferLog(token, payer, payTo, big.NewInt(900)),
		},
	}

	_, err := SettleUptoPermit2(
		context.Background(),
		signer,
		buildValidPayload(testFacilitatorAddr),
		buildValidRequirements(),
		buildValidUptoPayload(testFacilitatorAddr),
		nil,
		false,
	)
	assertSettleError(t, err, ErrTransferEventMismatch)
}

func TestSettleUptoPermit2_RejectsEmptyLogs(t *testing.T) {
	txHash := "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	signer := newMockSigner()
	signer.writeContractTx = txHash
	signer.receiptResult = &evm.TransactionReceipt{
		Status: evm.TxStatusSuccess,
		TxHash: txHash,
		Logs:   []*goethtypes.Log{},
	}

	_, err := SettleUptoPermit2(
		context.Background(),
		signer,
		buildValidPayload(testFacilitatorAddr),
		buildValidRequirements(),
		buildValidUptoPayload(testFacilitatorAddr),
		nil,
		false,
	)
	assertSettleError(t, err, ErrTransferEventMismatch)
}

func TestSettleUptoPermit2_AcceptsMatchingTransferEvent(t *testing.T) {
	txHash := "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	token := common.HexToAddress(testTokenAddr)
	payer := common.HexToAddress(testPayerAddr)
	payTo := common.HexToAddress(testPayToAddr)

	signer := newMockSigner()
	signer.writeContractTx = txHash
	signer.receiptResult = &evm.TransactionReceipt{
		Status: evm.TxStatusSuccess,
		TxHash: txHash,
		Logs: []*goethtypes.Log{
			makeUptoTransferLog(token, payer, payTo, big.NewInt(1000)),
		},
	}

	resp, err := SettleUptoPermit2(
		context.Background(),
		signer,
		buildValidPayload(testFacilitatorAddr),
		buildValidRequirements(),
		buildValidUptoPayload(testFacilitatorAddr),
		nil,
		false,
	)
	if err != nil {
		t.Fatalf("expected settle success, got error: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got %+v", resp)
	}
	if resp.Transaction != txHash {
		t.Fatalf("expected transaction %q, got %q", txHash, resp.Transaction)
	}
	if resp.Amount != testAmount {
		t.Fatalf("expected Amount=%q, got %q", testAmount, resp.Amount)
	}
}

func TestSettleUptoPermit2_PartialAmount_RequiresSettlementTransfer(t *testing.T) {
	txHash := "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	token := common.HexToAddress(testTokenAddr)
	payer := common.HexToAddress(testPayerAddr)
	payTo := common.HexToAddress(testPayToAddr)

	req := buildValidRequirements()
	req.Amount = "500"

	signer := newMockSigner()
	signer.writeContractTx = txHash
	// Full permitted amount in the log must not satisfy a partial settlement.
	signer.receiptResult = &evm.TransactionReceipt{
		Status: evm.TxStatusSuccess,
		TxHash: txHash,
		Logs: []*goethtypes.Log{
			makeUptoTransferLog(token, payer, payTo, big.NewInt(1000)),
		},
	}

	_, err := SettleUptoPermit2(
		context.Background(),
		signer,
		buildValidPayload(testFacilitatorAddr),
		req,
		buildValidUptoPayload(testFacilitatorAddr),
		nil,
		false,
	)
	assertSettleError(t, err, ErrTransferEventMismatch)

	signer.receiptResult.Logs = []*goethtypes.Log{
		makeUptoTransferLog(token, payer, payTo, big.NewInt(500)),
	}
	resp, err := SettleUptoPermit2(
		context.Background(),
		signer,
		buildValidPayload(testFacilitatorAddr),
		req,
		buildValidUptoPayload(testFacilitatorAddr),
		nil,
		false,
	)
	if err != nil {
		t.Fatalf("expected settle success for matching partial transfer, got error: %v", err)
	}
	if resp.Amount != "500" {
		t.Fatalf("expected Amount='500', got %q", resp.Amount)
	}
}
