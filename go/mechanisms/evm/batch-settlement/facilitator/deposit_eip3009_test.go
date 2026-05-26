package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
)

const (
	testErc3009Payer     = "0x1111111111111111111111111111111111111111"
	testErc3009Token     = "0x2222222222222222222222222222222222222222"
	testErc3009ChannelId = "0x3333333333333333333333333333333333333333333333333333333333333333"
)

func goodErc3009Auth() *batchsettlement.BatchSettlementErc3009Authorization {
	now := time.Now().Unix()
	return &batchsettlement.BatchSettlementErc3009Authorization{
		ValidAfter:  fmt.Sprintf("%d", now-60),
		ValidBefore: fmt.Sprintf("%d", now+3600),
		Salt:        "0x" + strings.Repeat("aa", 32),
		Signature:   "0x" + strings.Repeat("11", 65),
	}
}

func goodErc3009Config() batchsettlement.ChannelConfig {
	return batchsettlement.ChannelConfig{
		Payer:              testErc3009Payer,
		PayerAuthorizer:    testErc3009Payer,
		Receiver:           "0xreceiver000000000000000000000000000000ab",
		ReceiverAuthorizer: "0xreceiver000000000000000000000000000000ab",
		Token:              testErc3009Token,
		WithdrawDelay:      900,
		Salt:               "0x" + strings.Repeat("00", 32),
	}
}

// goodErc3009Extra returns the resource-server-populated `requirements.extra`
// shape the ERC-3009 verifier consumes.
func goodErc3009Extra() map[string]interface{} {
	return map[string]interface{}{
		"name":    "USD Coin",
		"version": "2",
	}
}

// stubErc3009Signer overrides VerifyTypedData on top of fakeFacilitatorSigner
// so individual ERC-3009 verify branches can be exercised without a live RPC.
type stubErc3009Signer struct {
	fakeFacilitatorSigner
	verifyTypedDataResult bool
	verifyTypedDataErr    error
}

func (s *stubErc3009Signer) VerifyTypedData(_ context.Context, _ string, _ evm.TypedDataDomain, _ map[string][]evm.TypedDataField, _ string, _ map[string]interface{}, _ []byte) (bool, error) {
	return s.verifyTypedDataResult, s.verifyTypedDataErr
}

// TestVerifyErc3009_InvalidValidAfter pins the malformed-input branch: a
// non-numeric `validAfter` is rejected before any signer call so the
// downstream RPC path isn't reached.
func TestVerifyErc3009_InvalidValidAfter(t *testing.T) {
	auth := goodErc3009Auth()
	auth.ValidAfter = "not-a-number"
	_, err := verifyErc3009DepositAuthorization(
		context.Background(), &fakeFacilitatorSigner{},
		goodErc3009Config(), testErc3009ChannelId,
		big.NewInt(1000), auth, big.NewInt(8453), goodErc3009Extra(),
	)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrInvalidDepositPayload {
		t.Fatalf("got %v", err)
	}
}

// TestVerifyErc3009_InvalidValidBefore mirrors the validAfter case above so
// both numeric input fields are guarded by the same invalid-payload reason.
func TestVerifyErc3009_InvalidValidBefore(t *testing.T) {
	auth := goodErc3009Auth()
	auth.ValidBefore = "not-a-number"
	_, err := verifyErc3009DepositAuthorization(
		context.Background(), &fakeFacilitatorSigner{},
		goodErc3009Config(), testErc3009ChannelId,
		big.NewInt(1000), auth, big.NewInt(8453), goodErc3009Extra(),
	)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrInvalidDepositPayload {
		t.Fatalf("got %v", err)
	}
}

// TestVerifyErc3009_ValidBeforeExpired pins the time-window check: an
// already-expired authorization must surface ErrValidBeforeExpired as a
// well-formed-but-rejected reason (not as an internal error).
func TestVerifyErc3009_ValidBeforeExpired(t *testing.T) {
	auth := goodErc3009Auth()
	now := time.Now().Unix()
	auth.ValidAfter = fmt.Sprintf("%d", now-3600)
	auth.ValidBefore = fmt.Sprintf("%d", now-60)
	reason, err := verifyErc3009DepositAuthorization(
		context.Background(), &fakeFacilitatorSigner{},
		goodErc3009Config(), testErc3009ChannelId,
		big.NewInt(1000), auth, big.NewInt(8453), goodErc3009Extra(),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrValidBeforeExpired {
		t.Fatalf("reason = %q, want %q", reason, ErrValidBeforeExpired)
	}
}

// TestVerifyErc3009_ValidAfterInFuture pins the not-yet-valid branch: an
// authorization whose validAfter is in the future must surface
// ErrValidAfterInFuture as a well-formed-but-rejected reason.
func TestVerifyErc3009_ValidAfterInFuture(t *testing.T) {
	auth := goodErc3009Auth()
	now := time.Now().Unix()
	auth.ValidAfter = fmt.Sprintf("%d", now+3600)
	auth.ValidBefore = fmt.Sprintf("%d", now+7200)
	reason, err := verifyErc3009DepositAuthorization(
		context.Background(), &fakeFacilitatorSigner{},
		goodErc3009Config(), testErc3009ChannelId,
		big.NewInt(1000), auth, big.NewInt(8453), goodErc3009Extra(),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrValidAfterInFuture {
		t.Fatalf("reason = %q, want %q", reason, ErrValidAfterInFuture)
	}
}

// TestVerifyErc3009_MissingExtraName pins the structured-rejection branch when
// the resource server forgot to populate `requirements.extra.name`. The ERC-3009
// deposit collector needs the token's EIP-712 domain to recompute the digest, so
// the facilitator must surface ErrMissingEip712Domain instead of a generic
// invalid-payload reason.
func TestVerifyErc3009_MissingExtraName(t *testing.T) {
	extra := goodErc3009Extra()
	delete(extra, "name")
	reason, err := verifyErc3009DepositAuthorization(
		context.Background(), &fakeFacilitatorSigner{},
		goodErc3009Config(), testErc3009ChannelId,
		big.NewInt(1000), goodErc3009Auth(), big.NewInt(8453), extra,
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrMissingEip712Domain {
		t.Fatalf("reason = %q, want %q", reason, ErrMissingEip712Domain)
	}
}

// TestVerifyErc3009_MissingExtraVersion mirrors the missing-name case for the
// version field — both are required and the facilitator should not assume a
// silent default like "1", which would mask resource-server misconfiguration.
func TestVerifyErc3009_MissingExtraVersion(t *testing.T) {
	extra := goodErc3009Extra()
	delete(extra, "version")
	reason, err := verifyErc3009DepositAuthorization(
		context.Background(), &fakeFacilitatorSigner{},
		goodErc3009Config(), testErc3009ChannelId,
		big.NewInt(1000), goodErc3009Auth(), big.NewInt(8453), extra,
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrMissingEip712Domain {
		t.Fatalf("reason = %q, want %q", reason, ErrMissingEip712Domain)
	}
}

// TestVerifyErc3009_NilExtra pins the same defensive behavior when the
// extra map itself is nil (e.g. legacy callers / cached requirements without
// metadata). Reading a nil map is well-defined in Go and yields the
// zero-value string, so the missing-domain check still fires.
func TestVerifyErc3009_NilExtra(t *testing.T) {
	reason, err := verifyErc3009DepositAuthorization(
		context.Background(), &fakeFacilitatorSigner{},
		goodErc3009Config(), testErc3009ChannelId,
		big.NewInt(1000), goodErc3009Auth(), big.NewInt(8453), nil,
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrMissingEip712Domain {
		t.Fatalf("reason = %q, want %q", reason, ErrMissingEip712Domain)
	}
}

// TestVerifyErc3009_VerifyTypedDataFalse pins the signature-rejected branch:
// when the signer reports the EIP-712 signature as invalid, the helper must
// surface ErrErc3009SignatureInvalid as a well-formed-but-rejected reason
// (not as an internal error). The valid extra ensures we reach the signer
// instead of short-circuiting on a missing-domain check.
func TestVerifyErc3009_VerifyTypedDataFalse(t *testing.T) {
	signer := &stubErc3009Signer{verifyTypedDataResult: false}
	reason, err := verifyErc3009DepositAuthorization(
		context.Background(), signer,
		goodErc3009Config(), testErc3009ChannelId,
		big.NewInt(1000), goodErc3009Auth(), big.NewInt(8453), goodErc3009Extra(),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrErc3009SignatureInvalid {
		t.Fatalf("reason = %q, want %q", reason, ErrErc3009SignatureInvalid)
	}
}
