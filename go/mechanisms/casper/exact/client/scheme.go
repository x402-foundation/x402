package client

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	eip712 "github.com/casper-ecosystem/casper-eip-712/go"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/casper"
	"github.com/x402-foundation/x402/go/v2/types"
)

var transferWithAuthorizationTypes = eip712.TypeDefinitions{
	"TransferWithAuthorization": {
		{Name: "from", Type: "address"},
		{Name: "to", Type: "address"},
		{Name: "value", Type: "uint256"},
		{Name: "validAfter", Type: "uint256"},
		{Name: "validBefore", Type: "uint256"},
		{Name: "nonce", Type: "bytes32"},
	},
}

// ExactCasperScheme implements the SchemeNetworkClient interface for Casper exact payments (V2)
type ExactCasperScheme struct {
	signer casper.ClientCasperSigner
}

func NewExactCasperScheme(signer casper.ClientCasperSigner) *ExactCasperScheme {
	return &ExactCasperScheme{signer: signer}
}

func (c *ExactCasperScheme) Scheme() string {
	return casper.SchemeExact
}

func (c *ExactCasperScheme) FindDefaultAsset(asset string, network x402.Network) *x402.DefaultAsset {
	info := casper.FindDefaultAsset(asset, string(network))
	if info == nil {
		return nil
	}
	return &x402.DefaultAsset{Asset: info.Asset, Decimals: info.Decimals, Symbol: info.Symbol}
}

// CreatePaymentPayload creates a V2 payment payload for the Exact scheme
func (c *ExactCasperScheme) CreatePaymentPayload(
	_ context.Context,
	requirements types.PaymentRequirements,
	_ x402.PaymentPayloadContext,
) (types.PaymentPayload, error) {

	network := string(requirements.Network)
	if !strings.HasPrefix(network, "casper:") || casper.ChainNameFromNetwork(network) == "" {
		return types.PaymentPayload{}, fmt.Errorf("%s: %s", ErrUnsupportedNetwork, network)
	}
	if !casper.IsValidContractPackageHash(requirements.Asset) {
		return types.PaymentPayload{}, fmt.Errorf("%s: %s", ErrInvalidAsset, requirements.Asset)
	}
	contractPackageHash, err := casper.DecodeContractPackageHash(requirements.Asset)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("%s: %w", ErrInvalidAsset, err)
	}

	// The EIP-712 domain comes from requirements.extra, falling back to the
	// registered metadata of a default asset.
	name, _ := requirements.Extra["name"].(string)
	version, _ := requirements.Extra["version"].(string)
	if defaultAsset := casper.FindDefaultAsset(requirements.Asset, network); defaultAsset != nil {
		if name == "" {
			name = defaultAsset.Name
		}
		if version == "" {
			version = defaultAsset.Version
		}
	}
	if name == "" {
		return types.PaymentPayload{}, errors.New(ErrMissingTokenName)
	}
	if version == "" {
		return types.PaymentPayload{}, errors.New(ErrMissingTokenVersion)
	}

	domain := eip712.BuildDomain(name, version, requirements.Network, contractPackageHash)

	now := time.Now().Unix()
	validAfter := now - 600
	validBefore := now + int64(requirements.MaxTimeoutSeconds)

	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to generate nonce: %w", err)
	}

	fromAddr, err := eip712.NewAddressFromHex("0x" + c.signer.AccountAddress())
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to parse from address: %w", err)
	}
	toAddr, err := eip712.NewAddressFromHex("0x" + requirements.PayTo)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to parse to address: %w", err)
	}
	value, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return types.PaymentPayload{}, fmt.Errorf("invalid amount: %s", requirements.Amount)
	}

	message := map[string]interface{}{
		"from":        fromAddr,
		"to":          toAddr,
		"value":       value,
		"validAfter":  big.NewInt(validAfter),
		"validBefore": big.NewInt(validBefore),
		"nonce":       nonce,
	}

	digest, err := eip712.HashTypedData(
		domain,
		transferWithAuthorizationTypes,
		"TransferWithAuthorization",
		message,
		&eip712.TypedDataOptions{DomainTypes: eip712.CasperDomainTypes},
	)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("%s: %w", ErrFailedToHash, err)
	}

	sig, err := c.signer.SignEIP712(digest)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("%s: %w", ErrFailedToSign, err)
	}

	payload := &casper.ExactCasperPayload{
		Signature: hex.EncodeToString(sig[:]),
		PublicKey: c.signer.PublicKey(),
		Authorization: casper.ExactCasperAuthorization{
			From:        c.signer.AccountAddress(),
			To:          requirements.PayTo,
			Value:       requirements.Amount,
			ValidAfter:  fmt.Sprintf("%d", validAfter),
			ValidBefore: fmt.Sprintf("%d", validBefore),
			Nonce:       hex.EncodeToString(nonce[:]),
		},
	}

	return types.PaymentPayload{X402Version: 2, Payload: payload.ToMap()}, nil
}
