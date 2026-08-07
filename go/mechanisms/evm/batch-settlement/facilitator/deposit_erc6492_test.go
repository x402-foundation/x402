package facilitator

import (
	"context"
	"errors"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	testErc6492Factory = "0xca11bde05977b3631167028862be2a173976ca11"
)

// wrapErc6492Sig wraps innerSig in the ERC-6492 envelope with the given factory + calldata.
func wrapErc6492Sig(t *testing.T, factory common.Address, factoryCalldata, innerSig []byte) string {
	t.Helper()
	addressTy, err := abi.NewType("address", "", nil)
	if err != nil {
		t.Fatalf("abi address type: %v", err)
	}
	bytesTy, err := abi.NewType("bytes", "", nil)
	if err != nil {
		t.Fatalf("abi bytes type: %v", err)
	}
	args := abi.Arguments{{Type: addressTy}, {Type: bytesTy}, {Type: bytesTy}}
	packed, err := args.Pack(factory, factoryCalldata, innerSig)
	if err != nil {
		t.Fatalf("pack erc6492: %v", err)
	}
	magic := common.Hex2Bytes("6492649264926492649264926492649264926492649264926492649264926492")
	return "0x" + common.Bytes2Hex(append(packed, magic...))
}

func counterfactualAuth(t *testing.T, factory common.Address) *batchsettlement.BatchSettlementErc3009Authorization {
	t.Helper()
	auth := goodErc3009Auth()
	inner := common.FromHex("0x" + strings.Repeat("33", 65))
	auth.Signature = wrapErc6492Sig(t, factory, common.FromHex("0xdeadbeef"), inner)
	return auth
}

// TestVerifyErc3009_CounterfactualFactoryNotAllowed pins that an undeployed ERC-6492
// wallet whose factory is not allowlisted is rejected with ErrFactoryNotAllowed.
func TestVerifyErc3009_CounterfactualFactoryNotAllowed(t *testing.T) {
	signer := &fakeFacilitatorSigner{
		getCode: func(string) ([]byte, error) { return nil, nil }, // undeployed
	}
	sigData, reason, err := verifyErc3009DepositAuthorization(
		context.Background(), signer,
		goodErc3009Config(), testErc3009ChannelId,
		big.NewInt(1000), counterfactualAuth(t, common.HexToAddress(testErc6492Factory)),
		big.NewInt(8453), goodErc3009Extra(),
		nil, // empty allowlist
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrFactoryNotAllowed {
		t.Fatalf("reason = %q, want %q", reason, ErrFactoryNotAllowed)
	}
	if sigData != nil {
		t.Fatalf("expected nil sigData on rejection, got %+v", sigData)
	}
}

// TestVerifyErc3009_CounterfactualAllowedDefersToSimulation pins that an undeployed
// ERC-6492 wallet with an allowlisted factory returns a non-nil sigData (signalling the
// caller to validate via the deploy+deposit simulation) and no rejection reason.
func TestVerifyErc3009_CounterfactualAllowedDefersToSimulation(t *testing.T) {
	signer := &fakeFacilitatorSigner{
		getCode: func(string) ([]byte, error) { return nil, nil }, // undeployed
	}
	sigData, reason, err := verifyErc3009DepositAuthorization(
		context.Background(), signer,
		goodErc3009Config(), testErc3009ChannelId,
		big.NewInt(1000), counterfactualAuth(t, common.HexToAddress(testErc6492Factory)),
		big.NewInt(8453), goodErc3009Extra(),
		[]string{testErc6492Factory},
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != "" {
		t.Fatalf("reason = %q, want empty (deferred to simulation)", reason)
	}
	if sigData == nil || !evm.HasEIP6492Deployment(sigData) {
		t.Fatalf("expected non-nil sigData with deployment info, got %+v", sigData)
	}
}

// counterfactualDepositPayload builds a deposit payload from an undeployed ERC-6492 wallet.
func counterfactualDepositPayload(t *testing.T, factory common.Address) *batchsettlement.BatchSettlementDepositPayload {
	t.Helper()
	return &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: goodErc3009Config(),
		Voucher: batchsettlement.BatchSettlementVoucherFields{
			ChannelId:          testErc3009ChannelId,
			MaxClaimableAmount: "1000",
			Signature:          "0x" + strings.Repeat("22", 65),
		},
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: "1000",
			Authorization: batchsettlement.BatchSettlementDepositAuthorization{
				Erc3009Authorization: counterfactualAuth(t, factory),
			},
		},
	}
}

func reqsWithExtra() types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:  batchsettlement.SchemeBatched,
		Network: testNetwork,
		Asset:   testErc3009Token,
		Extra:   goodErc3009Extra(),
	}
}

// TestSettleDeposit_CounterfactualFactoryNotAllowed pins that settle rejects an undeployed
// ERC-6492 deposit whose factory is not in the allowlist — before sending any transaction.
func TestSettleDeposit_CounterfactualFactoryNotAllowed(t *testing.T) {
	signer := &fakeFacilitatorSigner{
		getCode: func(string) ([]byte, error) { return nil, nil }, // undeployed
	}
	payload := counterfactualDepositPayload(t, common.HexToAddress(testErc6492Factory))

	err := deployErc3009CounterfactualIfNeeded(
		context.Background(), signer, payload, reqsWithExtra(), nil, // empty allowlist
	)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrFactoryNotAllowed {
		t.Fatalf("got err = %v, want %s", err, ErrFactoryNotAllowed)
	}
	if signer.sendCalls != 0 {
		t.Fatalf("expected no deploy tx for disallowed factory, sendCalls=%d", signer.sendCalls)
	}
}

// TestSettleDeposit_CounterfactualDeployedProceedsWithoutResimulation pins the post-6492-deploy
// behavior: once the factory deploys the wallet, the helper proceeds to the real deposit and
// performs no post-deploy deposit() simulation. The inner signature is now validated by the
// verify-side deploy+deposit Multicall3 simulation and, definitively, by the on-chain
// deposit() — so a (RPC-racy) standalone eth_call must not run here and cannot block settle.
func TestSettleDeposit_CounterfactualDeployedProceedsWithoutResimulation(t *testing.T) {
	signer := &fakeFacilitatorSigner{
		getCode:         func(string) ([]byte, error) { return nil, nil }, // undeployed
		sendTransaction: func(string, []byte) (string, error) { return "0x" + strings.Repeat("ab", 32), nil },
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
		},
		// Guard: the helper must not run a post-deploy deposit() simulation.
		readContract: func(fn string, _ ...interface{}) (interface{}, error) {
			if fn == "deposit" {
				t.Fatalf("helper must not run a post-deploy deposit() simulation")
			}
			return nil, nil
		},
	}
	payload := counterfactualDepositPayload(t, common.HexToAddress(testErc6492Factory))

	err := deployErc3009CounterfactualIfNeeded(
		context.Background(), signer, payload, reqsWithExtra(), []string{testErc6492Factory},
	)
	if err != nil {
		t.Fatalf("expected nil (deploy then proceed to deposit), got err=%v", err)
	}
	if signer.sendCalls != 1 {
		t.Fatalf("expected exactly one deploy tx, sendCalls=%d", signer.sendCalls)
	}
}

// TestSettleDeposit_CounterfactualHappyPath pins that an allowlisted, deployable wallet is
// deployed (one deploy tx) and the helper returns nil so settle proceeds to the deposit.
func TestSettleDeposit_CounterfactualHappyPath(t *testing.T) {
	signer := &fakeFacilitatorSigner{
		getCode:         func(string) ([]byte, error) { return nil, nil }, // undeployed
		sendTransaction: func(string, []byte) (string, error) { return "0x" + strings.Repeat("ab", 32), nil },
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
		},
	}
	payload := counterfactualDepositPayload(t, common.HexToAddress(testErc6492Factory))

	err := deployErc3009CounterfactualIfNeeded(
		context.Background(), signer, payload, reqsWithExtra(), []string{testErc6492Factory},
	)
	if err != nil {
		t.Fatalf("expected nil to proceed to deposit, got err=%v", err)
	}
	if signer.sendCalls != 1 {
		t.Fatalf("expected one deploy tx, sendCalls=%d", signer.sendCalls)
	}
}

// TestSettleDeposit_PlainSigNoDeploy pins that a non-wrapped (plain EOA) signature triggers
// no deployment path: deployErc3009CounterfactualIfNeeded is a no-op.
func TestSettleDeposit_PlainSigNoDeploy(t *testing.T) {
	signer := &fakeFacilitatorSigner{}
	payload := counterfactualDepositPayload(t, common.HexToAddress(testErc6492Factory))
	// Replace the wrapped signature with a plain 65-byte signature.
	payload.Deposit.Authorization.Erc3009Authorization.Signature = "0x" + strings.Repeat("11", 65)

	err := deployErc3009CounterfactualIfNeeded(
		context.Background(), signer, payload, reqsWithExtra(), []string{testErc6492Factory},
	)
	if err != nil {
		t.Fatalf("expected no-op (nil) for plain sig, got err=%v", err)
	}
	if signer.sendCalls != 0 {
		t.Fatalf("expected no deploy tx for plain sig, sendCalls=%d", signer.sendCalls)
	}
}
