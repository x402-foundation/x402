package facilitator

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	evmv1 "github.com/x402-foundation/x402/go/v2/mechanisms/evm/v1"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	vcGatewayContract = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE"
	vcUsdcAsset       = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
)

// verifyingContractMockSignerV1 mirrors the V2 facilitator's test mock (see
// exact/facilitator/eip3009_verifying_contract_test.go): every address in codeByAddress reports
// as a deployed contract, ReadContract always succeeds, and WriteContract records its target
// address for settle assertions.
type verifyingContractMockSignerV1 struct {
	codeByAddress map[string][]byte
	writeAddress  string
}

func (m *verifyingContractMockSignerV1) GetAddresses() []string { return []string{"0xFac11"} }

func (m *verifyingContractMockSignerV1) ReadContract(ctx context.Context, address string, abi []byte, functionName string, args ...interface{}) (interface{}, error) {
	return nil, nil
}

func (m *verifyingContractMockSignerV1) VerifyTypedData(ctx context.Context, address string, domain evm.TypedDataDomain, types map[string][]evm.TypedDataField, primaryType string, message map[string]interface{}, signature []byte) (bool, error) {
	return false, nil
}

func (m *verifyingContractMockSignerV1) WriteContract(ctx context.Context, address string, abi []byte, functionName string, dataSuffix []byte, args ...interface{}) (string, error) {
	m.writeAddress = address
	return "0x" + strings.Repeat("ab", 32), nil
}

func (m *verifyingContractMockSignerV1) SendTransaction(ctx context.Context, to string, data []byte) (string, error) {
	return "0x" + strings.Repeat("cd", 32), nil
}

func (m *verifyingContractMockSignerV1) WaitForTransactionReceipt(ctx context.Context, txHash string) (*evm.TransactionReceipt, error) {
	return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
}

func (m *verifyingContractMockSignerV1) GetBalance(ctx context.Context, address string, tokenAddress string) (*big.Int, error) {
	return big.NewInt(1_000_000_000), nil
}

func (m *verifyingContractMockSignerV1) GetChainID(ctx context.Context) (*big.Int, error) {
	return big.NewInt(8453), nil
}

func (m *verifyingContractMockSignerV1) GetCode(ctx context.Context, address string) ([]byte, error) {
	return m.codeByAddress[strings.ToLower(address)], nil
}

// signedGatewayPayloadV1 builds a real ECDSA-signed EIP-3009 V1 payload + matching V1
// requirements, signed against the given verifyingContract (not necessarily requirements.Asset).
func signedGatewayPayloadV1(t *testing.T, verifyingContract string) (types.PaymentPayloadV1, types.PaymentRequirementsV1) {
	t.Helper()

	privateKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}
	payer := crypto.PubkeyToAddress(privateKey.PublicKey).Hex()

	chainID, err := evmv1.GetEvmChainId("base")
	if err != nil {
		t.Fatalf("failed to get chain id: %v", err)
	}

	now := time.Now().Unix()
	authorization := evm.ExactEIP3009Authorization{
		From:        payer,
		To:          "0x0987654321098765432109876543210987654321",
		Value:       "8000",
		ValidAfter:  fmt.Sprintf("%d", now-60),
		ValidBefore: fmt.Sprintf("%d", now+600),
		Nonce:       "0x" + strings.Repeat("11", 32),
	}

	hash, err := evm.HashEIP3009Authorization(authorization, chainID, verifyingContract, "GatewayWalletBatched", "1")
	if err != nil {
		t.Fatalf("failed to hash authorization: %v", err)
	}
	sig, err := crypto.Sign(hash, privateKey)
	if err != nil {
		t.Fatalf("failed to sign: %v", err)
	}
	if sig[64] < 27 {
		sig[64] += 27
	}

	evmPayload := &evm.ExactEIP3009Payload{
		Signature:     evm.BytesToHex(sig),
		Authorization: authorization,
	}

	extra := json.RawMessage(`{"name":"GatewayWalletBatched","version":"1","verifyingContract":"` + vcGatewayContract + `"}`)
	requirements := types.PaymentRequirementsV1{
		Scheme:            "exact",
		Network:           "base",
		Asset:             vcUsdcAsset,
		MaxAmountRequired: "8000",
		PayTo:             authorization.To,
		MaxTimeoutSeconds: 3600,
		Extra:             &extra,
	}

	payload := types.PaymentPayloadV1{
		X402Version: 1,
		Scheme:      "exact",
		Network:     "base",
		Payload:     evmPayload.ToMap(),
	}

	return payload, requirements
}

func TestVerifyV1_TrustsVerifyingContractWhenValidatorApproves(t *testing.T) {
	payload, requirements := signedGatewayPayloadV1(t, vcGatewayContract)

	signer := &verifyingContractMockSignerV1{
		codeByAddress: map[string][]byte{
			strings.ToLower(vcGatewayContract): {0x60},
		},
	}
	scheme := NewExactEvmSchemeV1(signer, &ExactEvmSchemeV1Config{
		VerifyingContractValidator: func(candidate string, r types.PaymentRequirementsV1) bool {
			return candidate == vcGatewayContract
		},
	})

	resp, err := scheme.Verify(context.Background(), payload, requirements, nil)
	if err != nil {
		t.Fatalf("Verify returned error: %v", err)
	}
	if !resp.IsValid {
		t.Fatalf("expected valid, got invalid: %+v", resp)
	}
}

func TestVerifyV1_RejectsVerifyingContractSignatureWhenNoValidatorConfigured(t *testing.T) {
	payload, requirements := signedGatewayPayloadV1(t, vcGatewayContract)

	signer := &verifyingContractMockSignerV1{
		codeByAddress: map[string][]byte{
			strings.ToLower(vcUsdcAsset): {0x60},
		},
	}
	scheme := NewExactEvmSchemeV1(signer, nil)

	resp, err := scheme.Verify(context.Background(), payload, requirements, nil)
	if err == nil {
		t.Fatalf("expected verify error, got success: %+v", resp)
	}
}

func TestSettleV1_SettlesAgainstVerifyingContractNotAsset(t *testing.T) {
	payload, requirements := signedGatewayPayloadV1(t, vcGatewayContract)

	signer := &verifyingContractMockSignerV1{
		codeByAddress: map[string][]byte{
			strings.ToLower(vcGatewayContract): {0x60},
		},
	}
	scheme := NewExactEvmSchemeV1(signer, &ExactEvmSchemeV1Config{
		VerifyingContractValidator: func(candidate string, r types.PaymentRequirementsV1) bool {
			return candidate == vcGatewayContract
		},
	})

	resp, err := scheme.Settle(context.Background(), payload, requirements, nil)
	if err != nil {
		t.Fatalf("Settle returned error: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got failure: %+v", resp)
	}
	if got := evm.NormalizeAddress(signer.writeAddress); got != evm.NormalizeAddress(vcGatewayContract) {
		t.Fatalf("expected WriteContract address = %s, got %s", vcGatewayContract, got)
	}
}
