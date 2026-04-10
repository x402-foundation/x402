// Package eip2612gassponsor provides types and helpers for the EIP-2612 Gas Sponsoring extension.
//
// This extension enables gasless approval of the Permit2 contract for tokens
// that implement EIP-2612. The client signs an off-chain permit, and the
// facilitator submits it on-chain via x402Permit2Proxy.settleWithPermit.
package eip2612gassponsor

import x402 "github.com/x402-foundation/x402/go"

// EIP2612GasSponsoring is the extension identifier for the EIP-2612 gas sponsoring extension.
var EIP2612GasSponsoring = x402.NewFacilitatorExtension("eip2612GasSponsoring")

// Info contains the EIP-2612 permit data populated by the client.
// The facilitator uses this to call settleWithPermit.
type Info struct {
	// From is the address of the sender (token owner).
	From string `json:"from"`
	// Asset is the address of the ERC-20 token contract.
	Asset string `json:"asset"`
	// Spender is the address of the spender (Canonical Permit2).
	Spender string `json:"spender"`
	// Amount is the approval amount (uint256 as decimal string). Typically MaxUint256.
	Amount string `json:"amount"`
	// Nonce is the current EIP-2612 nonce of the sender (decimal string).
	Nonce string `json:"nonce"`
	// Deadline is the timestamp at which the permit signature expires (decimal string).
	Deadline string `json:"deadline"`
	// Signature is the 65-byte concatenated EIP-2612 permit signature (r, s, v) as hex.
	Signature string `json:"signature"`
	// Version is the schema version identifier.
	Version string `json:"version"`
}

// ServerInfo is the server-side info included in PaymentRequired.
// Contains a description and version; the client populates the rest.
type ServerInfo struct {
	Description string `json:"description"`
	Version     string `json:"version"`
}

// Extension represents the full extension object as it appears in
// PaymentRequired.extensions and PaymentPayload.extensions.
type Extension struct {
	Info   interface{}            `json:"info"`
	Schema map[string]interface{} `json:"schema"`
}
