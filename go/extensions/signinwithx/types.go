package signinwithx

import (
	"context"
	"time"

	siwe "github.com/signinwithethereum/siwe-go"
)

const (
	// SolanaMainnet is the CAIP-2 identifier for Solana mainnet-beta.
	SolanaMainnet = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
	// SolanaDevnet is the CAIP-2 identifier for Solana devnet.
	SolanaDevnet = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
	// SolanaTestnet is the CAIP-2 identifier for Solana testnet.
	SolanaTestnet = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"
)

const (
	// ExtensionKey is the x402 extension identifier for sign-in-with-x.
	ExtensionKey = "sign-in-with-x"
	// HeaderName is the HTTP header carrying the base64-encoded SIWX payload.
	HeaderName = "SIGN-IN-WITH-X"
	// Version is the default CAIP-122 version.
	Version = "1"
)

const (
	// SignatureTypeEIP191 identifies EIP-191 message signatures.
	SignatureTypeEIP191 = "eip191"
	// SignatureTypeEd25519 identifies Ed25519 message signatures.
	SignatureTypeEd25519 = "ed25519"
)

const (
	// SignatureSchemeEIP191 is the default EVM EOA signature scheme.
	SignatureSchemeEIP191 = "eip191"
	// SignatureSchemeEIP1271 identifies EIP-1271 smart wallet verification.
	SignatureSchemeEIP1271 = "eip1271"
	// SignatureSchemeEIP6492 identifies EIP-6492 counterfactual wallet verification.
	SignatureSchemeEIP6492 = "eip6492"
	// SignatureSchemeSIWS identifies Sign-In-With-Solana signatures.
	SignatureSchemeSIWS = "siws"
)

// Info contains server-provided SIWX message metadata.
type Info struct {
	Domain         string   `json:"domain,omitempty"`
	URI            string   `json:"uri,omitempty"`
	Statement      string   `json:"statement,omitempty"`
	Version        string   `json:"version"`
	Nonce          string   `json:"nonce,omitempty"`
	IssuedAt       string   `json:"issuedAt,omitempty"`
	ExpirationTime string   `json:"expirationTime,omitempty"`
	NotBefore      string   `json:"notBefore,omitempty"`
	RequestID      string   `json:"requestId,omitempty"`
	Resources      []string `json:"resources,omitempty"`
}

// SupportedChain describes a chain accepted for SIWX authentication.
type SupportedChain struct {
	ChainID         string `json:"chainId"`
	Type            string `json:"type"`
	SignatureScheme string `json:"signatureScheme,omitempty"`
}

// Extension is the full extension declaration value.
type Extension struct {
	Info            Info                   `json:"info"`
	SupportedChains []SupportedChain       `json:"supportedChains"`
	Schema          map[string]interface{} `json:"schema"`
	Options         DeclareOptions         `json:"-"`
}

// Payload is the client proof carried in the SIGN-IN-WITH-X header.
type Payload struct {
	Domain          string   `json:"domain"`
	Address         string   `json:"address"`
	Statement       string   `json:"statement,omitempty"`
	URI             string   `json:"uri"`
	Version         string   `json:"version"`
	ChainID         string   `json:"chainId"`
	Type            string   `json:"type"`
	Nonce           string   `json:"nonce"`
	IssuedAt        string   `json:"issuedAt"`
	ExpirationTime  string   `json:"expirationTime,omitempty"`
	NotBefore       string   `json:"notBefore,omitempty"`
	RequestID       string   `json:"requestId,omitempty"`
	Resources       []string `json:"resources,omitempty"`
	SignatureScheme string   `json:"signatureScheme,omitempty"`
	Signature       string   `json:"signature"`
}

// DeclareOptions configures a SIWX extension declaration.
type DeclareOptions struct {
	Statement         string
	Version           string
	Networks          []string
	ExpirationSeconds int
}

// ValidationOptions configures payload field validation.
type ValidationOptions struct {
	MaxAge     time.Duration
	CheckNonce func(string) bool
}

const (
	ErrInvalidSIWxDomainMismatch     = "invalid_siwx_domain_mismatch"
	ErrInvalidSIWxURIMismatch        = "invalid_siwx_uri_mismatch"
	ErrInvalidSIWxIssuedAt           = "invalid_siwx_issued_at"
	ErrInvalidSIWxIssuedAtTooOld     = "invalid_siwx_issued_at_too_old"
	ErrInvalidSIWxIssuedAtInFuture   = "invalid_siwx_issued_at_in_future"
	ErrInvalidSIWxExpirationTime     = "invalid_siwx_expiration_time"
	ErrInvalidSIWxExpired            = "invalid_siwx_expired"
	ErrInvalidSIWxNotBefore          = "invalid_siwx_not_before"
	ErrInvalidSIWxNotYetValid        = "invalid_siwx_not_yet_valid"
	ErrInvalidSIWxNonce              = "invalid_siwx_nonce"
	ErrInvalidSIWxSignature          = "invalid_siwx_signature"
	ErrInvalidSIWxChainID            = "invalid_siwx_chain_id"
	ErrInvalidSIWxUnsupportedChain   = "invalid_siwx_unsupported_chain"
	ErrInvalidSIWxMalformedSignature = "invalid_siwx_malformed_signature"
	ErrInvalidSIWxVerifierError      = "invalid_siwx_verifier_error"
)

// ValidationResult is returned by ValidateMessage.
type ValidationResult struct {
	IsValid        bool
	InvalidReason  string
	InvalidMessage string
}

// EVMMessageVerifier verifies an EIP-191 SIWX message for an EVM address.
//
// Servers can provide a verifier backed by on-chain reads to support smart
// wallet signatures such as EIP-1271 and ERC-6492.
type EVMMessageVerifier func(ctx context.Context, address string, message string, signature string) (bool, error)

// EVMContractSignatureVerifier verifies SIWE smart-wallet signatures.
//
// It matches siwe-go's contract verifier interface. Implementations can use
// siwe.NewEthCallerVerifier with an ethclient.Client to support deployed
// EIP-1271 and counterfactual EIP-6492 signatures.
type EVMContractSignatureVerifier = siwe.ContractSignatureVerifier

// VerifyOptions configures SIWX signature verification.
type VerifyOptions struct {
	EVMVerifier         EVMMessageVerifier
	EVMContractVerifier EVMContractSignatureVerifier
}

// VerifyResult is returned by VerifySignature.
type VerifyResult struct {
	IsValid        bool
	InvalidReason  string
	InvalidMessage string
	Payer          string
}
