package evm

import (
	"context"
	"fmt"
	"math/big"

	goethtypes "github.com/ethereum/go-ethereum/core/types"
)

// ExactEIP3009Authorization represents the EIP-3009 TransferWithAuthorization data
type ExactEIP3009Authorization struct {
	From        string `json:"from"`        // Ethereum address (hex)
	To          string `json:"to"`          // Ethereum address (hex)
	Value       string `json:"value"`       // Amount in wei as string
	ValidAfter  string `json:"validAfter"`  // Unix timestamp as string
	ValidBefore string `json:"validBefore"` // Unix timestamp as string
	Nonce       string `json:"nonce"`       // 32-byte nonce as hex string
}

// ExactEIP3009Payload represents the exact payment payload for EVM networks
type ExactEIP3009Payload struct {
	Signature     string                    `json:"signature,omitempty"`
	Authorization ExactEIP3009Authorization `json:"authorization"`
}

// ExactEvmPayloadV1 is an alias for ExactEIP3009Payload (v1 compatibility)
type ExactEvmPayloadV1 = ExactEIP3009Payload

// ExactEvmPayloadV2 is an alias for ExactEIP3009Payload (v2 compatibility)
// Note: V2 also supports ExactPermit2Payload - use IsPermit2Payload() to check
type ExactEvmPayloadV2 = ExactEIP3009Payload

// AssetTransferMethod defines how assets are transferred on EVM chains.
// The choice affects which on-chain mechanism is used for token transfers:
//   - eip3009: Uses transferWithAuthorization (USDC, etc.) - recommended for compatible tokens
//   - permit2: Uses Permit2 + x402Permit2Proxy - universal fallback for any ERC-20
type AssetTransferMethod string

const (
	// AssetTransferMethodEIP3009 uses EIP-3009 transferWithAuthorization
	AssetTransferMethodEIP3009 AssetTransferMethod = "eip3009"
	// AssetTransferMethodPermit2 uses Permit2 + x402Permit2Proxy
	AssetTransferMethodPermit2 AssetTransferMethod = "permit2"
)

// Permit2TokenPermissions represents the permitted token and amount for Permit2.
// This is part of the PermitWitnessTransferFrom message structure that gets signed.
type Permit2TokenPermissions struct {
	Token  string `json:"token"`  // Token contract address (hex, e.g., "0x036CbD53842c5426634e7929541eC2318f3dCF7e")
	Amount string `json:"amount"` // Amount in smallest unit as decimal string (e.g., "1000000" for 1 USDC)
}

// Permit2Witness represents the witness data structure for x402Permit2Proxy.
// The witness is included in the EIP-712 signature and verified on-chain by the proxy.
// Note: Upper time bound is enforced by Permit2's `deadline` field, not a witness field.
type Permit2Witness struct {
	To         string `json:"to"`         // Destination address for funds (hex)
	ValidAfter string `json:"validAfter"` // Unix timestamp (decimal string) - payment invalid before this time
}

// Permit2Authorization represents the Permit2 authorization parameters.
// This maps to the PermitWitnessTransferFrom struct used by the Permit2 contract.
type Permit2Authorization struct {
	From      string                  `json:"from"`      // Signer/owner address (hex)
	Permitted Permit2TokenPermissions `json:"permitted"` // Token and amount permitted
	Spender   string                  `json:"spender"`   // Must be x402Permit2Proxy address
	Nonce     string                  `json:"nonce"`     // uint256 nonce as decimal string (unique per signature)
	Deadline  string                  `json:"deadline"`  // Unix timestamp as decimal string - signature expires after this
	Witness   Permit2Witness          `json:"witness"`   // Witness data verified by x402Permit2Proxy
}

// ExactPermit2Payload represents the Permit2 payment payload sent by clients.
// This is the complete payment data including the EIP-712 signature.
type ExactPermit2Payload struct {
	Signature            string               `json:"signature"`            // EIP-712 signature (hex, 65 bytes for EOA)
	Permit2Authorization Permit2Authorization `json:"permit2Authorization"` // Authorization parameters that were signed
}

// ToMap converts an ExactPermit2Payload to a map for JSON marshaling.
func (p *ExactPermit2Payload) ToMap() map[string]interface{} {
	return map[string]interface{}{
		"signature": p.Signature,
		"permit2Authorization": map[string]interface{}{
			"from": p.Permit2Authorization.From,
			"permitted": map[string]interface{}{
				"token":  p.Permit2Authorization.Permitted.Token,
				"amount": p.Permit2Authorization.Permitted.Amount,
			},
			"spender":  p.Permit2Authorization.Spender,
			"nonce":    p.Permit2Authorization.Nonce,
			"deadline": p.Permit2Authorization.Deadline,
			"witness": map[string]interface{}{
				"to":         p.Permit2Authorization.Witness.To,
				"validAfter": p.Permit2Authorization.Witness.ValidAfter,
			},
		},
	}
}

// Permit2PayloadFromMap creates an ExactPermit2Payload from a map.
// Returns an error if required fields are missing or malformed.
func Permit2PayloadFromMap(data map[string]interface{}) (*ExactPermit2Payload, error) {
	payload := &ExactPermit2Payload{}

	if sig, ok := data["signature"].(string); ok {
		payload.Signature = sig
	}

	auth, ok := data["permit2Authorization"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid permit2Authorization field")
	}

	if from, ok := auth["from"].(string); ok {
		payload.Permit2Authorization.From = from
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.from field")
	}

	if spender, ok := auth["spender"].(string); ok {
		payload.Permit2Authorization.Spender = spender
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.spender field")
	}

	if nonce, ok := auth["nonce"].(string); ok {
		payload.Permit2Authorization.Nonce = nonce
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.nonce field")
	}

	if deadline, ok := auth["deadline"].(string); ok {
		payload.Permit2Authorization.Deadline = deadline
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.deadline field")
	}

	permitted, ok := auth["permitted"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.permitted field")
	}

	if token, ok := permitted["token"].(string); ok {
		payload.Permit2Authorization.Permitted.Token = token
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.permitted.token field")
	}

	if amount, ok := permitted["amount"].(string); ok {
		payload.Permit2Authorization.Permitted.Amount = amount
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.permitted.amount field")
	}

	witness, ok := auth["witness"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.witness field")
	}

	if to, ok := witness["to"].(string); ok {
		payload.Permit2Authorization.Witness.To = to
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.witness.to field")
	}

	if validAfter, ok := witness["validAfter"].(string); ok {
		payload.Permit2Authorization.Witness.ValidAfter = validAfter
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.witness.validAfter field")
	}

	return payload, nil
}

// IsPermit2Payload checks if a payload map is a Permit2 payload.
func IsPermit2Payload(data map[string]interface{}) bool {
	_, ok := data["permit2Authorization"]
	return ok
}

// IsEIP3009Payload checks if a payload map is an EIP-3009 payload.
func IsEIP3009Payload(data map[string]interface{}) bool {
	_, ok := data["authorization"]
	return ok
}

// ClientEvmSignerWithTxSigning extends ClientEvmSigner with raw transaction signing capabilities.
// Required for the ERC-20 approval gas sponsoring extension, where the client signs
// (but does not broadcast) an approve(Permit2, MaxUint256) transaction.
type ClientEvmSignerWithTxSigning interface {
	ClientEvmSignerWithSignTransaction
	ClientEvmSignerWithGetTransactionCount
	ClientEvmSignerWithEstimateFeesPerGas
}

// ClientEvmSignerWithSignTransaction extends ClientEvmSigner with raw tx signing.
type ClientEvmSignerWithSignTransaction interface {
	ClientEvmSigner

	// SignTransaction signs an EIP-1559 transaction and returns the RLP-encoded bytes.
	SignTransaction(ctx context.Context, tx *goethtypes.Transaction) ([]byte, error)
}

// ClientEvmSignerWithGetTransactionCount extends ClientEvmSigner with nonce lookup.
type ClientEvmSignerWithGetTransactionCount interface {
	ClientEvmSigner

	// GetTransactionCount returns the pending nonce for an address.
	GetTransactionCount(ctx context.Context, address string) (uint64, error)
}

// ClientEvmSignerWithEstimateFeesPerGas extends ClientEvmSigner with fee estimation.
type ClientEvmSignerWithEstimateFeesPerGas interface {
	ClientEvmSigner

	// EstimateFeesPerGas returns the EIP-1559 maxFeePerGas and maxPriorityFeePerGas.
	EstimateFeesPerGas(ctx context.Context) (maxFeePerGas, maxPriorityFeePerGas *big.Int, err error)
}

// ClientEvmSignerWithReadContract extends ClientEvmSigner with on-chain read capability.
// Used by extension enrichment paths (EIP-2612 nonce lookup, allowance checks).
type ClientEvmSignerWithReadContract interface {
	ClientEvmSigner

	// ReadContract reads data from a smart contract.
	ReadContract(ctx context.Context, address string, abi []byte, functionName string, args ...interface{}) (interface{}, error)
}

// ClientEvmSigner defines the minimal interface for client-side EVM signing operations.
//
// Base payment signing only requires address + typed-data signing.
// Optional extension flows can use additional capability interfaces like
// ClientEvmSignerWithReadContract and ClientEvmSignerWithTxSigning.
type ClientEvmSigner interface {
	// Address returns the signer's Ethereum address
	Address() string

	// SignTypedData signs EIP-712 typed data
	SignTypedData(ctx context.Context, domain TypedDataDomain, types map[string][]TypedDataField, primaryType string, message map[string]interface{}) ([]byte, error)
}

// FacilitatorEvmSigner defines the interface for facilitator EVM operations
// Supports multiple addresses for load balancing, key rotation, and high availability
type FacilitatorEvmSigner interface {
	// GetAddresses returns all addresses this facilitator can use for signing
	// Enables dynamic address selection for load balancing and key rotation
	GetAddresses() []string

	// ReadContract reads data from a smart contract
	ReadContract(ctx context.Context, address string, abi []byte, functionName string, args ...interface{}) (interface{}, error)

	// VerifyTypedData verifies an EIP-712 signature
	VerifyTypedData(ctx context.Context, address string, domain TypedDataDomain, types map[string][]TypedDataField, primaryType string, message map[string]interface{}, signature []byte) (bool, error)

	// WriteContract executes a smart contract transaction
	WriteContract(ctx context.Context, address string, abi []byte, functionName string, args ...interface{}) (string, error)

	// SendTransaction sends a raw transaction with arbitrary calldata
	// Used for smart wallet deployment where calldata is pre-encoded
	SendTransaction(ctx context.Context, to string, data []byte) (string, error)

	// WaitForTransactionReceipt waits for a transaction to be mined
	WaitForTransactionReceipt(ctx context.Context, txHash string) (*TransactionReceipt, error)

	// GetBalance gets the balance of an address for a specific token
	GetBalance(ctx context.Context, address string, tokenAddress string) (*big.Int, error)

	// GetChainID returns the chain ID of the connected network
	GetChainID(ctx context.Context) (*big.Int, error)

	// GetCode returns the bytecode at the given address
	// Returns empty slice if address is an EOA or doesn't exist
	GetCode(ctx context.Context, address string) ([]byte, error)
}

// TypedDataDomain represents the EIP-712 domain separator
type TypedDataDomain struct {
	Name              string   `json:"name"`
	Version           string   `json:"version"`
	ChainID           *big.Int `json:"chainId"`
	VerifyingContract string   `json:"verifyingContract"`
}

// TypedDataField represents a field in EIP-712 typed data
type TypedDataField struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// TransactionReceipt represents the receipt of a mined transaction
type TransactionReceipt struct {
	Status      uint64 `json:"status"`
	BlockNumber uint64 `json:"blockNumber"`
	TxHash      string `json:"transactionHash"`
}

// AssetInfo contains information about an ERC20 token
type AssetInfo struct {
	Address             string
	Name                string
	Version             string
	Decimals            int
	AssetTransferMethod AssetTransferMethod
	SupportsEip2612     bool
}

// NetworkConfig contains network-specific configuration
// See DEFAULT_ASSET.md for guidelines on adding new chains
type NetworkConfig struct {
	ChainID      *big.Int
	DefaultAsset AssetInfo
}

// PayloadToMap converts an ExactEIP3009Payload to a map for JSON marshaling
func (p *ExactEIP3009Payload) ToMap() map[string]interface{} {
	result := map[string]interface{}{
		"authorization": map[string]interface{}{
			"from":        p.Authorization.From,
			"to":          p.Authorization.To,
			"value":       p.Authorization.Value,
			"validAfter":  p.Authorization.ValidAfter,
			"validBefore": p.Authorization.ValidBefore,
			"nonce":       p.Authorization.Nonce,
		},
	}
	if p.Signature != "" {
		result["signature"] = p.Signature
	}
	return result
}

// PayloadFromMap creates an ExactEIP3009Payload from a map
func PayloadFromMap(data map[string]interface{}) (*ExactEIP3009Payload, error) {
	payload := &ExactEIP3009Payload{}

	if sig, ok := data["signature"].(string); ok {
		payload.Signature = sig
	}

	if auth, ok := data["authorization"].(map[string]interface{}); ok {
		if from, ok := auth["from"].(string); ok {
			payload.Authorization.From = from
		}
		if to, ok := auth["to"].(string); ok {
			payload.Authorization.To = to
		}
		if value, ok := auth["value"].(string); ok {
			payload.Authorization.Value = value
		}
		if validAfter, ok := auth["validAfter"].(string); ok {
			payload.Authorization.ValidAfter = validAfter
		}
		if validBefore, ok := auth["validBefore"].(string); ok {
			payload.Authorization.ValidBefore = validBefore
		}
		if nonce, ok := auth["nonce"].(string); ok {
			payload.Authorization.Nonce = nonce
		}
	}

	return payload, nil
}

// UptoPermit2Witness represents the witness data for x402UptoPermit2Proxy.
// Differs from Permit2Witness by including a Facilitator address field.
// Only the address matching Facilitator can call settle() on-chain.
type UptoPermit2Witness struct {
	To          string `json:"to"`          // Destination address for funds (hex)
	Facilitator string `json:"facilitator"` // Facilitator address authorized to settle (hex)
	ValidAfter  string `json:"validAfter"`  // Unix timestamp (decimal string)
}

// UptoPermit2Authorization represents the Permit2 authorization parameters for the upto scheme.
type UptoPermit2Authorization struct {
	From      string                  `json:"from"`      // Signer/owner address (hex)
	Permitted Permit2TokenPermissions `json:"permitted"` // Token and amount permitted (max charge)
	Spender   string                  `json:"spender"`   // Must be x402UptoPermit2Proxy address
	Nonce     string                  `json:"nonce"`     // uint256 nonce as decimal string
	Deadline  string                  `json:"deadline"`  // Unix timestamp as decimal string
	Witness   UptoPermit2Witness      `json:"witness"`   // Witness data including facilitator
}

// UptoPermit2Payload represents the upto Permit2 payment payload sent by clients.
type UptoPermit2Payload struct {
	Signature            string                   `json:"signature"`            // EIP-712 signature (hex)
	Permit2Authorization UptoPermit2Authorization `json:"permit2Authorization"` // Authorization parameters
}

// ToMap converts an UptoPermit2Payload to a map for JSON marshaling.
func (p *UptoPermit2Payload) ToMap() map[string]interface{} {
	return map[string]interface{}{
		"signature": p.Signature,
		"permit2Authorization": map[string]interface{}{
			"from": p.Permit2Authorization.From,
			"permitted": map[string]interface{}{
				"token":  p.Permit2Authorization.Permitted.Token,
				"amount": p.Permit2Authorization.Permitted.Amount,
			},
			"spender":  p.Permit2Authorization.Spender,
			"nonce":    p.Permit2Authorization.Nonce,
			"deadline": p.Permit2Authorization.Deadline,
			"witness": map[string]interface{}{
				"to":          p.Permit2Authorization.Witness.To,
				"facilitator": p.Permit2Authorization.Witness.Facilitator,
				"validAfter":  p.Permit2Authorization.Witness.ValidAfter,
			},
		},
	}
}

// UptoPermit2PayloadFromMap creates an UptoPermit2Payload from a map.
// Returns an error if required fields are missing or malformed.
func UptoPermit2PayloadFromMap(data map[string]interface{}) (*UptoPermit2Payload, error) {
	payload := &UptoPermit2Payload{}

	if sig, ok := data["signature"].(string); ok {
		payload.Signature = sig
	}

	auth, ok := data["permit2Authorization"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid permit2Authorization field")
	}

	if from, ok := auth["from"].(string); ok {
		payload.Permit2Authorization.From = from
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.from field")
	}

	if spender, ok := auth["spender"].(string); ok {
		payload.Permit2Authorization.Spender = spender
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.spender field")
	}

	if nonce, ok := auth["nonce"].(string); ok {
		payload.Permit2Authorization.Nonce = nonce
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.nonce field")
	}

	if deadline, ok := auth["deadline"].(string); ok {
		payload.Permit2Authorization.Deadline = deadline
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.deadline field")
	}

	permitted, ok := auth["permitted"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.permitted field")
	}

	if token, ok := permitted["token"].(string); ok {
		payload.Permit2Authorization.Permitted.Token = token
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.permitted.token field")
	}

	if amount, ok := permitted["amount"].(string); ok {
		payload.Permit2Authorization.Permitted.Amount = amount
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.permitted.amount field")
	}

	witness, ok := auth["witness"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.witness field")
	}

	if to, ok := witness["to"].(string); ok {
		payload.Permit2Authorization.Witness.To = to
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.witness.to field")
	}

	if facilitator, ok := witness["facilitator"].(string); ok {
		payload.Permit2Authorization.Witness.Facilitator = facilitator
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.witness.facilitator field")
	}

	if validAfter, ok := witness["validAfter"].(string); ok {
		payload.Permit2Authorization.Witness.ValidAfter = validAfter
	} else {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.witness.validAfter field")
	}

	return payload, nil
}

// IsUptoPermit2Payload checks if a payload map is an upto Permit2 payload.
// Validates structural presence of all required fields including witness.facilitator.
func IsUptoPermit2Payload(data map[string]interface{}) bool {
	if _, ok := data["signature"].(string); !ok {
		return false
	}
	auth, ok := data["permit2Authorization"].(map[string]interface{})
	if !ok {
		return false
	}
	if _, ok := auth["from"].(string); !ok {
		return false
	}
	if _, ok := auth["spender"].(string); !ok {
		return false
	}
	witness, ok := auth["witness"].(map[string]interface{})
	if !ok {
		return false
	}
	if _, ok := witness["facilitator"].(string); !ok {
		return false
	}
	if _, ok := witness["to"].(string); !ok {
		return false
	}
	if _, ok := witness["validAfter"].(string); !ok {
		return false
	}
	return true
}

// ERC6492SignatureData represents the parsed components of an ERC-6492 signature
// ERC-6492 allows signatures from undeployed smart contract accounts by wrapping
// the signature with deployment information (factory address and calldata)
type ERC6492SignatureData struct {
	Factory         [20]byte // CREATE2 factory address (zero address if not ERC-6492)
	FactoryCalldata []byte   // Calldata to deploy the wallet (empty if not ERC-6492)
	InnerSignature  []byte   // The actual signature (EIP-1271 or EOA)
}
