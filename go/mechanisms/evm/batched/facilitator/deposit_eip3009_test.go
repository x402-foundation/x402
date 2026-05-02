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
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
)

const (
	testErc3009Payer     = "0x1111111111111111111111111111111111111111"
	testErc3009Token     = "0x2222222222222222222222222222222222222222"
	testErc3009ChannelId = "0x3333333333333333333333333333333333333333333333333333333333333333"
)

func goodErc3009Auth() *batched.BatchedErc3009Authorization {
	now := time.Now().Unix()
	return &batched.BatchedErc3009Authorization{
		ValidAfter:  fmt.Sprintf("%d", now-60),
		ValidBefore: fmt.Sprintf("%d", now+3600),
		Salt:        "0x" + strings.Repeat("aa", 32),
		Signature:   "0x" + strings.Repeat("11", 65),
	}
}

func goodErc3009Config() batched.ChannelConfig {
	return batched.ChannelConfig{
		Payer:              testErc3009Payer,
		PayerAuthorizer:    testErc3009Payer,
		Receiver:           "0xreceiver000000000000000000000000000000ab",
		ReceiverAuthorizer: "0xreceiver000000000000000000000000000000ab",
		Token:              testErc3009Token,
		WithdrawDelay:      900,
		Salt:               "0x" + strings.Repeat("00", 32),
	}
}

// stubErc3009Signer overrides ReadContract / VerifyTypedData on top of
// fakeFacilitatorSigner so individual ERC-3009 verify branches can be
// exercised without a live RPC. Field semantics:
//   - readContract: when non-nil, replaces the default "no rpc" stub.
//   - verifyTypedDataResult / verifyTypedDataErr: drive the typed-data path.
type stubErc3009Signer struct {
	fakeFacilitatorSigner
	readContract         func(method string) (interface{}, error)
	verifyTypedDataResult bool
	verifyTypedDataErr   error
}

func (s *stubErc3009Signer) ReadContract(_ context.Context, _ string, _ []byte, method string, _ ...interface{}) (interface{}, error) {
	if s.readContract != nil {
		return s.readContract(method)
	}
	return nil, errors.New("no rpc")
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
		big.NewInt(1000), auth, big.NewInt(8453),
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
		big.NewInt(1000), auth, big.NewInt(8453),
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
		big.NewInt(1000), auth, big.NewInt(8453),
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
		big.NewInt(1000), auth, big.NewInt(8453),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrValidAfterInFuture {
		t.Fatalf("reason = %q, want %q", reason, ErrValidAfterInFuture)
	}
}

// TestVerifyErc3009_TokenNameReadFails pins the RPC failure path on the
// token domain read: the helper must wrap the error as
// ErrErc3009SignatureInvalid (not silently swallow it) so callers see a
// clear cross-SDK reason instead of a generic "no rpc" leak.
func TestVerifyErc3009_TokenNameReadFails(t *testing.T) {
	signer := &stubErc3009Signer{
		readContract: func(_ string) (interface{}, error) {
			return nil, errors.New("rpc disconnected")
		},
	}
	_, err := verifyErc3009DepositAuthorization(
		context.Background(), signer,
		goodErc3009Config(), testErc3009ChannelId,
		big.NewInt(1000), goodErc3009Auth(), big.NewInt(8453),
	)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrErc3009SignatureInvalid {
		t.Fatalf("got %v", err)
	}
}

// TestVerifyErc3009_VerifyTypedDataFalse pins the signature-rejected branch:
// when the signer reports the EIP-712 signature as invalid, the helper must
// surface ErrErc3009SignatureInvalid as a well-formed-but-rejected reason
// (not as an internal error). This drives the version() fallback to "1"
// (default for contracts without a `version` getter) by returning a name and
// then erroring on the version read.
func TestVerifyErc3009_VerifyTypedDataFalse(t *testing.T) {
	signer := &stubErc3009Signer{
		readContract: func(method string) (interface{}, error) {
			if method == "name" {
				return "USD Coin", nil
			}
			return nil, errors.New("no version")
		},
		verifyTypedDataResult: false,
	}
	reason, err := verifyErc3009DepositAuthorization(
		context.Background(), signer,
		goodErc3009Config(), testErc3009ChannelId,
		big.NewInt(1000), goodErc3009Auth(), big.NewInt(8453),
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrErc3009SignatureInvalid {
		t.Fatalf("reason = %q, want %q", reason, ErrErc3009SignatureInvalid)
	}
}
