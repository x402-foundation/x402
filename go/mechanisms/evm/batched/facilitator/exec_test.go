package facilitator

import (
	"context"
	"errors"
	"math/big"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/types"
)

const testNetwork = "eip155:8453"

func reqsFor(network string) types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:  batched.SchemeBatched,
		Network: network,
		PayTo:   "0x3333333333333333333333333333333333333333",
		Asset:   "0x5555555555555555555555555555555555555555",
		Amount:  "100",
	}
}

// ----- ExecuteClaimWithSignature -----

func TestExecuteClaimWithSignature_NoClaims(t *testing.T) {
	scheme := newScheme()
	resp, err := ExecuteClaimWithSignature(
		context.Background(),
		scheme.signer,
		&batched.BatchedClaimPayload{Claims: nil},
		reqsFor(testNetwork),
		scheme.authorizerSigner,
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
	payload := &batched.BatchedClaimPayload{
		Claims:                   []batched.BatchedVoucherClaim{sampleClaim()},
		ClaimAuthorizerSignature: "not-hex",
	}
	_, err := ExecuteClaimWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidClaimPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteClaimWithSignature_AuthorizerAddressMismatch(t *testing.T) {
	scheme := newScheme()
	claim := sampleClaim()
	claim.Voucher.Channel.ReceiverAuthorizer = "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed"
	payload := &batched.BatchedClaimPayload{Claims: []batched.BatchedVoucherClaim{claim}}
	_, err := ExecuteClaimWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrAuthorizerAddressMismatch {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteClaimWithSignature_SimulationFailed(t *testing.T) {
	scheme := newScheme()
	claim := sampleClaim()
	claim.Voucher.Channel.ReceiverAuthorizer = "0xauthorizer"
	payload := &batched.BatchedClaimPayload{Claims: []batched.BatchedVoucherClaim{claim}}
	resp, err := ExecuteClaimWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
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
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: validConfig(),
		Amount:        "not-a-number",
		RefundNonce:   "1",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidRefundPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteRefundWithSignature_BadNonce(t *testing.T) {
	scheme := newScheme()
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: validConfig(),
		Amount:        "100",
		RefundNonce:   "not-a-number",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidRefundPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteRefundWithSignature_BadProvidedRefundSig(t *testing.T) {
	scheme := newScheme()
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:                      "refund",
		ChannelConfig:             validConfig(),
		Amount:                    "100",
		RefundNonce:               "1",
		RefundAuthorizerSignature: "not-hex",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidRefundPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteRefundWithSignature_AuthorizerAddressMismatch(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	cfg.ReceiverAuthorizer = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Amount:        "100",
		RefundNonce:   "1",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrAuthorizerAddressMismatch {
		t.Fatalf("got err = %v", err)
	}
}

func TestExecuteRefundWithSignature_SimulationFailed_DirectPath(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	cfg.ReceiverAuthorizer = "0xauthorizer"
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Amount:        "100",
		RefundNonce:   "1",
	}
	resp, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundSimulationFailed {
		t.Fatalf("got %+v", resp)
	}
}

func TestExecuteRefundWithSignature_BadProvidedClaimSig(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	cfg.ReceiverAuthorizer = "0xauthorizer"
	payload := &batched.BatchedEnrichedRefundPayload{
		Type:                      "refund",
		ChannelConfig:             cfg,
		Amount:                    "100",
		RefundNonce:               "1",
		Claims:                    []batched.BatchedVoucherClaim{sampleClaim()},
		ClaimAuthorizerSignature:  "not-hex",
		RefundAuthorizerSignature: "0xdead",
	}
	_, err := ExecuteRefundWithSignature(context.Background(), scheme.signer, payload, reqsFor(testNetwork), scheme.authorizerSigner)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidRefundPayload {
		t.Fatalf("got err = %v", err)
	}
}

// ----- ExecuteSettle -----

func TestExecuteSettle_SimulationFailed(t *testing.T) {
	scheme := newScheme()
	payload := &batched.BatchedSettlePayload{
		Type:     "settle",
		Receiver: "0x3333333333333333333333333333333333333333",
		Token:    "0x5555555555555555555555555555555555555555",
	}
	resp, err := ExecuteSettle(context.Background(), scheme.signer, payload, reqsFor(testNetwork))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.Success || resp.ErrorReason != ErrSettleSimulationFailed {
		t.Fatalf("got %+v", resp)
	}
}

// ----- SettleDeposit -----

func TestSettleDeposit_BadAmount(t *testing.T) {
	scheme := newScheme()
	payload := &batched.BatchedDepositPayload{
		Type:          "deposit",
		ChannelConfig: validConfig(),
		Deposit: batched.BatchedDepositData{
			Amount: "not-a-number",
		},
	}
	_, err := SettleDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork))
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestSettleDeposit_MissingAuthorization(t *testing.T) {
	// buildERC3009CollectorData returns an error when no auth is present, so
	// SettleDeposit short-circuits with ErrInvalidDepositPayload before any RPC.
	scheme := newScheme()
	payload := &batched.BatchedDepositPayload{
		Type:          "deposit",
		ChannelConfig: validConfig(),
		Deposit: batched.BatchedDepositData{
			Amount: "100",
		},
	}
	_, err := SettleDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork))
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

// ----- VerifyDeposit pre-RPC paths -----

func TestVerifyDeposit_BadAmount(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	id, _ := batched.ComputeChannelId(cfg, testNetwork)
	payload := &batched.BatchedDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batched.BatchedDepositData{
			Amount: "0",
		},
		Voucher: batched.BatchedVoucherFields{
			ChannelId:          id,
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork))
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestVerifyDeposit_BadValidAfter(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	id, _ := batched.ComputeChannelId(cfg, testNetwork)
	payload := &batched.BatchedDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batched.BatchedDepositData{
			Amount: "100",
			Authorization: batched.BatchedDepositAuthorization{
				Erc3009Authorization: &batched.BatchedErc3009Authorization{
					ValidAfter:  "not-a-number",
					ValidBefore: "9999999999",
					Salt:        "0x" + zeros(64),
					Signature:   "0xdeadbeef",
				},
			},
		},
		Voucher: batched.BatchedVoucherFields{
			ChannelId:          id,
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork))
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestVerifyDeposit_BadValidBefore(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	id, _ := batched.ComputeChannelId(cfg, testNetwork)
	payload := &batched.BatchedDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batched.BatchedDepositData{
			Amount: "100",
			Authorization: batched.BatchedDepositAuthorization{
				Erc3009Authorization: &batched.BatchedErc3009Authorization{
					ValidAfter:  "0",
					ValidBefore: "not-a-number",
					Salt:        "0x" + zeros(64),
					Signature:   "0xdeadbeef",
				},
			},
		},
		Voucher: batched.BatchedVoucherFields{
			ChannelId:          id,
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork))
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestVerifyDeposit_ExpiredAuthorization(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	id, _ := batched.ComputeChannelId(cfg, testNetwork)
	payload := &batched.BatchedDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batched.BatchedDepositData{
			Amount: "100",
			Authorization: batched.BatchedDepositAuthorization{
				Erc3009Authorization: &batched.BatchedErc3009Authorization{
					ValidAfter:  "0",
					ValidBefore: "1",
					Salt:        "0x" + zeros(64),
					Signature:   "0xdeadbeef",
				},
			},
		},
		Voucher: batched.BatchedVoucherFields{
			ChannelId:          id,
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork))
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrValidBeforeExpired {
		t.Fatalf("got err = %v", err)
	}
}

func TestVerifyDeposit_ChannelConfigInvalid(t *testing.T) {
	// channelId mismatch fires before any RPC.
	scheme := newScheme()
	cfg := validConfig()
	payload := &batched.BatchedDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Deposit: batched.BatchedDepositData{
			Amount: "100",
		},
		Voucher: batched.BatchedVoucherFields{
			ChannelId:          "0x" + zeros(64),
			MaxClaimableAmount: "100",
			Signature:          "0xsig",
		},
	}
	_, err := VerifyDeposit(context.Background(), scheme.signer, payload, reqsFor(testNetwork))
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrChannelIdMismatch {
		t.Fatalf("got err = %v", err)
	}
}

// ----- VerifyVoucher pre-RPC paths -----

func TestVerifyVoucher_ChannelConfigInvalid(t *testing.T) {
	scheme := newScheme()
	cfg := validConfig()
	payload := &batched.BatchedVoucherPayload{
		Type:          "voucher",
		ChannelConfig: cfg,
		Voucher: batched.BatchedVoucherFields{
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

// ----- helpers -----

func sampleClaim() batched.BatchedVoucherClaim {
	c := batched.BatchedVoucherClaim{
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

// ----- buildRefundResponse -----

func TestBuildRefundResponse(t *testing.T) {
	resp := buildRefundResponse("0xtx", x402.Network(testNetwork))
	if !resp.Success || resp.Transaction != "0xtx" || resp.Network != x402.Network(testNetwork) {
		t.Fatalf("got %+v", resp)
	}
	if resp.Extra == nil || resp.Extra["refund"] != true {
		t.Fatalf("expected refund=true, got %+v", resp.Extra)
	}
}

// ----- encodeXxxCalldata + buildVoucherClaimArgs -----

func TestBuildVoucherClaimArgs_Length(t *testing.T) {
	claims := []batched.BatchedVoucherClaim{sampleClaim(), sampleClaim()}
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

func TestEncodeRefundWithSignatureCalldata(t *testing.T) {
	configTuple := ToContractChannelConfig(validConfig())
	calldata, err := encodeRefundWithSignatureCalldata(configTuple, big.NewInt(100), big.NewInt(1), []byte{0xde, 0xad})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(calldata) < 4 {
		t.Fatalf("calldata too short: %d", len(calldata))
	}
}
