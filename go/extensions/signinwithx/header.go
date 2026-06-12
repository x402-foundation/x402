package signinwithx

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// EncodeHeader serializes a payload as base64-encoded JSON for the
// SIGN-IN-WITH-X header.
func EncodeHeader(p Payload) (string, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

// ParseHeader decodes a SIGN-IN-WITH-X header into a Payload and checks that the
// schema-required fields are present and well-formed.
func ParseHeader(header string) (Payload, error) {
	var p Payload
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(header))
	if err != nil {
		return p, fmt.Errorf("invalid SIWX header: not valid base64: %w", err)
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, fmt.Errorf("invalid SIWX header: not valid JSON: %w", err)
	}
	if err := p.checkRequired(); err != nil {
		return p, fmt.Errorf("invalid SIWX header: %w", err)
	}
	return p, nil
}

// checkRequired enforces the required client-proof fields from the extension
// schema, mirroring the TypeScript SIWxPayloadSchema.
func (p Payload) checkRequired() error {
	for name, v := range map[string]string{
		"domain": p.Domain, "address": p.Address, "uri": p.URI, "version": p.Version,
		"chainId": p.ChainID, "nonce": p.Nonce, "issuedAt": p.IssuedAt, "signature": p.Signature,
	} {
		if v == "" {
			return fmt.Errorf("missing required field: %s", name)
		}
	}
	switch p.Type {
	case SignatureTypeEIP191, SignatureTypeEd25519:
	default:
		return fmt.Errorf("invalid type: %q (expected eip191 or ed25519)", p.Type)
	}
	return nil
}
