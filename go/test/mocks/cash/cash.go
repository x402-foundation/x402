package cash

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/types"
)

// ============================================================================
// Cash Scheme Network Client
// ============================================================================

// SchemeNetworkClient implements the client side of the cash payment scheme
type SchemeNetworkClient struct {
	payer string
}

// NewSchemeNetworkClient creates a new cash scheme client
func NewSchemeNetworkClient(payer string) *SchemeNetworkClient {
	return &SchemeNetworkClient{
		payer: payer,
	}
}

// Scheme returns the payment scheme identifier
func (c *SchemeNetworkClient) Scheme() string {
	return "cash"
}

// CreatePaymentPayload creates a V2 payment payload for the cash scheme
func (c *SchemeNetworkClient) CreatePaymentPayload(ctx context.Context, requirements types.PaymentRequirements) (types.PaymentPayload, error) {
	validUntil := time.Now().Add(time.Duration(requirements.MaxTimeoutSeconds) * time.Second).Unix()

	return types.PaymentPayload{
		X402Version: 2,
		Payload: map[string]interface{}{
			"signature":  fmt.Sprintf("~%s", c.payer),
			"validUntil": strconv.FormatInt(validUntil, 10),
			"name":       c.payer,
		},
	}, nil
}

// ============================================================================
// Cash Scheme Network Facilitator
// ============================================================================

// SchemeNetworkFacilitator implements the facilitator side of the cash payment scheme
type SchemeNetworkFacilitator struct{}

// NewSchemeNetworkFacilitator creates a new cash scheme facilitator
func NewSchemeNetworkFacilitator() *SchemeNetworkFacilitator {
	return &SchemeNetworkFacilitator{}
}

// Scheme returns the payment scheme identifier
func (f *SchemeNetworkFacilitator) Scheme() string {
	return "cash"
}

// CaipFamily returns the CAIP family pattern
func (f *SchemeNetworkFacilitator) CaipFamily() string {
	return "x402:*"
}

// GetExtra returns mechanism-specific extra data for the supported kinds endpoint.
// For the mock cash scheme, return nil.
func (f *SchemeNetworkFacilitator) GetExtra(_ x402.Network) map[string]interface{} {
	return nil
}

// GetSigners returns signer addresses
func (f *SchemeNetworkFacilitator) GetSigners(_ x402.Network) []string {
	return []string{}
}

// Verify verifies a V2 payment payload against requirements (typed)
func (f *SchemeNetworkFacilitator) Verify(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, _ *x402.FacilitatorContext) (*x402.VerifyResponse, error) {
	// Extract payload fields
	signature, ok := payload.Payload["signature"].(string)
	if !ok {
		return nil, x402.NewVerifyError("missing_signature", "", "missing signature")
	}

	name, ok := payload.Payload["name"].(string)
	if !ok {
		return nil, x402.NewVerifyError("missing_name", "", "missing name")
	}

	validUntilStr, ok := payload.Payload["validUntil"].(string)
	if !ok {
		return nil, x402.NewVerifyError("missing_validUntil", "", "missing validUntil")
	}

	// Check signature
	expectedSig := fmt.Sprintf("~%s", name)
	if signature != expectedSig {
		return nil, x402.NewVerifyError("invalid_signature", signature, fmt.Sprintf("invalid signature: %s != %s", signature, expectedSig))
	}

	// Check expiration
	validUntil, err := strconv.ParseInt(validUntilStr, 10, 64)
	if err != nil {
		return nil, x402.NewVerifyError("invalid_validUntil", signature, fmt.Sprintf("invalid validUntil: %s", validUntilStr))
	}

	if validUntil < time.Now().Unix() {
		return nil, x402.NewVerifyError("expired_signature", signature, fmt.Sprintf("expired signature: %d < %d", validUntil, time.Now().Unix()))
	}

	return &x402.VerifyResponse{
		IsValid: true,
		Payer:   signature,
	}, nil
}

// Settle settles a V2 payment (typed)
func (f *SchemeNetworkFacilitator) Settle(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, fctx *x402.FacilitatorContext) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)

	// First verify the payment
	verifyResponse, err := f.Verify(ctx, payload, requirements, fctx)
	if err != nil {
		// Convert VerifyError to SettleError
		var ve *x402.VerifyError
		if errors.As(err, &ve) {
			return nil, x402.NewSettleError(ve.InvalidReason, ve.Payer, network, "", ve.InvalidMessage)
		}
		return nil, x402.NewSettleError("verification_failed", "", network, "", err.Error())
	}

	// Extract name for transaction message
	name, _ := payload.Payload["name"].(string)

	return &x402.SettleResponse{
		Success:     true,
		Transaction: fmt.Sprintf("%s transferred %s %s to %s", name, requirements.Amount, requirements.Asset, requirements.PayTo),
		Network:     network,
		Payer:       verifyResponse.Payer,
	}, nil
}

// ============================================================================
// Cash Scheme Network Server
// ============================================================================

// SchemeNetworkServer implements the server side of the cash payment scheme
type SchemeNetworkServer struct{}

// NewSchemeNetworkServer creates a new cash scheme server
func NewSchemeNetworkServer() *SchemeNetworkServer {
	return &SchemeNetworkServer{}
}

// Scheme returns the payment scheme identifier
func (s *SchemeNetworkServer) Scheme() string {
	return "cash"
}

// ParsePrice parses a price into asset amount format
func (s *SchemeNetworkServer) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
	// Handle pre-parsed price object
	if assetAmount, ok := price.(x402.AssetAmount); ok {
		return assetAmount, nil
	}

	// Handle map format
	if priceMap, ok := price.(map[string]interface{}); ok {
		amount, _ := priceMap["amount"].(string)
		asset, _ := priceMap["asset"].(string)
		if asset == "" {
			asset = "USD"
		}
		return x402.AssetAmount{
			Amount: amount,
			Asset:  asset,
			Extra:  nil,
		}, nil
	}

	// Parse string prices like "$10" or "10 USD"
	if priceStr, ok := price.(string); ok {
		// Remove dollar sign and USD suffix
		cleanPrice := strings.TrimPrefix(priceStr, "$")
		cleanPrice = strings.TrimSuffix(cleanPrice, " USD")
		cleanPrice = strings.TrimSuffix(cleanPrice, "USD")
		cleanPrice = strings.TrimSpace(cleanPrice)

		return x402.AssetAmount{
			Amount: cleanPrice,
			Asset:  "USD",
			Extra:  nil,
		}, nil
	}

	// Handle number input
	if priceNum, ok := price.(float64); ok {
		return x402.AssetAmount{
			Amount: fmt.Sprintf("%.2f", priceNum),
			Asset:  "USD",
			Extra:  nil,
		}, nil
	}

	if priceInt, ok := price.(int); ok {
		return x402.AssetAmount{
			Amount: strconv.Itoa(priceInt),
			Asset:  "USD",
			Extra:  nil,
		}, nil
	}

	return x402.AssetAmount{}, fmt.Errorf("invalid price format: %v", price)
}

// EnhancePaymentRequirements enhances payment requirements with cash-specific details
func (s *SchemeNetworkServer) EnhancePaymentRequirements(
	ctx context.Context,
	requirements types.PaymentRequirements,
	supportedKind types.SupportedKind,
	facilitatorExtensions []string,
) (types.PaymentRequirements, error) {
	// Cash scheme doesn't need any special enhancements
	return requirements, nil
}

// ============================================================================
// Cash Facilitator Client
// ============================================================================

// FacilitatorClient wraps a facilitator for the cash scheme
type FacilitatorClient struct {
	facilitator *x402.X402Facilitator
}

// NewFacilitatorClient creates a new cash facilitator client
func NewFacilitatorClient(facilitator *x402.X402Facilitator) *FacilitatorClient {
	return &FacilitatorClient{
		facilitator: facilitator,
	}
}

// Verify verifies a payment payload against requirements
func (c *FacilitatorClient) Verify(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
	// Pass bytes directly to facilitator (it will unmarshal internally)
	return c.facilitator.Verify(ctx, payloadBytes, requirementsBytes)
}

// Settle settles a payment based on the payload and requirements
func (c *FacilitatorClient) Settle(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
	// Pass bytes directly to facilitator (it will unmarshal internally)
	return c.facilitator.Settle(ctx, payloadBytes, requirementsBytes)
}

// GetSupported gets supported payment kinds and extensions
func (c *FacilitatorClient) GetSupported(ctx context.Context) (x402.SupportedResponse, error) {
	return x402.SupportedResponse{
		Kinds: []x402.SupportedKind{
			{
				X402Version: 2,
				Scheme:      "cash",
				Network:     "x402:cash",
				Extra:       nil,
			},
		},
		Extensions: []string{},
		Signers:    make(map[string][]string),
	}, nil
}

// Identifier returns the identifier for this facilitator client
func (c *FacilitatorClient) Identifier() string {
	return "cash-facilitator"
}

// ============================================================================
// Helper Functions
// ============================================================================

// BuildPaymentRequirements creates a payment requirements object for the cash scheme
func BuildPaymentRequirements(payTo string, asset string, amount string) types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:            "cash",
		Network:           "x402:cash",
		Asset:             asset,
		Amount:            amount,
		PayTo:             payTo,
		MaxTimeoutSeconds: 1000,
		Extra:             nil,
	}
}
