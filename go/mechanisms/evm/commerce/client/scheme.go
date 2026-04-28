package client

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"time"

	"github.com/coinbase/x402/go/mechanisms/evm"
	"github.com/coinbase/x402/go/types"
)

// Default expiry durations for commerce payment info
const (
	DefaultPreApprovalExpirySeconds   = 3600      // 1 hour
	DefaultAuthorizationExpirySeconds = 86400     // 24 hours
	DefaultRefundExpirySeconds        = 604800    // 7 days
)

// CommerceEvmScheme implements the SchemeNetworkClient interface for EVM commerce payments
type CommerceEvmScheme struct {
	signer evm.ClientEvmSigner
}

// NewCommerceEvmScheme creates a new CommerceEvmScheme
func NewCommerceEvmScheme(signer evm.ClientEvmSigner) *CommerceEvmScheme {
	return &CommerceEvmScheme{
		signer: signer,
	}
}

// Scheme returns the scheme identifier
func (c *CommerceEvmScheme) Scheme() string {
	return evm.SchemeCommerce
}

// CreatePaymentPayload creates a commerce payment payload.
//
// The commerce scheme uses ReceiveWithAuthorization (not TransferWithAuthorization).
// Funds go to tokenCollector, and a deterministic nonce is derived from payment parameters.
func (c *CommerceEvmScheme) CreatePaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirements,
) (types.PaymentPayload, error) {
	// 1. Extract required fields from requirements.Extra
	escrowAddress, ok := requirements.Extra["escrowAddress"].(string)
	if !ok || escrowAddress == "" {
		return types.PaymentPayload{}, fmt.Errorf(ErrMissingEscrowAddress)
	}
	operatorAddress, ok := requirements.Extra["operatorAddress"].(string)
	if !ok || operatorAddress == "" {
		return types.PaymentPayload{}, fmt.Errorf(ErrMissingOperatorAddress)
	}
	tokenCollector, ok := requirements.Extra["tokenCollector"].(string)
	if !ok || tokenCollector == "" {
		return types.PaymentPayload{}, fmt.Errorf(ErrMissingTokenCollector)
	}
	tokenName, ok := requirements.Extra["name"].(string)
	if !ok || tokenName == "" {
		return types.PaymentPayload{}, fmt.Errorf(ErrMissingTokenName)
	}
	tokenVersion, ok := requirements.Extra["version"].(string)
	if !ok || tokenVersion == "" {
		return types.PaymentPayload{}, fmt.Errorf(ErrMissingTokenVersion)
	}

	// 2. Extract optional fields with defaults
	minFeeBps := uint16(0)
	if v, ok := requirements.Extra["minFeeBps"].(float64); ok {
		minFeeBps = uint16(v)
	}
	maxFeeBps := uint16(0)
	if v, ok := requirements.Extra["maxFeeBps"].(float64); ok {
		maxFeeBps = uint16(v)
	}
	feeReceiver := "0x0000000000000000000000000000000000000000"
	if v, ok := requirements.Extra["feeReceiver"].(string); ok && v != "" {
		feeReceiver = v
	}

	preApprovalExpirySeconds := int64(DefaultPreApprovalExpirySeconds)
	if v, ok := requirements.Extra["preApprovalExpirySeconds"].(float64); ok {
		preApprovalExpirySeconds = int64(v)
	}
	authorizationExpirySeconds := int64(DefaultAuthorizationExpirySeconds)
	if v, ok := requirements.Extra["authorizationExpirySeconds"].(float64); ok {
		authorizationExpirySeconds = int64(v)
	}
	refundExpirySeconds := int64(DefaultRefundExpirySeconds)
	if v, ok := requirements.Extra["refundExpirySeconds"].(float64); ok {
		refundExpirySeconds = int64(v)
	}

	// Get chain ID
	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToGetChainID+": %w", err)
	}

	// Validate amount
	_, ok = new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidAmount+": %s", requirements.Amount)
	}

	// 3. Compute timestamps
	now := time.Now().Unix()
	preApprovalExpiry := uint64(now + preApprovalExpirySeconds)
	authorizationExpiry := uint64(now + authorizationExpirySeconds)
	refundExpiry := uint64(now + refundExpirySeconds)

	// 4. Generate random 32-byte salt
	saltBytes := make([]byte, 32)
	if _, err := rand.Read(saltBytes); err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to generate salt: %w", err)
	}
	salt := "0x" + hex.EncodeToString(saltBytes)

	// 5. Build CommercePaymentInfo
	paymentInfo := evm.CommercePaymentInfo{
		Operator:            operatorAddress,
		Payer:               c.signer.Address(),
		Receiver:            requirements.PayTo,
		Token:               requirements.Asset,
		MaxAmount:           requirements.Amount,
		PreApprovalExpiry:   preApprovalExpiry,
		AuthorizationExpiry: authorizationExpiry,
		RefundExpiry:        refundExpiry,
		MinFeeBps:           minFeeBps,
		MaxFeeBps:           maxFeeBps,
		FeeReceiver:         feeReceiver,
		Salt:                salt,
	}

	// 6. Compute deterministic nonce
	nonce, err := evm.ComputeCommerceNonce(chainID, escrowAddress, paymentInfo)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToComputeNonce+": %w", err)
	}

	// 7. Build authorization
	// validAfter = now - 600 (10 min buffer for clock skew)
	// validBefore = preApprovalExpiry
	validAfter := big.NewInt(now - 600)
	validBefore := big.NewInt(int64(preApprovalExpiry))

	authorization := evm.ExactEIP3009Authorization{
		From:        c.signer.Address(),
		To:          tokenCollector,
		Value:       requirements.Amount,
		ValidAfter:  validAfter.String(),
		ValidBefore: validBefore.String(),
		Nonce:       nonce,
	}

	// 8. Sign EIP-712 ReceiveWithAuthorization
	signature, err := c.signReceiveAuthorization(ctx, authorization, chainID, requirements.Asset, tokenName, tokenVersion)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToSignAuthorization+": %w", err)
	}

	// 9. Build payload
	commercePayload := &evm.CommercePayload{
		Authorization: authorization,
		Signature:     evm.BytesToHex(signature),
		PaymentInfo:   paymentInfo,
	}

	return types.PaymentPayload{
		X402Version: 2,
		Payload:     commercePayload.ToMap(),
	}, nil
}

// signReceiveAuthorization signs the ReceiveWithAuthorization using EIP-712
func (c *CommerceEvmScheme) signReceiveAuthorization(
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

	// Define EIP-712 types for ReceiveWithAuthorization
	types := map[string][]evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"ReceiveWithAuthorization": {
			{Name: "from", Type: "address"},
			{Name: "to", Type: "address"},
			{Name: "value", Type: "uint256"},
			{Name: "validAfter", Type: "uint256"},
			{Name: "validBefore", Type: "uint256"},
			{Name: "nonce", Type: "bytes32"},
		},
	}

	// Parse values for message
	value, ok := new(big.Int).SetString(authorization.Value, 10)
	if !ok {
		return nil, fmt.Errorf("invalid authorization value: %s", authorization.Value)
	}
	validAfter, ok := new(big.Int).SetString(authorization.ValidAfter, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validAfter: %s", authorization.ValidAfter)
	}
	validBefore, ok := new(big.Int).SetString(authorization.ValidBefore, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validBefore: %s", authorization.ValidBefore)
	}
	nonceBytes, err := evm.HexToBytes(authorization.Nonce)
	if err != nil {
		return nil, fmt.Errorf("invalid nonce: %w", err)
	}

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
	return c.signer.SignTypedData(ctx, domain, types, "ReceiveWithAuthorization", message)
}
