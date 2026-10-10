package unit_test

import (
	"context"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/hedera"
	hederafacil "github.com/x402-foundation/x402/go/v2/mechanisms/hedera/exact/facilitator"
)

type hederaSmokeSigner struct {
	addresses []string
}

func (s *hederaSmokeSigner) GetAddresses(context.Context, string) []string {
	return s.addresses
}
func (s *hederaSmokeSigner) SignAndSubmitTransaction(context.Context, string, string, string) (string, error) {
	return "", nil
}
func (s *hederaSmokeSigner) AwaitTransaction(context.Context, string, string) error {
	return nil
}
func (s *hederaSmokeSigner) VerifyPayerSignature(context.Context, string, string, string) hedera.SignatureCheck {
	return hedera.SignatureCheck{OK: true}
}
func (s *hederaSmokeSigner) PreflightTransfer(context.Context, string, string, string, string, string) hedera.SignatureCheck {
	return hedera.SignatureCheck{OK: true}
}
func (s *hederaSmokeSigner) ResolveAccount(context.Context, string, string) (hedera.AccountResolution, error) {
	return hedera.AccountResolution{Exists: true}, nil
}

func TestHederaFacilitatorSupportedKind(t *testing.T) {
	signer := &hederaSmokeSigner{addresses: []string{"0.0.5001"}}
	scheme := hederafacil.NewExactHederaScheme(signer)
	if scheme.Scheme() != hedera.SchemeExact {
		t.Fatal(scheme.Scheme())
	}
	if scheme.CaipFamily() != "hedera:*" {
		t.Fatal(scheme.CaipFamily())
	}

	facilitator := x402.Newx402Facilitator()
	facilitator.Register([]x402.Network{hedera.HederaTestnetCAIP2}, scheme)

	supported := facilitator.GetSupported()
	found := false
	for _, kind := range supported.Kinds {
		if kind.Scheme == hedera.SchemeExact && kind.Network == hedera.HederaTestnetCAIP2 {
			found = true
			if fee, _ := kind.Extra["feePayer"].(string); fee != "0.0.5001" {
				t.Fatalf("extra=%v", kind.Extra)
			}
		}
	}
	if !found {
		t.Fatalf("kinds=%+v", supported.Kinds)
	}
}
