package facilitator

import (
	"context"
	"math/big"
	"strings"
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
)

const (
	testPermit2Payer     = "0x1111111111111111111111111111111111111111"
	testPermit2Token     = "0x2222222222222222222222222222222222222222"
	testPermit2ChannelId = "0x3333333333333333333333333333333333333333333333333333333333333333"
)

func goodPermit2Auth() *batchsettlement.BatchSettlementPermit2Authorization {
	return &batchsettlement.BatchSettlementPermit2Authorization{
		From: testPermit2Payer,
		Permitted: batchsettlement.BatchSettlementPermit2TokenPermissions{
			Token:  testPermit2Token,
			Amount: "1000",
		},
		Spender:   batchsettlement.Permit2DepositCollectorAddress,
		Nonce:     "1",
		Deadline:  "9999999999",
		Witness:   batchsettlement.BatchSettlementPermit2Witness{ChannelId: testPermit2ChannelId},
		Signature: "0x" + strings.Repeat("11", 65),
	}
}

func goodPermit2Config() batchsettlement.ChannelConfig {
	return batchsettlement.ChannelConfig{
		Payer:              testPermit2Payer,
		PayerAuthorizer:    testPermit2Payer,
		Receiver:           "0xreceiver000000000000000000000000000000ab",
		ReceiverAuthorizer: "0xreceiver000000000000000000000000000000ab",
		Token:              testPermit2Token,
		WithdrawDelay:      900,
		Salt:               "0x0000000000000000000000000000000000000000000000000000000000000000",
	}
}

func TestVerifyPermit2_TokenMismatchReason(t *testing.T) {
	auth := goodPermit2Auth()
	auth.Permitted.Token = "0xdeadbeef00000000000000000000000000000000"
	reason, err := verifyPermit2DepositAuthorization(
		context.Background(), &fakeFacilitatorSigner{},
		goodPermit2Config(), testPermit2ChannelId,
		big.NewInt(1000), auth, big.NewInt(8453),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrTokenMismatch {
		t.Fatalf("reason = %q, want %q", reason, ErrTokenMismatch)
	}
}

func TestVerifyPermit2_ChannelIdMismatchReason(t *testing.T) {
	auth := goodPermit2Auth()
	auth.Witness.ChannelId = "0x" + strings.Repeat("ab", 32)
	reason, err := verifyPermit2DepositAuthorization(
		context.Background(), &fakeFacilitatorSigner{},
		goodPermit2Config(), testPermit2ChannelId,
		big.NewInt(1000), auth, big.NewInt(8453),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrChannelIdMismatch {
		t.Fatalf("reason = %q, want %q", reason, ErrChannelIdMismatch)
	}
}

func TestVerifyPermit2_SpenderMismatchReason(t *testing.T) {
	auth := goodPermit2Auth()
	auth.Spender = "0xdeadbeef00000000000000000000000000000000"
	reason, err := verifyPermit2DepositAuthorization(
		context.Background(), &fakeFacilitatorSigner{},
		goodPermit2Config(), testPermit2ChannelId,
		big.NewInt(1000), auth, big.NewInt(8453),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrPermit2InvalidSpender {
		t.Fatalf("reason = %q, want %q", reason, ErrPermit2InvalidSpender)
	}
}

func TestVerifyPermit2_AmountMismatchReason(t *testing.T) {
	auth := goodPermit2Auth()
	auth.Permitted.Amount = "999" // != deposit amount
	reason, err := verifyPermit2DepositAuthorization(
		context.Background(), &fakeFacilitatorSigner{},
		goodPermit2Config(), testPermit2ChannelId,
		big.NewInt(1000), auth, big.NewInt(8453),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrPermit2AmountMismatch {
		t.Fatalf("reason = %q, want %q", reason, ErrPermit2AmountMismatch)
	}
}

func TestVerifyPermit2_DeadlineExpiredReason(t *testing.T) {
	auth := goodPermit2Auth()
	auth.Deadline = "1" // far in the past
	reason, err := verifyPermit2DepositAuthorization(
		context.Background(), &fakeFacilitatorSigner{},
		goodPermit2Config(), testPermit2ChannelId,
		big.NewInt(1000), auth, big.NewInt(8453),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrPermit2DeadlineExpired {
		t.Fatalf("reason = %q, want %q", reason, ErrPermit2DeadlineExpired)
	}
}

func TestVerifyPermit2_InvalidSignatureReason(t *testing.T) {
	signer := &fakeFacilitatorSigner{
		verifyTypedData: func(_ string) (bool, error) { return false, nil },
	}
	auth := goodPermit2Auth()
	reason, err := verifyPermit2DepositAuthorization(
		context.Background(), signer,
		goodPermit2Config(), testPermit2ChannelId,
		big.NewInt(1000), auth, big.NewInt(8453),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrPermit2InvalidSignature {
		t.Fatalf("reason = %q, want %q", reason, ErrPermit2InvalidSignature)
	}
}

func TestVerifyPermit2_ValidAuthorizationReturnsEmpty(t *testing.T) {
	signer := &fakeFacilitatorSigner{
		verifyTypedData: func(_ string) (bool, error) { return true, nil },
	}
	auth := goodPermit2Auth()
	reason, err := verifyPermit2DepositAuthorization(
		context.Background(), signer,
		goodPermit2Config(), testPermit2ChannelId,
		big.NewInt(1000), auth, big.NewInt(8453),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != "" {
		t.Fatalf("reason = %q, want empty", reason)
	}
}
