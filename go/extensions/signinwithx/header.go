package signinwithx

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
)

// EncodeHeader encodes a SIWX payload for the SIGN-IN-WITH-X header.
func EncodeHeader(payload Payload) (string, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal SIWX payload: %w", err)
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// ParseHeader decodes a SIGN-IN-WITH-X header into a SIWX payload.
func ParseHeader(header string) (Payload, error) {
	if header == "" {
		return Payload{}, errors.New("invalid SIWX header: empty")
	}

	data, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		return Payload{}, fmt.Errorf("invalid SIWX header: not valid base64: %w", err)
	}

	var payload Payload
	if err := json.Unmarshal(data, &payload); err != nil {
		return Payload{}, fmt.Errorf("invalid SIWX header: not valid JSON: %w", err)
	}

	if err := validatePayloadShape(payload); err != nil {
		return Payload{}, fmt.Errorf("invalid SIWX header: %w", err)
	}

	return payload, nil
}

func validatePayloadShape(payload Payload) error {
	required := map[string]string{
		"domain":    payload.Domain,
		"address":   payload.Address,
		"uri":       payload.URI,
		"version":   payload.Version,
		"chainId":   payload.ChainID,
		"type":      payload.Type,
		"nonce":     payload.Nonce,
		"issuedAt":  payload.IssuedAt,
		"signature": payload.Signature,
	}
	for field, value := range required {
		if value == "" {
			return fmt.Errorf("missing required field %q", field)
		}
	}
	if payload.Type != SignatureTypeEIP191 && payload.Type != SignatureTypeEd25519 {
		return fmt.Errorf("unsupported signature type %q", payload.Type)
	}
	return nil
}
