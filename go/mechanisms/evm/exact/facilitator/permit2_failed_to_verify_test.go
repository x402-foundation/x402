package facilitator

import (
	"context"
	"errors"
	"strings"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

// payerCodeFailingSigner fails eth_getCode for one address, the way an overloaded RPC node fails
// a single call, and answers every other call like roundTripSigner.
type payerCodeFailingSigner struct {
	*roundTripSigner
	failFor string
}

func (s *payerCodeFailingSigner) GetCode(ctx context.Context, address string) ([]byte, error) {
	if strings.EqualFold(address, s.failFor) {
		return nil, errors.New("HTTP request failed. Status: 503")
	}
	return s.roundTripSigner.GetCode(ctx, address)
}

// A payer code lookup that fails decided nothing about the signature, so it must not be reported
// as invalid_permit2_signature.
func TestVerifyPermit2_PayerCodeLookupFailure_IsFailedToVerify(t *testing.T) {
	evm.ResetAssetContractCache()

	payload, requirements, permit2Payload := plainPermit2Payload()
	signer := &payerCodeFailingSigner{
		roundTripSigner: newRoundTripSigner(map[string][]byte{
			strings.ToLower(testToken): {0x60, 0x60},
		}),
		failFor: testPayer,
	}

	_, err := VerifyPermit2(context.Background(), signer, payload, requirements, permit2Payload, nil, nil)

	var ve *x402.VerifyError
	if !errors.As(err, &ve) {
		t.Fatalf("expected a VerifyError, got %v", err)
	}
	if ve.InvalidReason != ErrPermit2FailedToVerifySignature {
		t.Fatalf("expected %q, got %q", ErrPermit2FailedToVerifySignature, ve.InvalidReason)
	}
	if !strings.Contains(ve.InvalidMessage, "503") {
		t.Fatalf("expected the RPC error in InvalidMessage, got %q", ve.InvalidMessage)
	}
}

// The signature check reuses the payer code lookup instead of issuing its own.
func TestVerifyPermit2_EOAPayer_OneCodeLookup(t *testing.T) {
	evm.ResetAssetContractCache()

	payload, requirements, permit2Payload := plainPermit2Payload()
	signer := newRoundTripSigner(map[string][]byte{
		strings.ToLower(testToken): {0x60, 0x60}, // the payer has no code: an EOA
	})

	_, err := VerifyPermit2(context.Background(), signer, payload, requirements, permit2Payload, nil, nil)

	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrPermit2InvalidSignature {
		t.Fatalf("expected %q for a dummy signature from an EOA, got %v", ErrPermit2InvalidSignature, err)
	}
	if got := signer.getCodeCount(testPayer); got != 1 {
		t.Fatalf("expected one payer eth_getCode, got %d", got)
	}
}
