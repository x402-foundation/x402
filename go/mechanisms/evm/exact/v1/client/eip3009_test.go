package client

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	gatewayContract = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE"
	usdcAsset       = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
)

type recordingSigner struct {
	address string
	domain  evm.TypedDataDomain
}

func (s *recordingSigner) Address() string {
	return s.address
}

func (s *recordingSigner) SignTypedData(
	ctx context.Context,
	domain evm.TypedDataDomain,
	fields map[string][]evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	s.domain = domain
	return make([]byte, 65), nil
}

func gatewayRequirementsV1() types.PaymentRequirementsV1 {
	extra := json.RawMessage(`{"name":"GatewayWalletBatched","version":"1","verifyingContract":"` + gatewayContract + `"}`)
	return types.PaymentRequirementsV1{
		Scheme:            "exact",
		Network:           "base",
		Asset:             usdcAsset,
		MaxAmountRequired: "8000",
		PayTo:             "0x0987654321098765432109876543210987654321",
		MaxTimeoutSeconds: 3600,
		Extra:             &extra,
	}
}

func TestCreatePaymentPayloadV1SignsAgainstVerifyingContractWhenValidatorApproves(t *testing.T) {
	signer := &recordingSigner{address: "0x1234567890123456789012345678901234567890"}
	scheme := NewExactEvmSchemeV1(signer, WithVerifyingContractValidator(
		func(candidate string, requirements types.PaymentRequirementsV1) bool {
			return candidate == gatewayContract
		},
	))

	if _, err := scheme.CreatePaymentPayload(context.Background(), gatewayRequirementsV1()); err != nil {
		t.Fatalf("CreatePaymentPayload failed: %v", err)
	}

	if got := evm.NormalizeAddress(signer.domain.VerifyingContract); got != evm.NormalizeAddress(gatewayContract) {
		t.Fatalf("expected domain.VerifyingContract = %s, got %s", gatewayContract, got)
	}
}

func TestCreatePaymentPayloadV1FallsBackToAssetWhenNoValidatorConfigured(t *testing.T) {
	signer := &recordingSigner{address: "0x1234567890123456789012345678901234567890"}
	scheme := NewExactEvmSchemeV1(signer)

	if _, err := scheme.CreatePaymentPayload(context.Background(), gatewayRequirementsV1()); err != nil {
		t.Fatalf("CreatePaymentPayload failed: %v", err)
	}

	if got := evm.NormalizeAddress(signer.domain.VerifyingContract); got != evm.NormalizeAddress(usdcAsset) {
		t.Fatalf("expected domain.VerifyingContract = %s, got %s", usdcAsset, got)
	}
}

func TestCreatePaymentPayloadV1FallsBackToAssetWhenValidatorRejects(t *testing.T) {
	signer := &recordingSigner{address: "0x1234567890123456789012345678901234567890"}
	scheme := NewExactEvmSchemeV1(signer, WithVerifyingContractValidator(
		func(candidate string, requirements types.PaymentRequirementsV1) bool {
			return false
		},
	))

	if _, err := scheme.CreatePaymentPayload(context.Background(), gatewayRequirementsV1()); err != nil {
		t.Fatalf("CreatePaymentPayload failed: %v", err)
	}

	if got := evm.NormalizeAddress(signer.domain.VerifyingContract); got != evm.NormalizeAddress(usdcAsset) {
		t.Fatalf("expected domain.VerifyingContract = %s, got %s", usdcAsset, got)
	}
}
