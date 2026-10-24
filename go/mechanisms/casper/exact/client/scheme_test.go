package client

import (
	"context"
	"encoding/hex"
	"fmt"
	"math/big"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/casper"

	eip712 "github.com/casper-ecosystem/casper-eip-712/go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/x402-foundation/x402/go/v2/types"
)

type testSigner struct {
	address   string
	publicKey string
}

func (s *testSigner) AccountAddress() string { return s.address }
func (s *testSigner) PublicKey() string      { return s.publicKey }
func (s *testSigner) SignEIP712(digest [32]byte) ([65]byte, error) {
	var sig [65]byte
	copy(sig[:32], digest[:])
	return sig, nil
}

func newTestSigner() *testSigner {
	return &testSigner{
		address:   "01" + "aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788",
		publicKey: "01aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788aabb",
	}
}

func validRequirements() types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:            "exact",
		Network:           casper.CasperTestnetCAIP2,
		Asset:             "aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788",
		Amount:            "1000000",
		PayTo:             "00aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788",
		MaxTimeoutSeconds: 300,
		Extra: map[string]interface{}{
			"name":    "TestToken",
			"version": "1",
		},
	}
}

func TestCreatePaymentPayload_HappyPath(t *testing.T) {
	signer := newTestSigner()
	scheme := NewExactCasperScheme(signer)

	payload, err := scheme.CreatePaymentPayload(context.Background(), validRequirements(), x402.PaymentPayloadContext{})
	require.NoError(t, err)

	assert.Equal(t, 2, payload.X402Version)
	assert.NotNil(t, payload.Payload)
	assert.NotEmpty(t, payload.Payload["signature"])
	assert.NotEmpty(t, payload.Payload["publicKey"])

	auth, ok := payload.Payload["authorization"].(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, signer.AccountAddress(), auth["from"])
	assert.Equal(t, "00aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788", auth["to"])
	assert.Equal(t, "1000000", auth["value"])
	assert.NotEmpty(t, auth["nonce"])

	now := time.Now().Unix()
	validAfterStr, ok := auth["validAfter"].(string)
	require.True(t, ok)
	var validAfter int64
	_, err = fmt.Sscanf(validAfterStr, "%d", &validAfter)
	require.NoError(t, err)
	assert.LessOrEqual(t, validAfter, now)

	validBeforeStr, ok := auth["validBefore"].(string)
	require.True(t, ok)
	var validBefore int64
	_, err = fmt.Sscanf(validBeforeStr, "%d", &validBefore)
	require.NoError(t, err)
	assert.InDelta(t, now+300, validBefore, 5)
}

func TestCreatePaymentPayload_MissingExtraName(t *testing.T) {
	signer := newTestSigner()
	scheme := NewExactCasperScheme(signer)

	req := validRequirements()
	delete(req.Extra, "name")

	_, err := scheme.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	assert.ErrorContains(t, err, ErrMissingTokenName)
}

func TestCreatePaymentPayload_MissingExtraVersion(t *testing.T) {
	signer := newTestSigner()
	scheme := NewExactCasperScheme(signer)

	req := validRequirements()
	delete(req.Extra, "version")

	_, err := scheme.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	assert.ErrorContains(t, err, ErrMissingTokenVersion)
}

func TestCreatePaymentPayload_InvalidAsset(t *testing.T) {
	signer := newTestSigner()
	scheme := NewExactCasperScheme(signer)

	req := validRequirements()
	req.Asset = "not-valid-hex"

	_, err := scheme.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	assert.ErrorContains(t, err, ErrInvalidAsset)
}

func TestCreatePaymentPayload_UnsupportedNetwork(t *testing.T) {
	scheme := NewExactCasperScheme(newTestSigner())

	for _, network := range []string{"eip155:8453", "casper:", "casper-test", ""} {
		t.Run(network, func(t *testing.T) {
			req := validRequirements()
			req.Network = network

			_, err := scheme.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
			assert.ErrorContains(t, err, ErrUnsupportedNetwork)
		})
	}
}

func TestCreatePaymentPayload_AcceptsCustomCasperNetwork(t *testing.T) {
	scheme := NewExactCasperScheme(newTestSigner())
	req := validRequirements()
	req.Network = "casper:custom-chain"

	_, err := scheme.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	require.NoError(t, err)
}

// signedDigest returns the digest testSigner embedded in the payload signature
// and the digest expected for the given EIP-712 domain name and version.
func signedDigest(t *testing.T, payload types.PaymentPayload, req types.PaymentRequirements, name, version string) (got, want []byte) {
	t.Helper()
	sig, err := hex.DecodeString(payload.Payload["signature"].(string))
	require.NoError(t, err)
	auth := payload.Payload["authorization"].(map[string]interface{})

	packageHash, err := casper.DecodeContractPackageHash(req.Asset)
	require.NoError(t, err)
	from, err := eip712.NewAddressFromHex("0x" + auth["from"].(string))
	require.NoError(t, err)
	to, err := eip712.NewAddressFromHex("0x" + auth["to"].(string))
	require.NoError(t, err)
	value, _ := new(big.Int).SetString(auth["value"].(string), 10)
	validAfter, _ := new(big.Int).SetString(auth["validAfter"].(string), 10)
	validBefore, _ := new(big.Int).SetString(auth["validBefore"].(string), 10)
	nonceRaw, err := hex.DecodeString(auth["nonce"].(string))
	require.NoError(t, err)
	var nonce [32]byte
	copy(nonce[:], nonceRaw)

	digest, err := eip712.HashTypedData(
		eip712.BuildDomain(name, version, req.Network, packageHash),
		transferWithAuthorizationTypes,
		"TransferWithAuthorization",
		map[string]interface{}{"from": from, "to": to, "value": value, "validAfter": validAfter, "validBefore": validBefore, "nonce": nonce},
		&eip712.TypedDataOptions{DomainTypes: eip712.CasperDomainTypes},
	)
	require.NoError(t, err)
	return sig[:32], digest[:]
}

func TestCreatePaymentPayload_DefaultAssetDomainFallback(t *testing.T) {
	for name, extra := range map[string]map[string]interface{}{
		"nil extra":          nil,
		"empty name/version": {"name": "", "version": ""},
	} {
		t.Run(name, func(t *testing.T) {
			req := validRequirements()
			req.Asset = casper.CSPRUSDTestnetAsset
			req.Extra = extra

			payload, err := NewExactCasperScheme(newTestSigner()).CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
			require.NoError(t, err)
			got, want := signedDigest(t, payload, req, casper.CSPRUSDName, "1")
			assert.Equal(t, want, got)
		})
	}
}

func TestCreatePaymentPayload_ExplicitDomainOverridesDefaultAsset(t *testing.T) {
	req := validRequirements()
	req.Asset = casper.CSPRUSDTestnetAsset
	req.Extra = map[string]interface{}{"name": "Renamed", "version": "2"}

	payload, err := NewExactCasperScheme(newTestSigner()).CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	require.NoError(t, err)
	got, want := signedDigest(t, payload, req, "Renamed", "2")
	assert.Equal(t, want, got)
}

func TestCreatePaymentPayload_NonceIsRandom(t *testing.T) {
	signer := newTestSigner()
	scheme := NewExactCasperScheme(signer)
	req := validRequirements()

	p1, err := scheme.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	require.NoError(t, err)
	p2, err := scheme.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	require.NoError(t, err)

	auth1 := p1.Payload["authorization"].(map[string]interface{})
	auth2 := p2.Payload["authorization"].(map[string]interface{})
	assert.NotEqual(t, auth1["nonce"], auth2["nonce"])
}

func TestHashStruct_ValidTimestampsBigIntAndUint64Match(t *testing.T) {
	fromAddr, err := eip712.NewAddressFromHex("0x01aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788")
	require.NoError(t, err)
	toAddr, err := eip712.NewAddressFromHex("0x00aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788")
	require.NoError(t, err)

	value := big.NewInt(1000000)
	validAfter := int64(1700000000)
	validBefore := int64(1700001000)

	nonceRaw, err := hex.DecodeString("aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788")
	require.NoError(t, err)
	var nonce [32]byte
	copy(nonce[:], nonceRaw)

	primaryType := "TransferWithAuthorization"
	transferWithAuthorizationType := eip712.TypeDefinitions{
		"TransferWithAuthorization": {
			{Name: "from", Type: "address"},
			{Name: "to", Type: "address"},
			{Name: "value", Type: "uint256"},
			{Name: "validAfter", Type: "uint256"},
			{Name: "validBefore", Type: "uint256"},
			{Name: "nonce", Type: "bytes32"},
		},
	}

	bigIntMessage := map[string]interface{}{
		"from":        fromAddr,
		"to":          toAddr,
		"value":       value,
		"validAfter":  big.NewInt(validAfter),
		"validBefore": big.NewInt(validBefore),
		"nonce":       nonce,
	}
	uint64Message := map[string]interface{}{
		"from":        fromAddr,
		"to":          toAddr,
		"value":       value,
		"validAfter":  uint64(validAfter),
		"validBefore": uint64(validBefore),
		"nonce":       nonce,
	}

	bigIntStructHash, err := eip712.HashStruct(primaryType, transferWithAuthorizationType, bigIntMessage)
	require.NoError(t, err)
	uint64StructHash, err := eip712.HashStruct(primaryType, transferWithAuthorizationType, uint64Message)
	require.NoError(t, err)

	assert.Equal(t, bigIntStructHash, uint64StructHash)
}
