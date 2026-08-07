package signinwithx

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	siwe "github.com/signinwithethereum/siwe-go"
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
	if strings.HasPrefix(payload.ChainID, "solana:") {
		return FormatSIWSMessage(payload)
	}
	return "", fmt.Errorf("unsupported chain namespace: %s. Supported: eip155:* (EVM), solana:* (Solana)", payload.ChainID)
}

// FormatSIWEMessage formats an EIP-4361 SIWE message for an EVM SIWX payload.
func FormatSIWEMessage(payload Payload) (string, error) {
	message, err := createSIWEMessage(payload)
	if err != nil {
		return "", err
	}
	return message.PrepareMessage(), nil
}

func createSIWEMessage(payload Payload) (*siwe.Message, error) {
	chainID, err := ExtractEVMChainID(payload.ChainID)
	if err != nil {
		return nil, err
	}
	if chainID > math.MaxInt {
		return nil, fmt.Errorf("invalid EVM chainId format: %s. Chain ID exceeds platform int range", payload.ChainID)
	}

	options := map[string]interface{}{
		"version":  payload.Version,
		"chainId":  int(chainID),
		"issuedAt": payload.IssuedAt,
	}
	if payload.Statement != "" {
		options["statement"] = payload.Statement
	}
	if payload.ExpirationTime != "" {
		options["expirationTime"] = payload.ExpirationTime
	}
	if payload.NotBefore != "" {
		options["notBefore"] = payload.NotBefore
	}
	if payload.RequestID != "" {
		options["requestId"] = payload.RequestID
	}
	if len(payload.Resources) > 0 {
		options["resources"] = payload.Resources
	}

	return siwe.NewMessage(payload.Domain, payload.Address, payload.URI, payload.Nonce, options)
}

// ExtractSolanaChainReference returns the chain reference from a solana CAIP-2 chain ID.
func ExtractSolanaChainReference(chainID string) (string, error) {
	const prefix = "solana:"
	if !strings.HasPrefix(chainID, prefix) {
		return "", fmt.Errorf("invalid Solana chainId format: %s. Expected solana:<reference>", chainID)
	}
	reference := strings.TrimPrefix(chainID, prefix)
	if reference == "" {
		return "", fmt.Errorf("invalid Solana chainId format: %s. Expected solana:<reference>", chainID)
	}
	return reference, nil
}

// FormatSIWSMessage formats a SIWS message for a Solana SIWX payload.
func FormatSIWSMessage(payload Payload) (string, error) {
	chainReference, err := ExtractSolanaChainReference(payload.ChainID)
	if err != nil {
		return "", err
	}

	var builder strings.Builder
	builder.WriteString(payload.Domain)
	builder.WriteString(" wants you to sign in with your Solana account:\n")
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
	builder.WriteString(chainReference)
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
