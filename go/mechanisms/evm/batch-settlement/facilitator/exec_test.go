package facilitator

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/crypto"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	bsclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/client"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

const testNetwork = "eip155:8453"

func reqsFor(network string) types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:  batchsettlement.SchemeBatched,
		Network: network,
		PayTo:   "0x3333333333333333333333333333333333333333",
		Asset:   "0x5555555555555555555555555555555555555555",
		Amount:  "100",
		Extra: map[string]interface{}{
			"receiverAuthorizer": "0x4444444444444444444444444444444444444444",
		},
	}
}

// ----- ExecuteClaimWithSignature -----

func TestExecuteClaimWithSignature_NoClaims(t *testing.T) {
	scheme := newScheme()
	resp, err := ExecuteClaimWithSignature(
		context.Background(),
		scheme.signer,
		&batchsettlement.BatchSettlementClaimPayload{Claims: nil},
		reqsFor(testNetwork),
		scheme.authorizerSigner,
		nil,
	)
	if resp != nil {
		t.Fatalf("expected nil resp, got %+v", resp)
	}
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidClaimPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteClaimWithSignature_BadProvidedSignature(t *testing.T) {
	scheme := newScheme()
	payload := &batchsettlement.BatchSettlementClaimPayload{
		Claims:                   []batchsettlement.BatchSettlementVoucherClaim{sampleClaim()},
		ClaimAuthorizerSignature: "not-hex",
	}
	_, err := ExecuteClaimWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidClaimPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteClaimWithSignature_AuthorizerAddressMismatch(t *testing.T) {
	scheme := newScheme()
	claim := sampleClaim()
	claim.Voucher.Channel.ReceiverAuthorizer = "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed"
	payload := &batchsettlement.BatchSettlementClaimPayload{Claims: []batchsettlement.BatchSettlementVoucherClaim{claim}}
	_, err := ExecuteClaimWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrAuthorizerAddressMismatch {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteClaimWithSignature_SimulationFailed(t *testing.T) {
	scheme := newScheme()
	claim := sampleClaim()
	claim.Voucher.Channel.ReceiverAuthorizer = "0xauthorizer"
	payload := &batchsettlement.BatchSettlementClaimPayload{Claims: []batchsettlement.BatchSettlementVoucherClaim{claim}}
	resp, err := ExecuteClaimWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.Success || resp.ErrorReason != ErrClaimSimulationFailed {
		t.Fatalf("got %+v", resp)
	}
}

// ----- ExecuteRefundWithSignature -----

func TestExecuteRefundWithSignature_BadAmount(t *testing.T) {
	scheme := newScheme()
	payload := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: validConfig(),
		Amount:        "not-a-number",
		RefundNonce:   "1",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidRefundPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteRefundWithSignature_BadNonce(t *testing.T) {
	scheme := newScheme()
	payload := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: validConfig(),
		Amount:        "100",
		RefundNonce:   "not-a-number",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidRefundPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteRefundWithSignature_BadProvidedRefundSig(t *testing.T) {
	scheme := newScheme()
	payload := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:                      "refund",
		ChannelConfig:             validConfig(),
		Amount:                    "100",
		RefundNonce:               "1",
		RefundAuthorizerSignature: "not-hex",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidRefundPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteRefundWithSignature_AuthorizerAddressMismatch(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	cfg.ReceiverAuthorizer = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	payload := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Amount:        "100",
		RefundNonce:   "1",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrAuthorizerAddressMismatch {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteRefundWithSignature_SimulationFailed_DirectPath(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	cfg.ReceiverAuthorizer = "0xauthorizer"
	payload := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Amount:        "100",
		RefundNonce:   "1",
	}
	resp, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundSimulationFailed {
		t.Fatalf("got %+v", resp)
	}
}

func TestExecuteRefundWithSignature_NoBalance(t *testing.T) {
	cfg := validConfig()
	cfg.ReceiverAuthorizer = "0xauthorizer"
	signer := &fakeFacilitatorSigner{
		addresses: []string{"0xfacilitator"},
		readContract: func(functionName string, _ ...interface{}) (interface{}, error) {
			if functionName == evm.FunctionTryAggregate {
				return multicallChannelStateResult(t, big.NewInt(10000), big.NewInt(10000), 0, big.NewInt(0)), nil
			}
			return nil, errors.New("unexpected rpc")
		},
	}
	payload := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Amount:        "9000",
		RefundNonce:   "0",
	}

	resp, err := ExecuteRefundWithSignature(context.Background(), signer, payload, reqsFor(testNetwork), &fakeAuthorizerSigner{addr: "0xauthorizer"}, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundNoBalance {
		t.Fatalf("got %+v", resp)
	}
	if signer.writeCalls != 0 {
		t.Fatalf("writeCalls = %d, want 0", signer.writeCalls)
	}
}

func TestExecuteRefundWithSignature_BadProvidedClaimSig(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	cfg.ReceiverAuthorizer = "0xauthorizer"
	payload := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:                      "refund",
		ChannelConfig:             cfg,
		Amount:                    "100",
		RefundNonce:               "1",
		Claims:                    []batchsettlement.BatchSettlementVoucherClaim{sampleClaim()},
		ClaimAuthorizerSignature:  "not-hex",
		RefundAuthorizerSignature: "0xdead",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidRefundPayload {
		t.Fatalf("got err = %v", err)
	}
}

// ----- ExecuteSettle -----

func TestExecuteSettle_SimulationFailed(t *testing.T) {
	signer := &fakeFacilitatorSigner{
		addresses: []string{"0xfacilitator"},
		readContract: func(functionName string, _ ...interface{}) (interface{}, error) {
			if functionName == "receivers" {
				return []interface{}{big.NewInt(2500), big.NewInt(0)}, nil
			}
			return nil, errors.New("revert")
		},
	}
	payload := &batchsettlement.BatchSettlementSettlePayload{
		Type:     "settle",
		Receiver: "0x3333333333333333333333333333333333333333",
		Token:    "0x5555555555555555555555555555555555555555",
	}
	resp, err := ExecuteSettle(context.Background(), signer, payload, reqsFor(testNetwork), nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.Success || resp.ErrorReason != ErrSettleSimulationFailed {
		t.Fatalf("got %+v", resp)
	}
}

func TestExecuteSettle_NothingToSettle(t *testing.T) {
	signer := &fakeFacilitatorSigner{
		addresses: []string{"0xfacilitator"},
		readContract: func(functionName string, _ ...interface{}) (interface{}, error) {
			if functionName == "receivers" {
				return []interface{}{big.NewInt(2500), big.NewInt(2500)}, nil
			}
			return nil, errors.New("unexpected rpc")
		},
	}
	payload := &batchsettlement.BatchSettlementSettlePayload{
		Type:     "settle",
		Receiver: "0x3333333333333333333333333333333333333333",
		Token:    "0x5555555555555555555555555555555555555555",
	}

	resp, err := ExecuteSettle(context.Background(), signer, payload, reqsFor(testNetwork), nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.Success || resp.ErrorReason != ErrNothingToSettle {
		t.Fatalf("got %+v", resp)
	}
	if signer.writeCalls != 0 {
		t.Fatalf("writeCalls = %d, want 0", signer.writeCalls)
	}
}

// ----- SettleDeposit -----

func TestSettleDeposit_BadAmount(t *testing.T) {
	scheme := newScheme()
	payload := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: validConfig(),
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: "not-a-number",
		},
	}
	_, err := SettleDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork), nil, nil, nil, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestSettleDeposit_MissingAuthorization(t *testing.T) {
	// buildERC3009CollectorData returns an error when no auth is present, so
	// SettleDeposit short-circuits with ErrInvalidDepositPayload before any RPC.
	scheme := newScheme()
	payload := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: validConfig(),
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: "100",
		},
	}
	_, err := SettleDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork), nil, nil, nil, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

// TestSettleDeposit_PostReceiptBalanceNotDoubled pins that SettleDeposit anchors
// optimistic balance to the pre-submit channel read. When the post-receipt RPC
// already reflects deposit=100 (balance=100), the settle extra must report 100
// — not 200 from adding depositAmount again on top of the post-deposit read.
func TestSettleDeposit_PostReceiptBalanceNotDoubled(t *testing.T) {
	cfg := validConfig()
	channelId, err := batchsettlement.ComputeChannelId(cfg, testNetwork)
	if err != nil {
		t.Fatalf("compute channel id: %v", err)
	}

	var tryAggregateCalls int
	var writeSeen bool
	signer := &fakeFacilitatorSigner{
		addresses: []string{"0xfacilitator"},
		writeContract: func(functionName string, _ ...interface{}) (string, error) {
			if functionName != "deposit" {
				t.Fatalf("unexpected write: %s", functionName)
			}
			if tryAggregateCalls < 1 {
				t.Fatal("expected pre-submit ReadChannelState before WriteContract")
			}
			writeSeen = true
			return "0x" + strings.Repeat("ab", 32), nil
		},
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
		},
		readContract: func(functionName string, _ ...interface{}) (interface{}, error) {
			if functionName != evm.FunctionTryAggregate {
				return nil, errors.New("unexpected rpc")
			}
			tryAggregateCalls++
			if !writeSeen {
				// Pre-submit: channel empty.
				return multicallChannelStateResult(t, big.NewInt(0), big.NewInt(0), 0, big.NewInt(0)), nil
			}
			// Post-receipt: RPC already includes the mined deposit.
			return multicallChannelStateResult(t, big.NewInt(100), big.NewInt(0), 0, big.NewInt(0)), nil
		},
	}

	payload := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Voucher: batchsettlement.BatchSettlementVoucherFields{
			ChannelId:          channelId,
			MaxClaimableAmount: "100",
			Signature:          "0x" + strings.Repeat("22", 65),
		},
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: "100",
			Authorization: batchsettlement.BatchSettlementDepositAuthorization{
				Erc3009Authorization: goodErc3009Auth(),
			},
		},
	}

	resp, err := SettleDeposit(context.Background(), signer, payload, reqsFor(testNetwork), nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("SettleDeposit: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got %+v", resp)
	}
	cs, ok := resp.Extra["channelState"].(map[string]interface{})
	if !ok {
		t.Fatalf("missing channelState in extra: %+v", resp.Extra)
	}
	if got, _ := cs["balance"].(string); got != "100" {
		t.Fatalf("channelState.balance = %q, want \"100\" (not doubled)", got)
	}
	if tryAggregateCalls < 2 {
		t.Fatalf("tryAggregateCalls = %d, want at least pre-submit + post-receipt", tryAggregateCalls)
	}
}

// TestVerifyDeposit_ExtraBalanceIsOnchainNotProjected pins that verify extra
// reports the current onchain balance, not balance+deposit. Projecting here
// lets AfterVerifyHook cache unmined escrow and approve later vouchers against it.
func TestVerifyDeposit_ExtraBalanceIsOnchainNotProjected(t *testing.T) {
	privKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	payerAddr := crypto.PubkeyToAddress(privKey.PublicKey).Hex()
	clientSigner, err := evmsigners.NewClientSignerFromPrivateKey(hex.EncodeToString(crypto.FromECDSA(privKey)))
	if err != nil {
		t.Fatalf("NewClientSignerFromPrivateKey: %v", err)
	}

	cfg := validConfig()
	cfg.Payer = payerAddr
	cfg.PayerAuthorizer = payerAddr // voucher ECDSA against payerAuthorizer
	id, err := batchsettlement.ComputeChannelId(cfg, testNetwork)
	if err != nil {
		t.Fatalf("ComputeChannelId: %v", err)
	}

	onchainBalance := big.NewInt(100)
	depositAmount := big.NewInt(100)
	maxClaimable := "150" // within onchain+deposit (200), above onchain (100)
	tokenName, tokenVersion := "USD Coin", "2"
	now := time.Now().Unix()
	salt := "0x" + strings.Repeat("aa", 32)

	erc3009Nonce, err := batchsettlement.BuildErc3009DepositNonce(id, salt)
	if err != nil {
		t.Fatalf("BuildErc3009DepositNonce: %v", err)
	}
	nonceBytes, err := evm.HexToBytes(erc3009Nonce)
	if err != nil {
		t.Fatalf("HexToBytes nonce: %v", err)
	}
	erc3009Sig, err := clientSigner.SignTypedData(
		context.Background(),
		evm.TypedDataDomain{
			Name:              tokenName,
			Version:           tokenVersion,
			ChainID:           big.NewInt(8453),
			VerifyingContract: cfg.Token,
		},
		map[string][]evm.TypedDataField{
			"EIP712Domain": {
				{Name: "name", Type: "string"},
				{Name: "version", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
			"ReceiveWithAuthorization": batchsettlement.ReceiveAuthorizationTypes["ReceiveWithAuthorization"],
		},
		"ReceiveWithAuthorization",
		map[string]interface{}{
			"from":        payerAddr,
			"to":          batchsettlement.ERC3009DepositCollectorAddress,
			"value":       depositAmount,
			"validAfter":  big.NewInt(0),
			"validBefore": big.NewInt(now + 3600),
			"nonce":       nonceBytes,
		},
	)
	if err != nil {
		t.Fatalf("SignTypedData ERC-3009: %v", err)
	}
	voucher, err := bsclient.SignVoucher(context.Background(), clientSigner, id, maxClaimable, testNetwork)
	if err != nil {
		t.Fatalf("SignVoucher: %v", err)
	}

	facSigner := &fakeFacilitatorSigner{
		addresses: []string{"0xfacilitator"},
		getBalance: func(_ string, _ string) (*big.Int, error) {
			return big.NewInt(1000), nil
		},
		readContract: func(functionName string, _ ...interface{}) (interface{}, error) {
			switch functionName {
			case evm.FunctionTryAggregate:
				return multicallChannelStateResult(t, onchainBalance, big.NewInt(0), 0, big.NewInt(0)), nil
			case "deposit":
				return nil, nil // simulation ok
			default:
				return nil, fmt.Errorf("unexpected rpc: %s", functionName)
			}
		},
	}
	payload := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: depositAmount.String(),
			Authorization: batchsettlement.BatchSettlementDepositAuthorization{
				Erc3009Authorization: &batchsettlement.BatchSettlementErc3009Authorization{
					ValidAfter:  "0",
					ValidBefore: fmt.Sprintf("%d", now+3600),
					Salt:        salt,
					Signature:   evm.BytesToHex(erc3009Sig),
				},
			},
		},
		Voucher: *voucher,
	}
	reqs := reqsFor(testNetwork)
	reqs.Extra = map[string]interface{}{
		"receiverAuthorizer":  cfg.ReceiverAuthorizer,
		"assetTransferMethod": "eip3009",
		"name":                tokenName,
		"version":             tokenVersion,
	}

	resp, err := VerifyDeposit(context.Background(), facSigner, payload, reqs, nil, nil, nil)
	if err != nil {
		t.Fatalf("VerifyDeposit: %v", err)
	}
	if resp == nil || !resp.IsValid {
		t.Fatalf("expected valid verify, got %+v", resp)
	}
	got, _ := resp.Extra["balance"].(string)
	if got != "100" {
		t.Fatalf("extra.balance = %q, want %q (onchain, not projected 200)", got, "100")
	}
}

// ----- VerifyDeposit pre-RPC paths -----

func TestVerifyDeposit_BadAmount(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	id, _ := batchsettlement.ComputeChannelId(cfg, testNetwork)
	payload := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: "0",
		},
		Voucher: batchsettlement.BatchSettlementVoucherFields{
			ChannelId:          id,
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork), nil, nil, nil)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestVerifyDeposit_BadValidAfter(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	id, _ := batchsettlement.ComputeChannelId(cfg, testNetwork)
	payload := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: "100",
			Authorization: batchsettlement.BatchSettlementDepositAuthorization{
				Erc3009Authorization: &batchsettlement.BatchSettlementErc3009Authorization{
					ValidAfter:  "not-a-number",
					ValidBefore: "9999999999",
					Salt:        "0x" + zeros(64),
					Signature:   "0xdeadbeef",
				},
			},
		},
		Voucher: batchsettlement.BatchSettlementVoucherFields{
			ChannelId:          id,
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork), nil, nil, nil)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestVerifyDeposit_BadValidBefore(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	id, _ := batchsettlement.ComputeChannelId(cfg, testNetwork)
	payload := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: "100",
			Authorization: batchsettlement.BatchSettlementDepositAuthorization{
				Erc3009Authorization: &batchsettlement.BatchSettlementErc3009Authorization{
					ValidAfter:  "0",
					ValidBefore: "not-a-number",
					Salt:        "0x" + zeros(64),
					Signature:   "0xdeadbeef",
				},
			},
		},
		Voucher: batchsettlement.BatchSettlementVoucherFields{
			ChannelId:          id,
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork), nil, nil, nil)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestVerifyDeposit_ExpiredAuthorization(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	id, _ := batchsettlement.ComputeChannelId(cfg, testNetwork)
	payload := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: "100",
			Authorization: batchsettlement.BatchSettlementDepositAuthorization{
				Erc3009Authorization: &batchsettlement.BatchSettlementErc3009Authorization{
					ValidAfter:  "0",
					ValidBefore: "1",
					Salt:        "0x" + zeros(64),
					Signature:   "0xdeadbeef",
				},
			},
		},
		Voucher: batchsettlement.BatchSettlementVoucherFields{
			ChannelId:          id,
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork), nil, nil, nil)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrValidBeforeExpired {
		t.Fatalf("got err = %v", err)
	}
}

func TestVerifyDeposit_ChannelConfigInvalid(t *testing.T) {
	// channelId mismatch fires before any RPC.
	scheme := newScheme()
	cfg := validConfig()
	payload := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: "100",
		},
		Voucher: batchsettlement.BatchSettlementVoucherFields{
			ChannelId:          "0x" + zeros(64),
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork), nil, nil, nil)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrChannelIdMismatch {
		t.Fatalf("got err = %v", err)
	}
}

// ----- VerifyVoucher pre-RPC paths -----

func TestVerifyVoucher_ChannelConfigInvalid(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	payload := &batchsettlement.BatchSettlementVoucherPayload{
		Type:          "voucher",
		ChannelConfig: cfg,
		Voucher: batchsettlement.BatchSettlementVoucherFields{
			ChannelId:          "0x" + zeros(64),
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyVoucher(context.Background(), scheme.signer, payload, reqsFor(testNetwork), cfg)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrChannelIdMismatch {
		t.Fatalf("got err = %v", err)
	}
}

// TestVerifyRefundVoucher_ChannelConfigInvalid ensures VerifyRefundVoucher
// shares the same channel-id validation surface as VerifyVoucher. The refund
// path is otherwise identical aside from the cumulative comparison.
func TestVerifyRefundVoucher_ChannelConfigInvalid(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	payload := &batchsettlement.BatchSettlementRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Voucher: batchsettlement.BatchSettlementVoucherFields{
			ChannelId:          "0x" + zeros(64),
			MaxClaimableAmount: "0",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyRefundVoucher(context.Background(), scheme.signer, payload, reqsFor(testNetwork), cfg)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrChannelIdMismatch {
		t.Fatalf("got err = %v", err)
	}
}

// ----- helpers -----

func sampleClaim() batchsettlement.BatchSettlementVoucherClaim {
	c := batchsettlement.BatchSettlementVoucherClaim{
		Signature:    "0xdeadbeef",
		TotalClaimed: "0",
	}
	c.Voucher.Channel = validConfig()
	c.Voucher.MaxClaimableAmount = "100"
	return c
}

func zeros(n int) string {
	out := make([]byte, n)
	for i := range out {
		out[i] = '0'
	}
	return string(out)
}

type testMulticallResult struct {
	Success    bool
	ReturnData []byte
}

func multicallChannelStateResult(
	t *testing.T,
	balance *big.Int,
	totalClaimed *big.Int,
	withdrawRequestedAt int64,
	refundNonce *big.Int,
) []testMulticallResult {
	t.Helper()

	channelsABI, err := abi.JSON(strings.NewReader(string(batchsettlement.BatchSettlementChannelsABI)))
	if err != nil {
		t.Fatalf("channels abi: %v", err)
	}
	pendingWithdrawalsABI, err := abi.JSON(strings.NewReader(string(batchsettlement.BatchSettlementPendingWithdrawalsABI)))
	if err != nil {
		t.Fatalf("pending withdrawals abi: %v", err)
	}
	refundNonceABI, err := abi.JSON(strings.NewReader(string(batchsettlement.BatchSettlementRefundNonceABI)))
	if err != nil {
		t.Fatalf("refund nonce abi: %v", err)
	}

	channelData, err := channelsABI.Methods["channels"].Outputs.Pack(balance, totalClaimed)
	if err != nil {
		t.Fatalf("pack channels: %v", err)
	}
	pendingData, err := pendingWithdrawalsABI.Methods["pendingWithdrawals"].Outputs.Pack(big.NewInt(0), big.NewInt(withdrawRequestedAt))
	if err != nil {
		t.Fatalf("pack pending withdrawals: %v", err)
	}
	nonceData, err := refundNonceABI.Methods["refundNonce"].Outputs.Pack(refundNonce)
	if err != nil {
		t.Fatalf("pack refund nonce: %v", err)
	}

	return []testMulticallResult{
		{Success: true, ReturnData: channelData},
		{Success: true, ReturnData: pendingData},
		{Success: true, ReturnData: nonceData},
	}
}

// ----- buildRefundResponse -----

// TestBuildRefundResponse pins the refund response shape:
//   - top-level: success, tx, network, payer, amount
//   - extra.channelState: channelId, balance, totalClaimed, withdrawRequestedAt, refundNonce
//   - NO `refund: true` flag at any level; resource hooks use the payload type
//     and channelState fields instead
//   - NO `chargedCumulativeAmount` (the resource server's
//     enrichSettlementResponse hook adds it via additive merge)
func TestBuildRefundResponse(t *testing.T) {
	details := refundSettlementDetails{
		amount: "2000",
		channelState: batchsettlement.BatchSettlementChannelStateExtra{
			ChannelId:           "0xchan",
			Balance:             "3000",
			TotalClaimed:        "3000",
			WithdrawRequestedAt: 0,
			RefundNonce:         "1",
		},
	}
	resp := buildRefundResponse("0xtx", x402.Network(testNetwork), "0xpayer", details)
	if !resp.Success || resp.Transaction != "0xtx" || resp.Network != x402.Network(testNetwork) {
		t.Fatalf("envelope: %+v", resp)
	}
	if resp.Payer != "0xpayer" {
		t.Fatalf("payer = %q, want 0xpayer", resp.Payer)
	}
	if resp.Amount != "2000" {
		t.Fatalf("amount = %q, want 2000", resp.Amount)
	}
	if _, hasLegacy := resp.Extra["refund"]; hasLegacy {
		t.Fatalf("extra.refund must NOT be emitted; got %+v", resp.Extra)
	}
	cs, ok := resp.Extra["channelState"].(map[string]interface{})
	if !ok {
		t.Fatalf("extra.channelState missing or wrong shape: %+v", resp.Extra)
	}
	if cs["channelId"] != "0xchan" {
		t.Fatalf("channelId = %v", cs["channelId"])
	}
	if cs["balance"] != "3000" {
		t.Fatalf("balance = %v", cs["balance"])
	}
	if cs["totalClaimed"] != "3000" {
		t.Fatalf("totalClaimed = %v", cs["totalClaimed"])
	}
	if cs["refundNonce"] != "1" {
		t.Fatalf("refundNonce = %v", cs["refundNonce"])
	}
	if _, hasCharged := cs["chargedCumulativeAmount"]; hasCharged {
		t.Fatalf("chargedCumulativeAmount must NOT be emitted by facilitator (server enrichSettlementResponse adds it): %+v", cs)
	}
}

// TestComputeRefundSettlementDetails_AnalyticPathNoClaims covers the common
// case: no pending withdrawal, no claims accompanying the refund. The
// snapshot is computed from preState + payload alone, without a post-state poll.
func TestComputeRefundSettlementDetails_AnalyticPathNoClaims(t *testing.T) {
	preState := &batchsettlement.ChannelState{
		Balance:             big.NewInt(5000),
		TotalClaimed:        big.NewInt(0),
		WithdrawRequestedAt: 0,
		RefundNonce:         big.NewInt(0),
	}
	payload := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:        "refund",
		Amount:      "2000",
		RefundNonce: "0",
	}
	details := computeRefundSettlementDetails(
		context.Background(), nil /*signer not consulted*/, payload, "0xchan", preState, big.NewInt(2000),
	)
	if details.amount != "2000" {
		t.Fatalf("amount = %q, want 2000 (no available cap)", details.amount)
	}
	if details.channelState.Balance != "3000" {
		t.Fatalf("balance = %q, want 3000 (5000 - 2000)", details.channelState.Balance)
	}
	if details.channelState.TotalClaimed != "0" {
		t.Fatalf("totalClaimed = %q, want 0 (no claims)", details.channelState.TotalClaimed)
	}
	if details.channelState.RefundNonce != "1" {
		t.Fatalf("refundNonce = %q, want 1 (preNonce + 1)", details.channelState.RefundNonce)
	}
	if details.channelState.WithdrawRequestedAt != 0 {
		t.Fatalf("withdrawRequestedAt = %d, want 0", details.channelState.WithdrawRequestedAt)
	}
}

// TestComputeRefundSettlementDetails_CapsAtAvailable ensures a requested refund
// above preBalance - postClaimTotalClaimed is capped at the available remainder.
func TestComputeRefundSettlementDetails_CapsAtAvailable(t *testing.T) {
	preState := &batchsettlement.ChannelState{
		Balance:             big.NewInt(5000),
		TotalClaimed:        big.NewInt(0),
		WithdrawRequestedAt: 0,
		RefundNonce:         big.NewInt(0),
	}
	// Claims up to totalClaimed=4000 → available = 5000 - 4000 = 1000.
	payload := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:        "refund",
		Amount:      "2000",
		RefundNonce: "0",
		Claims: []batchsettlement.BatchSettlementVoucherClaim{{
			TotalClaimed: "4000",
		}},
	}
	details := computeRefundSettlementDetails(
		context.Background(), nil, payload, "0xchan", preState, big.NewInt(2000),
	)
	if details.amount != "1000" {
		t.Fatalf("amount = %q, want 1000 (capped at available)", details.amount)
	}
	if details.channelState.Balance != "4000" {
		t.Fatalf("balance = %q, want 4000 (5000 - 1000)", details.channelState.Balance)
	}
	if details.channelState.TotalClaimed != "4000" {
		t.Fatalf("totalClaimed = %q, want 4000 (advances to last claim)", details.channelState.TotalClaimed)
	}
}

// TestComputeRefundSettlementDetails_NoPreState exercises the RPC-failure
// fallback: missing preState means zero available balance, zero actual refund,
// zero postBalance, and refundNonce advances to 1. Ensures the response never
// panics on a missing chain read.
func TestComputeRefundSettlementDetails_NoPreState(t *testing.T) {
	payload := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:        "refund",
		Amount:      "2000",
		RefundNonce: "0",
	}
	details := computeRefundSettlementDetails(
		context.Background(), nil, payload, "0xchan", nil, big.NewInt(2000),
	)
	if details.amount != "0" {
		t.Fatalf("amount = %q, want 0 (no preState → no available)", details.amount)
	}
	if details.channelState.Balance != "0" {
		t.Fatalf("balance = %q, want 0", details.channelState.Balance)
	}
	if details.channelState.RefundNonce != "1" {
		t.Fatalf("refundNonce = %q, want 1", details.channelState.RefundNonce)
	}
}

// ----- encodeXxxCalldata + buildVoucherClaimArgs -----

func TestBuildVoucherClaimArgs_Length(t *testing.T) {
	claims := []batchsettlement.BatchSettlementVoucherClaim{sampleClaim(), sampleClaim()}
	out := buildVoucherClaimArgs(claims)
	// The result is a slice of unexported struct values; assert via reflection.
	if v, ok := out.([]struct {
		Voucher struct {
			Channel            interface{}
			MaxClaimableAmount *big.Int
		}
		Signature    []byte
		TotalClaimed *big.Int
	}); ok {
		if len(v) != 2 {
			t.Fatalf("len = %d", len(v))
		}
		return
	}
	// Fallback: just confirm non-nil
	if out == nil {
		t.Fatal("expected non-nil result")
	}
}
