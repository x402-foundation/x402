package facilitator

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	testPayer = "0x1234567890123456789012345678901234567890"
	testPayTo = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0"
	testToken = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
)

// plainEIP3009Payload builds a payment payload + requirements signed by a deployed smart
// wallet whose signature the mock signer cannot directly verify (EIP-1271 always reports
// invalid), so classification falls through to the "smart wallet, verified via simulation"
// path used by real ERC-1271 wallets. Simulation stays disabled (SimulateInSettle: false),
// so settle proceeds straight to broadcast — no ERC-6492 deployment step involved.
func plainEIP3009Payload(t *testing.T) (types.PaymentPayload, types.PaymentRequirements) {
	t.Helper()
	p := &evm.ExactEIP3009Payload{
		Signature: "0x" + strings.Repeat("11", 65),
		Authorization: evm.ExactEIP3009Authorization{
			From:        testPayer,
			To:          testPayTo,
			Value:       "1000000",
			ValidAfter:  "0",
			ValidBefore: "99999999999",
			Nonce:       "0x" + strings.Repeat("00", 32),
		},
	}
	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:84532",
		Amount:  "1000000",
		Asset:   testToken,
		PayTo:   testPayTo,
		Extra:   map[string]interface{}{"name": "USDC", "version": "2"},
	}
	return types.PaymentPayload{X402Version: 2, Payload: p.ToMap(), Accepted: requirements}, requirements
}

func deployedCodeSigner(receiptErr error) *settleMockSigner {
	return &settleMockSigner{
		codeByAddress: map[string][]byte{
			strings.ToLower(testToken): {0x60, 0x60},
			strings.ToLower(testPayer): {0x60, 0x60},
		},
		receiptErr: receiptErr,
	}
}

func assertSettlementPending(t *testing.T, err error, wantTxHash string) {
	t.Helper()
	assertSettleErr(t, err, ErrSettlementPending, wantTxHash)
}

func assertSettleErr(t *testing.T, err error, wantReason string, wantTxHash string) {
	t.Helper()
	se := &x402.SettleError{}
	if !errors.As(err, &se) {
		t.Fatalf("expected *x402.SettleError, got %T: %v", err, err)
	}
	if se.ErrorReason != wantReason {
		t.Fatalf("expected reason %q, got %q", wantReason, se.ErrorReason)
	}
	if se.Transaction != wantTxHash {
		t.Fatalf("expected transaction %q, got %q", wantTxHash, se.Transaction)
	}
}

func TestSettleEIP3009_ReceiptWaitFailureReturnsSettlementPending(t *testing.T) {
	payload, requirements := plainEIP3009Payload(t)
	scheme := NewExactEvmScheme(
		deployedCodeSigner(fmt.Errorf("rpc: timeout waiting for receipt")),
		&ExactEvmSchemeConfig{},
	)

	resp, err := scheme.Settle(context.Background(), payload, requirements, nil)
	if err == nil {
		t.Fatalf("expected settlement_pending error, got success: %+v", resp)
	}
	assertSettlementPending(t, err, "0x"+strings.Repeat("ab", 32))
}

type receiptWaitProgrammerError struct{}

func (receiptWaitProgrammerError) Error() string { return "programmer error" }

func (receiptWaitProgrammerError) RuntimeError() {}

func TestSettleEIP3009_ProgrammerReceiptWaitFailureReturnsSettlementPending(t *testing.T) {
	payload, requirements := plainEIP3009Payload(t)
	scheme := NewExactEvmScheme(
		deployedCodeSigner(receiptWaitProgrammerError{}),
		&ExactEvmSchemeConfig{},
	)

	_, err := scheme.Settle(context.Background(), payload, requirements, nil)
	assertSettlementPending(t, err, "0x"+strings.Repeat("ab", 32))
}

// mockErc20ApprovalSigner wraps settleMockSigner with SendTransactions to satisfy
// erc20approvalgassponsor.Erc20ApprovalGasSponsoringSigner for the ERC-20 approval branch.
type mockErc20ApprovalSigner struct {
	*settleMockSigner
	sendTxHashes []string
	sendTxErr    error
}

func (m *mockErc20ApprovalSigner) SendTransactions(ctx context.Context, transactions []erc20approvalgassponsor.TransactionRequest) ([]string, error) {
	return m.sendTxHashes, m.sendTxErr
}

type permit2ERC20Fixture struct {
	payload        types.PaymentPayload
	requirements   types.PaymentRequirements
	permit2Payload *evm.ExactPermit2Payload
	signer         *settleMockSigner
	facilCtx       *x402.FacilitatorContext
}

func newPermit2ERC20Fixture(sendTxHashes []string, receiptErr error) permit2ERC20Fixture {
	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:84532",
		Amount:  "1000000",
		Asset:   testToken,
		PayTo:   testPayTo,
	}
	permit2Payload := &evm.ExactPermit2Payload{
		Signature: "0x" + strings.Repeat("11", 65),
		Permit2Authorization: evm.Permit2Authorization{
			From: testPayer,
			Permitted: evm.Permit2TokenPermissions{
				Token:  testToken,
				Amount: "1000000",
			},
			Spender:  evm.X402ExactPermit2ProxyAddress,
			Nonce:    "1",
			Deadline: fmt.Sprintf("%d", time.Now().Unix()+10000),
			Witness: evm.Permit2Witness{
				To:         testPayTo,
				ValidAfter: "0",
			},
		},
	}
	payload := types.PaymentPayload{
		X402Version: 2,
		Payload:     permit2Payload.ToMap(),
		Accepted:    requirements,
		Extensions: map[string]interface{}{
			erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): map[string]interface{}{
				"info": &erc20approvalgassponsor.Info{
					From:              testPayer,
					Asset:             testToken,
					Spender:           evm.PERMIT2Address,
					Amount:            "1000000",
					SignedTransaction: "0x02",
					Version:           erc20approvalgassponsor.ERC20ApprovalGasSponsoringVersion,
				},
			},
		},
	}
	extSigner := &mockErc20ApprovalSigner{
		settleMockSigner: &settleMockSigner{receiptErr: receiptErr},
		sendTxHashes:     sendTxHashes,
	}
	ext := &erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension{Signer: extSigner}
	return permit2ERC20Fixture{
		payload:        payload,
		requirements:   requirements,
		permit2Payload: permit2Payload,
		signer:         deployedCodeSigner(nil),
		facilCtx: x402.NewFacilitatorContext(map[string]x402.FacilitatorExtension{
			erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): ext,
		}),
	}
}

func TestSettlePermit2_ERC20ApprovalIncompleteHashesFailTerminally(t *testing.T) {
	f := newPermit2ERC20Fixture([]string{"0xapproval"}, nil)

	_, err := SettlePermit2(context.Background(), f.signer, f.payload, f.requirements, f.permit2Payload, f.facilCtx, nil)
	if err == nil {
		t.Fatal("expected error when extension signer returns incomplete transaction hashes")
	}
	assertSettleErr(t, err, ErrErc20ApprovalBroadcastFailed, "")
}

// A signer that reports success without a usable hash must be terminal: settlement_pending is
// only meaningful when the caller receives the broadcast hash to reconcile with.
func TestSettlePermit2_InvalidBroadcastHashIsTerminal(t *testing.T) {
	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:84532",
		Amount:  "1000000",
		Asset:   testToken,
		PayTo:   testPayTo,
	}
	permit2Payload := &evm.ExactPermit2Payload{
		Signature: "0x" + strings.Repeat("11", 65),
		Permit2Authorization: evm.Permit2Authorization{
			From: testPayer,
			Permitted: evm.Permit2TokenPermissions{
				Token:  testToken,
				Amount: "1000000",
			},
			Spender:  evm.X402ExactPermit2ProxyAddress,
			Nonce:    "1",
			Deadline: fmt.Sprintf("%d", time.Now().Unix()+10000),
			Witness: evm.Permit2Witness{
				To:         testPayTo,
				ValidAfter: "0",
			},
		},
	}
	payload := types.PaymentPayload{X402Version: 2, Payload: permit2Payload.ToMap(), Accepted: requirements}
	signer := deployedCodeSigner(fmt.Errorf("rpc: timeout waiting for receipt"))
	signer.writeTxHash = "0xnothash"

	_, err := SettlePermit2(context.Background(), signer, payload, requirements, permit2Payload, nil, nil)
	if err == nil {
		t.Fatal("expected error when the signer returns an invalid transaction hash")
	}
	assertSettleErr(t, err, ErrTransactionFailed, "")
}

func TestSettleEIP3009_InvalidBroadcastHashIsTerminal(t *testing.T) {
	payload, requirements := plainEIP3009Payload(t)
	signer := deployedCodeSigner(fmt.Errorf("rpc: timeout waiting for receipt"))
	signer.writeTxHash = "0xnothash"
	scheme := NewExactEvmScheme(signer, &ExactEvmSchemeConfig{})

	_, err := scheme.Settle(context.Background(), payload, requirements, nil)
	if err == nil {
		t.Fatal("expected error when the signer returns an invalid transaction hash")
	}
	assertSettleErr(t, err, ErrTransactionFailed, "")
}

func TestSettlePermit2_ERC20ApprovalAtomicBundleSingleHashSucceeds(t *testing.T) {
	bundleHash := "0x" + strings.Repeat("ef", 32)
	f := newPermit2ERC20Fixture([]string{bundleHash}, nil)

	resp, err := SettlePermit2(context.Background(), f.signer, f.payload, f.requirements, f.permit2Payload, f.facilCtx, nil)
	if err != nil {
		t.Fatalf("expected success with a single bundled hash, got error: %v", err)
	}
	if resp.Transaction != bundleHash {
		t.Fatalf("expected transaction %q, got %q", bundleHash, resp.Transaction)
	}
}

func TestSettlePermit2_ERC20ApprovalExtensionReceiptWaitFailureReturnsSettlementPending(t *testing.T) {
	settleHash := "0x" + strings.Repeat("ef", 32)
	f := newPermit2ERC20Fixture(
		[]string{"0x" + strings.Repeat("11", 32), settleHash},
		fmt.Errorf("rpc: timeout waiting for receipt"),
	)

	resp, err := SettlePermit2(context.Background(), f.signer, f.payload, f.requirements, f.permit2Payload, f.facilCtx, nil)
	if err == nil {
		t.Fatalf("expected settlement_pending error, got success: %+v", resp)
	}
	assertSettlementPending(t, err, settleHash)
}

func TestSettlePermit2_ReceiptWaitFailureReturnsSettlementPending(t *testing.T) {
	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:84532",
		Amount:  "1000000",
		Asset:   testToken,
		PayTo:   testPayTo,
	}
	permit2Payload := &evm.ExactPermit2Payload{
		Signature: "0x" + strings.Repeat("11", 65),
		Permit2Authorization: evm.Permit2Authorization{
			From: testPayer,
			Permitted: evm.Permit2TokenPermissions{
				Token:  testToken,
				Amount: "1000000",
			},
			Spender:  evm.X402ExactPermit2ProxyAddress,
			Nonce:    "1",
			Deadline: fmt.Sprintf("%d", time.Now().Unix()+10000),
			Witness: evm.Permit2Witness{
				To:         testPayTo,
				ValidAfter: "0",
			},
		},
	}
	payload := types.PaymentPayload{X402Version: 2, Payload: permit2Payload.ToMap(), Accepted: requirements}
	signer := deployedCodeSigner(fmt.Errorf("rpc: timeout waiting for receipt"))

	resp, err := SettlePermit2(context.Background(), signer, payload, requirements, permit2Payload, nil, nil)
	if err == nil {
		t.Fatalf("expected settlement_pending error, got success: %+v", resp)
	}
	assertSettlementPending(t, err, "0x"+strings.Repeat("ab", 32))
}
