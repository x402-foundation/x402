package signinwithx

import (
	"time"

	"github.com/x402-foundation/x402/go/v2/extensions/types"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

// Key is the extension identifier in PaymentRequired.extensions.
const Key = "sign-in-with-x"

// Header is the HTTP header carrying the base64-encoded client proof.
const Header = "SIGN-IN-WITH-X"

// SignatureType is the CAIP-122 signature algorithm for a chain.
type SignatureType string

const (
	// SignatureTypeEIP191 is personal_sign over an EIP-4361 message (EVM).
	SignatureTypeEIP191 SignatureType = "eip191"
	// SignatureTypeEd25519 is Ed25519 over a SIWS message (Solana).
	SignatureTypeEd25519 SignatureType = "ed25519"
)

// SignatureScheme is an optional client-facing hint for signing UX. It does
// not affect verification, which is selected by the chainId namespace.
type SignatureScheme string

const (
	SchemeEIP191  SignatureScheme = "eip191"
	SchemeEIP1271 SignatureScheme = "eip1271"
	SchemeEIP6492 SignatureScheme = "eip6492"
	SchemeSIWS    SignatureScheme = "siws"
)

// SupportedChain is one authentication method the server accepts.
type SupportedChain struct {
	ChainID         string          `json:"chainId"`
	Type            SignatureType   `json:"type"`
	SignatureScheme SignatureScheme `json:"signatureScheme,omitempty"`
}

// Info is the server-declared challenge metadata shared across chains.
type Info struct {
	Domain         string   `json:"domain"`
	URI            string   `json:"uri"`
	Statement      string   `json:"statement,omitempty"`
	Version        string   `json:"version"`
	Nonce          string   `json:"nonce"`
	IssuedAt       string   `json:"issuedAt"`
	ExpirationTime string   `json:"expirationTime,omitempty"`
	NotBefore      string   `json:"notBefore,omitempty"`
	RequestID      string   `json:"requestId,omitempty"`
	Resources      []string `json:"resources,omitempty"`
}

// Extension is the full PaymentRequired.extensions["sign-in-with-x"] value.
type Extension struct {
	Info            Info             `json:"info"`
	SupportedChains []SupportedChain `json:"supportedChains"`
	Schema          types.JSONSchema `json:"schema"`
}

// Payload is the client proof sent in the SIGN-IN-WITH-X header. It echoes the
// signed message fields and adds the wallet address and signature.
type Payload struct {
	Domain          string          `json:"domain"`
	Address         string          `json:"address"`
	Statement       string          `json:"statement,omitempty"`
	URI             string          `json:"uri"`
	Version         string          `json:"version"`
	ChainID         string          `json:"chainId"`
	Type            SignatureType   `json:"type"`
	Nonce           string          `json:"nonce"`
	IssuedAt        string          `json:"issuedAt"`
	ExpirationTime  string          `json:"expirationTime,omitempty"`
	NotBefore       string          `json:"notBefore,omitempty"`
	RequestID       string          `json:"requestId,omitempty"`
	Resources       []string        `json:"resources,omitempty"`
	SignatureScheme SignatureScheme `json:"signatureScheme,omitempty"`
	Signature       string          `json:"signature"`
}

// DeclareOptions configures a SIWX challenge. ResourceURI and Networks are the
// common inputs; the rest have sensible defaults.
type DeclareOptions struct {
	// Domain is the server domain. Derived from ResourceURI when empty.
	Domain string
	// ResourceURI is the full resource URI being protected.
	ResourceURI string
	// Statement is an optional human-readable signing purpose.
	Statement string
	// Version is the CAIP-122 version. Defaults to "1".
	Version string
	// Networks are the CAIP-2 chains the server accepts (e.g. "eip155:8453").
	Networks []string
	// ExpirationSeconds bounds the challenge lifetime. Nil means no expiry.
	ExpirationSeconds *int
}

// ValidationResult reports whether a payload's fields are valid.
type ValidationResult struct {
	Valid bool
	Error string
}

// VerifyResult reports the outcome of full verification (fields + signature).
type VerifyResult struct {
	Valid bool
	// Address is the verified wallet (checksummed for EVM, base58 for Solana).
	Address string
	Error   string
}

// VerifyOptions configures signature verification.
type VerifyOptions struct {
	// EVMVerifier enables smart-wallet signatures (EIP-1271 / ERC-6492) by
	// supplying a facilitator signer with an RPC client. Nil verifies EOA only.
	EVMVerifier evm.FacilitatorEvmSigner
	// AllowUndeployedSmartWallet permits ERC-6492 proofs from wallets not yet
	// deployed. Only consulted when EVMVerifier is set.
	AllowUndeployedSmartWallet bool
}

// ValidationOptions configures message field validation.
type ValidationOptions struct {
	// MaxAge bounds how old issuedAt may be. Zero uses the 5-minute default.
	MaxAge time.Duration
	// CheckNonce, when set, must return true for an unused nonce.
	CheckNonce func(nonce string) bool
}
