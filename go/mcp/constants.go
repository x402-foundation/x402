package mcp

// MCP meta key constants for x402 payment protocol.
const (
	// PaymentMetaKey is the _meta key for sending payment payloads (client -> server).
	PaymentMetaKey = "x402/payment"

	// PaymentResponseMetaKey is the _meta key for settlement responses (server -> client).
	PaymentResponseMetaKey = "x402/payment-response"
)
