package client

import (
	"context"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

type mockSigner struct {
	address string
	sig     []byte
	err     error

	lastDomain      evm.TypedDataDomain
	lastTypes       map[string][]evm.TypedDataField
	lastPrimaryType string
	lastMessage     map[string]interface{}
}

func (m *mockSigner) Address() string { return m.address }
func (m *mockSigner) SignTypedData(_ context.Context, domain evm.TypedDataDomain, types map[string][]evm.TypedDataField, primaryType string, message map[string]interface{}) ([]byte, error) {
	m.lastDomain = domain
	m.lastTypes = types
	m.lastPrimaryType = primaryType
	m.lastMessage = message
	return m.sig, m.err
}

func mockRequirements(extra map[string]interface{}) types.PaymentRequirements {
	future := time.Now().Unix() + 86400
	baseExtra := map[string]interface{}{
		"captureAuthorizer": "0xcccccccccccccccccccccccccccccccccccccccc",
		"captureDeadline":   float64(future),
		"refundDeadline":    float64(future + 86400),
		"feeRecipient":      "0x4444444444444444444444444444444444444444",
		"minFeeBps":         float64(0),
		"maxFeeBps":         float64(100),
		"name":              "USDC",
		"version":           "2",
	}
	for k, v := range extra {
		baseExtra[k] = v
	}
	return types.PaymentRequirements{
		Scheme:            authcapture.SchemeAuthCapture,
		Network:           "eip155:84532",
		Amount:            "1000000",
		Asset:             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		PayTo:             "0x1234567890123456789012345678901234567890",
		MaxTimeoutSeconds: 3600,
		Extra:             baseExtra,
	}
}

func TestAuthCaptureEvmScheme_Scheme(t *testing.T) {
	scheme := NewAuthCaptureEvmScheme(&mockSigner{address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})
	if scheme.Scheme() != authcapture.SchemeAuthCapture {
		t.Fatalf("scheme = %q", scheme.Scheme())
	}
}

func TestCreatePaymentPayload_InvalidAuthCaptureEscrow(t *testing.T) {
	scheme := NewAuthCaptureEvmScheme(&mockSigner{address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})
	req := mockRequirements(map[string]interface{}{
		"authCaptureEscrow": "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
	})
	if _, err := scheme.CreatePaymentPayload(context.Background(), req); err == nil || !strings.Contains(err.Error(), "authCaptureEscrow") {
		t.Fatalf("expected authCaptureEscrow error, got %v", err)
	}
}

func TestCreatePaymentPayload_V1_0EscrowPin(t *testing.T) {
	signer := &mockSigner{
		address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		sig:     []byte{0xde, 0xad, 0xbe, 0xef},
	}
	scheme := NewAuthCaptureEvmScheme(signer)
	scheme.now = func() time.Time { return time.Unix(1700000000, 0) }

	result, err := scheme.CreatePaymentPayload(context.Background(), mockRequirements(map[string]interface{}{
		"authCaptureEscrow": authcapture.AuthCaptureEscrowV1_0Address,
	}))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	auth := result.Payload["authorization"].(map[string]interface{})
	if auth["to"] != authcapture.EIP3009TokenCollectorV1_0Address {
		t.Fatalf("to = %v, want v1.0 collector", auth["to"])
	}
}

func TestCreatePaymentPayload_EIP3009(t *testing.T) {
	signer := &mockSigner{
		address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		sig:     []byte{0xde, 0xad, 0xbe, 0xef},
	}
	scheme := NewAuthCaptureEvmScheme(signer)
	scheme.now = func() time.Time { return time.Unix(1700000000, 0) }

	result, err := scheme.CreatePaymentPayload(context.Background(), mockRequirements(nil))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if result.X402Version != 2 {
		t.Fatalf("x402Version = %d", result.X402Version)
	}
	if !authcapture.IsEip3009Payload(result.Payload) {
		t.Fatalf("payload = %+v", result.Payload)
	}
	if result.Payload["signature"] != "0xdeadbeef" {
		t.Fatalf("signature = %v", result.Payload["signature"])
	}

	auth := result.Payload["authorization"].(map[string]interface{})
	if auth["from"] != signer.address {
		t.Fatalf("from = %v", auth["from"])
	}
	if auth["to"] != authcapture.EIP3009TokenCollectorAddress {
		t.Fatalf("to = %v", auth["to"])
	}
	if auth["value"] != "1000000" {
		t.Fatalf("value = %v", auth["value"])
	}
	if auth["validBefore"] != "1700003600" {
		t.Fatalf("validBefore = %v", auth["validBefore"])
	}
	if _, ok := result.Payload["saltNonce"]; ok {
		t.Fatal("expected no saltNonce for unbound salt")
	}
	if signer.lastPrimaryType != "ReceiveWithAuthorization" {
		t.Fatalf("primaryType = %q", signer.lastPrimaryType)
	}
	if signer.lastDomain.Name != "USDC" || signer.lastDomain.Version != "2" {
		t.Fatalf("domain = %+v", signer.lastDomain)
	}
	if signer.lastDomain.ChainID.Cmp(big.NewInt(84532)) != 0 {
		t.Fatalf("chainId = %v", signer.lastDomain.ChainID)
	}
	if !strings.EqualFold(signer.lastDomain.VerifyingContract, "0x036CbD53842c5426634e7929541eC2318f3dCF7e") {
		t.Fatalf("verifyingContract = %q", signer.lastDomain.VerifyingContract)
	}
}

func TestCreatePaymentPayload_MissingExtraFields(t *testing.T) {
	scheme := NewAuthCaptureEvmScheme(&mockSigner{address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})

	req := mockRequirements(map[string]interface{}{"name": ""})
	if _, err := scheme.CreatePaymentPayload(context.Background(), req); err == nil || !strings.Contains(err.Error(), "name") {
		t.Fatalf("expected name error, got %v", err)
	}

	req = mockRequirements(map[string]interface{}{"version": ""})
	if _, err := scheme.CreatePaymentPayload(context.Background(), req); err == nil || !strings.Contains(err.Error(), "version") {
		t.Fatalf("expected version error, got %v", err)
	}

	req = mockRequirements(map[string]interface{}{"captureAuthorizer": ""})
	if _, err := scheme.CreatePaymentPayload(context.Background(), req); err == nil || !strings.Contains(err.Error(), "captureAuthorizer") {
		t.Fatalf("expected captureAuthorizer error, got %v", err)
	}

	req = mockRequirements(map[string]interface{}{"feeRecipient": ""})
	if _, err := scheme.CreatePaymentPayload(context.Background(), req); err == nil || !strings.Contains(err.Error(), "feeRecipient") {
		t.Fatalf("expected feeRecipient error, got %v", err)
	}
}

func TestCreatePaymentPayload_BoundSalt(t *testing.T) {
	scheme := NewAuthCaptureEvmScheme(&mockSigner{
		address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		sig:     []byte{0x01},
	})
	result, err := scheme.CreatePaymentPayload(context.Background(), mockRequirements(map[string]interface{}{
		"receiverAuthorizer": "0x1111111111111111111111111111111111111111",
	}))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	saltNonce, ok := result.Payload["saltNonce"].(string)
	if !ok || len(saltNonce) != 66 {
		t.Fatalf("saltNonce = %v", result.Payload["saltNonce"])
	}
	salt, ok := result.Payload["salt"].(string)
	if !ok || len(salt) != 66 {
		t.Fatalf("salt = %v", result.Payload["salt"])
	}
	if salt == saltNonce {
		t.Fatal("expected bound salt to differ from saltNonce")
	}
}

func TestCreatePaymentPayload_FreshUnboundSalt(t *testing.T) {
	scheme := NewAuthCaptureEvmScheme(&mockSigner{
		address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		sig:     []byte{0x01},
	})
	a, err := scheme.CreatePaymentPayload(context.Background(), mockRequirements(nil))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	b, err := scheme.CreatePaymentPayload(context.Background(), mockRequirements(nil))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if a.Payload["salt"] == b.Payload["salt"] {
		t.Fatal("expected fresh salt on each call")
	}
}

func TestCreatePaymentPayload_BadNetwork(t *testing.T) {
	scheme := NewAuthCaptureEvmScheme(&mockSigner{address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})
	req := mockRequirements(nil)
	req.Network = "solana:mainnet"
	if _, err := scheme.CreatePaymentPayload(context.Background(), req); err == nil || !strings.Contains(err.Error(), "solana:mainnet") {
		t.Fatalf("expected network error, got %v", err)
	}
}

func TestCreatePaymentPayload_Permit2(t *testing.T) {
	signer := &mockSigner{
		address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		sig:     []byte{0xde, 0xad, 0xbe, 0xef},
	}
	scheme := NewAuthCaptureEvmScheme(signer)
	result, err := scheme.CreatePaymentPayload(context.Background(), mockRequirements(map[string]interface{}{
		"assetTransferMethod": "permit2",
	}))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !authcapture.IsPermit2Payload(result.Payload) {
		t.Fatalf("payload = %+v", result.Payload)
	}
	auth := result.Payload["permit2Authorization"].(map[string]interface{})
	if auth["spender"] != authcapture.Permit2TokenCollectorAddress {
		t.Fatalf("spender = %v", auth["spender"])
	}
	if _, ok := new(big.Int).SetString(auth["nonce"].(string), 10); !ok {
		t.Fatalf("nonce not decimal uint256 string: %v", auth["nonce"])
	}
	if signer.lastPrimaryType != "PermitTransferFrom" {
		t.Fatalf("primaryType = %q", signer.lastPrimaryType)
	}
	if signer.lastDomain.Name != "Permit2" {
		t.Fatalf("domain name = %q", signer.lastDomain.Name)
	}
	if signer.lastDomain.VerifyingContract != evm.PERMIT2Address {
		t.Fatalf("verifyingContract = %q", signer.lastDomain.VerifyingContract)
	}
}
