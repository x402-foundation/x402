package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	vcGatewayContract = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE"
	vcUsdcAsset       = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
)

// verifyingContractMockSigner is a minimal FacilitatorEvmSigner that reports every address in
// codeByAddress as a deployed contract (empty/absent = EOA), always succeeds ReadContract (so
// transfer simulation passes), and records the WriteContract target address for settle
// assertions. Signature verification for EOA payers goes through the real ecrecover path in
// evm.VerifyUniversalSignature, so tests use a real ECDSA key rather than mocking it out.
type verifyingContractMockSigner struct {
	codeByAddress map[string][]byte
	writeAddress  string
}

func (m *verifyingContractMockSigner) GetAddresses() []string { return []string{"0xFac11"} }

func (m *verifyingContractMockSigner) ReadContract(ctx context.Context, address string, abi []byte, functionName string, args ...interface{}) (interface{}, error) {
	return nil, nil
}

func (m *verifyingContractMockSigner) VerifyTypedData(ctx context.Context, address string, domain evm.TypedDataDomain, types map[string][]evm.TypedDataField, primaryType string, message map[string]interface{}, signature []byte) (bool, error) {
	return false, nil
}

func (m *verifyingContractMockSigner) WriteContract(ctx context.Context, address string, abi []byte, functionName string, dataSuffix []byte, args ...interface{}) (string, error) {
	m.writeAddress = address
	return "0x" + strings.Repeat("ab", 32), nil
}

func (m *verifyingContractMockSigner) SendTransaction(ctx context.Context, to string, data []byte) (string, error) {
	return "0x" + strings.Repeat("cd", 32), nil
}

func (m *verifyingContractMockSigner) WaitForTransactionReceipt(ctx context.Context, txHash string) (*evm.TransactionReceipt, error) {
	return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
}

func (m *verifyingContractMockSigner) GetBalance(ctx context.Context, address string, tokenAddress string) (*big.Int, error) {
	return big.NewInt(1_000_000_000), nil
}

func (m *verifyingContractMockSigner) GetChainID(ctx context.Context) (*big.Int, error) {
	return big.NewInt(8453), nil
}

func (m *verifyingContractMockSigner) GetCode(ctx context.Context, address string) ([]byte, error) {
	return m.codeByAddress[strings.ToLower(address)], nil
}

// signedGatewayPayload builds a real ECDSA-signed EIP-3009 payload + matching requirements,
// signed against the given verifyingContract (not necessarily requirements.Asset).
func signedGatewayPayload(t *testing.T, verifyingContract string) (types.PaymentPayload, types.PaymentRequirements) {
	t.Helper()

	privateKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}
	payer := crypto.PubkeyToAddress(privateKey.PublicKey).Hex()

	now := time.Now().Unix()
	authorization := evm.ExactEIP3009Authorization{
		From:        payer,
		To:          "0x0987654321098765432109876543210987654321",
		Value:       "8000",
		ValidAfter:  fmt.Sprintf("%d", now-60),
		ValidBefore: fmt.Sprintf("%d", now+600),
		Nonce:       "0x" + strings.Repeat("11", 32),
	}

	hash, err := evm.HashEIP3009Authorization(authorization, big.NewInt(8453), verifyingContract, "GatewayWalletBatched", "1")
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

	requirements := types.PaymentRequirements{
		Scheme:            "exact",
		Network:           "eip155:8453",
		Asset:             vcUsdcAsset,
		Amount:            "8000",
		PayTo:             authorization.To,
		MaxTimeoutSeconds: 3600,
		Extra: map[string]interface{}{
			"name":              "GatewayWalletBatched",
			"version":           "1",
			"verifyingContract": vcGatewayContract,
		},
	}

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     evmPayload.ToMap(),
	}

	return payload, requirements
}

func TestVerifyEIP3009_TrustsVerifyingContractWhenValidatorApproves(t *testing.T) {
	payload, requirements := signedGatewayPayload(t, vcGatewayContract)

	signer := &verifyingContractMockSigner{
		codeByAddress: map[string][]byte{
			strings.ToLower(vcGatewayContract): {0x60},
		},
	}
	scheme := NewExactEvmScheme(signer, &ExactEvmSchemeConfig{
		VerifyingContractValidator: func(candidate string, r types.PaymentRequirements) bool {
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

func TestVerifyEIP3009_RejectsVerifyingContractSignatureWhenNoValidatorConfigured(t *testing.T) {
	// Signed against the gateway domain, but the facilitator has no validator configured,
	// so it checks against requirements.Asset -- the digest won't match, ecrecover won't
	// recover to the payer, and the signature is rejected.
	payload, requirements := signedGatewayPayload(t, vcGatewayContract)

	signer := &verifyingContractMockSigner{
		codeByAddress: map[string][]byte{
			strings.ToLower(vcUsdcAsset): {0x60},
		},
	}
	scheme := NewExactEvmScheme(signer, nil)

	resp, err := scheme.Verify(context.Background(), payload, requirements, nil)
	if err == nil {
		t.Fatalf("expected verify error, got success: %+v", resp)
	}
}

func TestSettleEIP3009_SettlesAgainstVerifyingContractNotAsset(t *testing.T) {
	payload, requirements := signedGatewayPayload(t, vcGatewayContract)

	signer := &verifyingContractMockSigner{
		codeByAddress: map[string][]byte{
			strings.ToLower(vcGatewayContract): {0x60},
		},
	}
	scheme := NewExactEvmScheme(signer, &ExactEvmSchemeConfig{
		VerifyingContractValidator: func(candidate string, r types.PaymentRequirements) bool {
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
