package client

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"time"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
	evmv1 "github.com/x402-foundation/x402/go/mechanisms/evm/v1"
	"github.com/x402-foundation/x402/go/types"
)

// ExactEvmSchemeV1 implements the SchemeNetworkClientV1 interface for EVM exact payments (V1)
type ExactEvmSchemeV1 struct {
	signer evm.ClientEvmSigner
}

// NewExactEvmSchemeV1 creates a new ExactEvmSchemeV1
func NewExactEvmSchemeV1(signer evm.ClientEvmSigner) *ExactEvmSchemeV1 {
	return &ExactEvmSchemeV1{
		signer: signer,
	}
}

// Scheme returns the scheme identifier
func (c *ExactEvmSchemeV1) Scheme() string {
	return evm.SchemeExact
}

// CreatePaymentPayload creates a V1 payment payload for the exact scheme
func (c *ExactEvmSchemeV1) CreatePaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirementsV1,
) (types.PaymentPayloadV1, error) {
	networkStr := requirements.Network

	// Get chain ID from v1 network name
	chainID, err := evmv1.GetEvmChainId(networkStr)
	if err != nil {
		return types.PaymentPayloadV1{}, err
	}

	// Get asset info from v1 network config
	assetInfo, err := evmv1.GetAssetInfo(networkStr, requirements.Asset)
	if err != nil {
		return types.PaymentPayloadV1{}, err
	}

	// V1: Use MaxAmountRequired field
	amountStr := requirements.MaxAmountRequired

	value, ok := new(big.Int).SetString(amountStr, 10)
	if !ok {
		return types.PaymentPayloadV1{}, fmt.Errorf(ErrInvalidAmount+": %s", amountStr)
	}

	// Create nonce
	nonce, err := evm.CreateNonce()
	if err != nil {
		return types.PaymentPayloadV1{}, err
	}

	// V1 specific: validAfter is 10 minutes before now, validBefore is 10 minutes from now
	now := time.Now().Unix()
	validAfter := big.NewInt(now - 600) // 10 minutes before
	timeout := int64(600)               // Default 10 minutes
	if requirements.MaxTimeoutSeconds > 0 {
		timeout = int64(requirements.MaxTimeoutSeconds)
	}
	validBefore := big.NewInt(now + timeout)

	// Extract extra fields for EIP-3009
	tokenName := assetInfo.Name
	tokenVersion := assetInfo.Version
	if requirements.Extra != nil {
		var extraMap map[string]interface{}
		if err := json.Unmarshal(*requirements.Extra, &extraMap); err == nil {
			if name, ok := extraMap["name"].(string); ok {
				tokenName = name
			}
			if ver, ok := extraMap["version"].(string); ok {
				tokenVersion = ver
			}
		}
	}

	// Create authorization
	authorization := evm.ExactEIP3009Authorization{
		From:        c.signer.Address(),
		To:          requirements.PayTo,
		Value:       value.String(),
		ValidAfter:  validAfter.String(),
		ValidBefore: validBefore.String(),
		Nonce:       nonce,
	}

	// Sign the authorization
	signature, err := c.signAuthorization(ctx, authorization, chainID, assetInfo.Address, tokenName, tokenVersion)
	if err != nil {
		return types.PaymentPayloadV1{}, fmt.Errorf(ErrFailedToSignAuthorization+": %w", err)
	}

	// Create EVM payload
	evmPayload := &evm.ExactEIP3009Payload{
		Signature:     evm.BytesToHex(signature),
		Authorization: authorization,
	}

	// Build complete v1 payload (scheme/network at top level)
	return types.PaymentPayloadV1{
		X402Version: 1,
		Scheme:      requirements.Scheme,
		Network:     requirements.Network,
		Payload:     evmPayload.ToMap(),
	}, nil
}

// signAuthorization signs the EIP-3009 authorization using EIP-712
func (c *ExactEvmSchemeV1) signAuthorization(
	ctx context.Context,
	authorization evm.ExactEIP3009Authorization,
	chainID *big.Int,
	verifyingContract string,
	tokenName string,
	tokenVersion string,
) ([]byte, error) {
	// Create EIP-712 domain
	domain := evm.TypedDataDomain{
		Name:              tokenName,
		Version:           tokenVersion,
		ChainID:           chainID,
		VerifyingContract: verifyingContract,
	}

	// Define EIP-712 types
	types := map[string][]evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"TransferWithAuthorization": {
			{Name: "from", Type: "address"},
			{Name: "to", Type: "address"},
			{Name: "value", Type: "uint256"},
			{Name: "validAfter", Type: "uint256"},
			{Name: "validBefore", Type: "uint256"},
			{Name: "nonce", Type: "bytes32"},
		},
	}

	// Parse values for message
	value, _ := new(big.Int).SetString(authorization.Value, 10)
	validAfter, _ := new(big.Int).SetString(authorization.ValidAfter, 10)
	validBefore, _ := new(big.Int).SetString(authorization.ValidBefore, 10)
	nonceBytes, _ := evm.HexToBytes(authorization.Nonce)

	// Create message
	message := map[string]interface{}{
		"from":        authorization.From,
		"to":          authorization.To,
		"value":       value,
		"validAfter":  validAfter,
		"validBefore": validBefore,
		"nonce":       nonceBytes,
	}

	// Sign the typed data
	return c.signer.SignTypedData(ctx, domain, types, "TransferWithAuthorization", message)
}
