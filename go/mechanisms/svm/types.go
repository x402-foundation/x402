package svm

import (
	"context"
	"encoding/json"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
)

// ExactSvmPayload represents a SVM (Solana) payment payload
type ExactSvmPayload struct {
	Transaction string `json:"transaction"` // Base64 encoded Solana transaction
}

// ExactSvmPayloadV1 - alias for v1 compatibility
type ExactSvmPayloadV1 = ExactSvmPayload

// ExactSvmPayloadV2 - alias for v2 (currently identical, reserved for future)
type ExactSvmPayloadV2 = ExactSvmPayload

// ClientSvmSigner defines client-side operations
type ClientSvmSigner interface {
	// Address returns the signer's Solana address (base58)
	Address() solana.PublicKey

	// SignTransaction signs a Solana transaction
	SignTransaction(ctx context.Context, tx *solana.Transaction) error
}

// FacilitatorSvmSigner defines facilitator operations for SVM
// Supports multiple signers for load balancing, key rotation, and high availability
// All implementation details (RPC clients, key management) are hidden
type FacilitatorSvmSigner interface {
	// GetAddresses returns all addresses this facilitator can use as fee payers for a network
	// Enables dynamic address selection for load balancing and key rotation
	GetAddresses(ctx context.Context, network string) []solana.PublicKey

	// SignTransaction signs a transaction with the signer matching feePayer
	// Transaction is modified in-place to add the facilitator's signature
	// Returns error if no signer exists for feePayer or signing fails
	SignTransaction(ctx context.Context, tx *solana.Transaction, feePayer solana.PublicKey, network string) error

	// SimulateTransaction simulates a signed transaction to verify it would succeed
	// Returns error if simulation fails
	SimulateTransaction(ctx context.Context, tx *solana.Transaction, network string) error

	// SendTransaction sends a signed transaction to the network
	// Returns transaction signature or error if send fails
	SendTransaction(ctx context.Context, tx *solana.Transaction, network string) (solana.Signature, error)

	// ConfirmTransaction waits for transaction confirmation
	// Returns error if confirmation fails or times out
	ConfirmTransaction(ctx context.Context, signature solana.Signature, network string) error
}

// AssetInfo contains information about a SPL token
type AssetInfo struct {
	Address  string // Mint address
	Symbol   string // Token symbol (e.g., "USDC")
	Decimals int    // Token decimals
}

// NetworkConfig contains network-specific configuration
// See DEFAULT_ASSET.md for guidelines on adding new chains
type NetworkConfig struct {
	Name         string    // Network name
	CAIP2        string    // CAIP-2 identifier
	RPCURL       string    // Default RPC URL
	DefaultAsset AssetInfo // Default stablecoin
}

// ClientConfig contains optional client configuration
type ClientConfig struct {
	RPCURL string // Custom RPC URL
}

// ToMap converts an ExactSvmPayload to a map for JSON marshaling
func (p *ExactSvmPayload) ToMap() map[string]interface{} {
	return map[string]interface{}{
		"transaction": p.Transaction,
	}
}

// PayloadFromMap creates an ExactSvmPayload from a map
func PayloadFromMap(data map[string]interface{}) (*ExactSvmPayload, error) {
	// Try to convert to JSON and back for type safety
	jsonBytes, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal payload data: %w", err)
	}

	var payload ExactSvmPayload
	if err := json.Unmarshal(jsonBytes, &payload); err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}

	if payload.Transaction == "" {
		return nil, fmt.Errorf("missing transaction field in payload")
	}

	return &payload, nil
}

// IsValidNetwork checks if the network is supported for Solana
func IsValidNetwork(network string) bool {
	// Check CAIP-2 format
	if _, ok := NetworkConfigs[network]; ok {
		return true
	}

	// Check V1 format
	if _, ok := V1ToV2NetworkMap[network]; ok {
		return true
	}

	return false
}
