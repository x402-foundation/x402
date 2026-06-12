package signinwithx

import (
	"fmt"
	"regexp"
	"strings"
)

var eip155Re = regexp.MustCompile(`^eip155:(\d+)$`)

// messageFields is the subset of a challenge needed to reconstruct the signed
// message, shared by Info and Payload.
type messageFields struct {
	domain, address, uri, statement, version, chainID, nonce, issuedAt string
	expirationTime, notBefore, requestID                               string
	resources                                                          []string
}

func fieldsFromPayload(p Payload) messageFields {
	return messageFields{
		domain: p.Domain, address: p.Address, uri: p.URI, statement: p.Statement, version: p.Version,
		chainID: p.ChainID, nonce: p.Nonce, issuedAt: p.IssuedAt,
		expirationTime: p.ExpirationTime, notBefore: p.NotBefore, requestID: p.RequestID,
		resources: p.Resources,
	}
}

// CreateMessage builds the CAIP-122 message string a wallet signs, routing by
// the chainId namespace: eip155:* uses EIP-4361 (SIWE), solana:* uses SIWS.
func CreateMessage(chainID string, f messageFields) (string, error) {
	switch {
	case strings.HasPrefix(chainID, "eip155:"):
		return formatSIWE(chainID, f)
	case strings.HasPrefix(chainID, "solana:"):
		return formatSIWS(chainID, f), nil
	default:
		return "", fmt.Errorf("unsupported chain namespace: %s (supported: eip155:*, solana:*)", chainID)
	}
}

// extractEVMChainID returns the numeric chain id from a CAIP-2 eip155 id.
func extractEVMChainID(chainID string) (string, error) {
	m := eip155Re.FindStringSubmatch(chainID)
	if m == nil {
		return "", fmt.Errorf("invalid EVM chainId: %s (expected eip155:<number>)", chainID)
	}
	return m[1], nil
}

// formatSIWE renders an EIP-4361 message. The blank-line layout follows the
// EIP-4361 ABNF: a statement is wrapped by a blank line on each side; with no
// statement the address is followed by two blank lines.
func formatSIWE(chainID string, f messageFields) (string, error) {
	numericChainID, err := extractEVMChainID(chainID)
	if err != nil {
		return "", err
	}

	suffix := []string{
		"URI: " + f.uri,
		"Version: " + f.version,
		"Chain ID: " + numericChainID,
		"Nonce: " + f.nonce,
		"Issued At: " + f.issuedAt,
	}
	if f.expirationTime != "" {
		suffix = append(suffix, "Expiration Time: "+f.expirationTime)
	}
	if f.notBefore != "" {
		suffix = append(suffix, "Not Before: "+f.notBefore)
	}
	if f.requestID != "" {
		suffix = append(suffix, "Request ID: "+f.requestID)
	}
	if len(f.resources) > 0 {
		lines := []string{"Resources:"}
		for _, r := range f.resources {
			lines = append(lines, "- "+r)
		}
		suffix = append(suffix, strings.Join(lines, "\n"))
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%s wants you to sign in with your Ethereum account:\n%s\n\n", f.domain, f.address)
	if f.statement != "" {
		b.WriteString(f.statement + "\n")
	}
	b.WriteString("\n")
	b.WriteString(strings.Join(suffix, "\n"))
	return b.String(), nil
}

// formatSIWS renders a Sign-In-With-Solana message (CAIP-122). The layout
// mirrors typescript/.../sign-in-with-x/solana.ts.
func formatSIWS(chainID string, f messageFields) string {
	lines := []string{
		f.domain + " wants you to sign in with your Solana account:",
		f.address,
		"",
	}
	if f.statement != "" {
		lines = append(lines, f.statement, "")
	}
	lines = append(lines,
		"URI: "+f.uri,
		"Version: "+f.version,
		"Chain ID: "+strings.TrimPrefix(chainID, "solana:"),
		"Nonce: "+f.nonce,
		"Issued At: "+f.issuedAt,
	)
	if f.expirationTime != "" {
		lines = append(lines, "Expiration Time: "+f.expirationTime)
	}
	if f.notBefore != "" {
		lines = append(lines, "Not Before: "+f.notBefore)
	}
	if f.requestID != "" {
		lines = append(lines, "Request ID: "+f.requestID)
	}
	if len(f.resources) > 0 {
		lines = append(lines, "Resources:")
		for _, r := range f.resources {
			lines = append(lines, "- "+r)
		}
	}
	return strings.Join(lines, "\n")
}
