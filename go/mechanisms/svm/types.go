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

// UptoSvmPayload is the SVM `upto` payment payload: the client-signed channel
// `open` plus the channel facts the facilitator rebinds it against.
type UptoSvmPayload struct {
	// From is the payer wallet (base58).
	From string `json:"from"`
	// MaxAmount is the signed ceiling in base units; equals the verification-phase amount.
	MaxAmount string `json:"maxAmount"`
	// ExpiresAt is the nonzero voucher deadline (Unix seconds).
	ExpiresAt int64 `json:"expiresAt"`
	// ValidAfter is the activation time (Unix seconds).
	ValidAfter int64 `json:"validAfter"`
	// Nonce is the decimal u64 salt encoded in the open instruction.
	Nonce string `json:"nonce"`
	// OpenSlot is the decimal u64 slot encoded in the open instruction and used as a PDA seed.
	OpenSlot string `json:"openSlot"`
	// ChannelId is the channel PDA (base58).
	ChannelId string `json:"channelId"`
	// Deposit is the onchain escrow amount; equals MaxAmount.
	Deposit string `json:"deposit"`
	// AuthorizedSigner is the voucher signer; equals extra.receiverAuthorizer.
	AuthorizedSigner string `json:"authorizedSigner"`
	// OpenTransaction is the base64 payer-signed open transaction.
	OpenTransaction string `json:"openTransaction"`
	// VoucherSignature is the base58 Ed25519 voucher signature by AuthorizedSigner.
	// Claim-only and server-owned: verify and deposit settle reject any client-supplied value.
	VoucherSignature string `json:"voucherSignature,omitempty"`
}

// UptoVoucherSignatureField is the payload key carrying the settle-time voucher.
const UptoVoucherSignatureField = "voucherSignature"

// ToMap converts an UptoSvmPayload to a map for JSON marshaling.
func (p *UptoSvmPayload) ToMap() map[string]interface{} {
	out := map[string]interface{}{
		"from":             p.From,
		"maxAmount":        p.MaxAmount,
		"expiresAt":        p.ExpiresAt,
		"validAfter":       p.ValidAfter,
		"nonce":            p.Nonce,
		"openSlot":         p.OpenSlot,
		"channelId":        p.ChannelId,
		"deposit":          p.Deposit,
		"authorizedSigner": p.AuthorizedSigner,
		"openTransaction":  p.OpenTransaction,
	}
	if p.VoucherSignature != "" {
		out[UptoVoucherSignatureField] = p.VoucherSignature
	}
	return out
}

// UptoPayloadFromMap decodes an UptoSvmPayload and validates that every
// required field is present with the expected type.
func UptoPayloadFromMap(data map[string]interface{}) (*UptoSvmPayload, error) {
	jsonBytes, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal payload data: %w", err)
	}

	var payload UptoSvmPayload
	if err := json.Unmarshal(jsonBytes, &payload); err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}

	required := map[string]string{
		"from":             payload.From,
		"maxAmount":        payload.MaxAmount,
		"nonce":            payload.Nonce,
		"openSlot":         payload.OpenSlot,
		"channelId":        payload.ChannelId,
		"deposit":          payload.Deposit,
		"authorizedSigner": payload.AuthorizedSigner,
		"openTransaction":  payload.OpenTransaction,
	}
	for field, value := range required {
		if value == "" {
			return nil, fmt.Errorf("missing %s field in payload", field)
		}
	}

	return &payload, nil
}

// IsUptoSvmPayload reports whether a payload map has the shape of an SVM
// `upto` payload, so callers can skip payloads belonging to another mechanism
// before attempting a strict decode.
func IsUptoSvmPayload(payload map[string]interface{}) bool {
	stringFields := []string{
		"from", "maxAmount", "deposit", "channelId",
		"authorizedSigner", "openTransaction", "openSlot", "nonce",
	}
	for _, field := range stringFields {
		value, ok := payload[field].(string)
		if !ok || value == "" {
			return false
		}
	}
	return true
}

// HasUptoVoucherSignature reports whether the payload carries the voucher key
// at all. Presence — not emptiness — distinguishes a claim settle from a
// deposit settle, so an empty client-supplied value is still a rejection.
func HasUptoVoucherSignature(payload map[string]interface{}) bool {
	_, present := payload[UptoVoucherSignatureField]
	return present
}

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

// ReceiverAuthorizerSigner is the server-controlled hot key advertised as
// `extra.receiverAuthorizer`. It signs settlement vouchers as raw Ed25519
// messages and never signs a transaction, so it needs no SOL or token balance.
type ReceiverAuthorizerSigner interface {
	// Address returns the authorizer's Solana address (base58)
	Address() solana.PublicKey

	// SignMessage signs raw message bytes and returns the 64-byte Ed25519 signature
	SignMessage(ctx context.Context, message []byte) ([]byte, error)
}

// AssetInfo contains information about a SPL token
type AssetInfo struct {
	Address  string // Mint address
	Symbol   string // Token symbol (e.g., "USDC")
	Decimals int    // Token decimals
}

// NetworkConfig contains network-specific configuration
// See DEFAULT_ASSETS.md for guidelines on adding new chains
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

// ServerConfig contains optional server configuration.
type ServerConfig struct {
	RPCURL string // Custom RPC URL for challenge enrichment
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
