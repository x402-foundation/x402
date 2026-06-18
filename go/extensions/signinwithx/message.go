package signinwithx

import (
	"fmt"
	"strconv"
	"strings"
)

// ExtractEVMChainID returns the numeric chain ID from an eip155 CAIP-2 chain ID.
func ExtractEVMChainID(chainID string) (int64, error) {
	const prefix = "eip155:"
	if !strings.HasPrefix(chainID, prefix) {
		return 0, fmt.Errorf("invalid EVM chainId format: %s. Expected eip155:<number>", chainID)
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(chainID, prefix), 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid EVM chainId format: %s. Expected eip155:<number>", chainID)
	}
	return id, nil
}

// CreateMessage creates the canonical SIWX message for signing.
func CreateMessage(payload Payload) (string, error) {
	if strings.HasPrefix(payload.ChainID, "eip155:") {
		return FormatSIWEMessage(payload)
	}
	return "", fmt.Errorf("unsupported chain namespace: %s. Supported: eip155:* (EVM)", payload.ChainID)
}

// FormatSIWEMessage formats an EIP-4361 SIWE message for an EVM SIWX payload.
func FormatSIWEMessage(payload Payload) (string, error) {
	chainID, err := ExtractEVMChainID(payload.ChainID)
	if err != nil {
		return "", err
	}

	var builder strings.Builder
	builder.WriteString(payload.Domain)
	builder.WriteString(" wants you to sign in with your Ethereum account:\n")
	builder.WriteString(payload.Address)
	builder.WriteString("\n\n")
	if payload.Statement != "" {
		builder.WriteString(payload.Statement)
		builder.WriteString("\n\n")
	} else {
		builder.WriteString("\n")
	}
	builder.WriteString("URI: ")
	builder.WriteString(payload.URI)
	builder.WriteString("\nVersion: ")
	builder.WriteString(payload.Version)
	builder.WriteString("\nChain ID: ")
	builder.WriteString(strconv.FormatInt(chainID, 10))
	builder.WriteString("\nNonce: ")
	builder.WriteString(payload.Nonce)
	builder.WriteString("\nIssued At: ")
	builder.WriteString(payload.IssuedAt)
	if payload.ExpirationTime != "" {
		builder.WriteString("\nExpiration Time: ")
		builder.WriteString(payload.ExpirationTime)
	}
	if payload.NotBefore != "" {
		builder.WriteString("\nNot Before: ")
		builder.WriteString(payload.NotBefore)
	}
	if payload.RequestID != "" {
		builder.WriteString("\nRequest ID: ")
		builder.WriteString(payload.RequestID)
	}
	if len(payload.Resources) > 0 {
		builder.WriteString("\nResources:")
		for _, resource := range payload.Resources {
			builder.WriteString("\n- ")
			builder.WriteString(resource)
		}
	}

	return builder.String(), nil
}
