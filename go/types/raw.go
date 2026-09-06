package types

import (
	"encoding/json"
	"fmt"
)

// DetectVersion extracts x402Version from JSON bytes
func DetectVersion(data []byte) (int, error) {
	var detector struct {
		X402Version int `json:"x402Version"`
	}
	if err := json.Unmarshal(data, &detector); err != nil {
		return 0, fmt.Errorf("failed to detect version: %w", err)
	}
	if detector.X402Version < 1 {
		return 0, fmt.Errorf("invalid version: %d", detector.X402Version)
	}
	return detector.X402Version, nil
}

// ExtractRequirementsInfo gets scheme and network from requirements bytes
// Works for both v1 and v2 (both have scheme/network at top level)
func ExtractRequirementsInfo(data []byte) (*RequirementsInfo, error) {
	var info struct {
		Scheme  string `json:"scheme"`
		Network string `json:"network"`
	}
	if err := json.Unmarshal(data, &info); err != nil {
		return nil, err
	}
	return &RequirementsInfo{
		Scheme:  info.Scheme,
		Network: info.Network,
	}, nil
}

// RequirementsInfo is minimal info extracted from requirements for routing
type RequirementsInfo struct {
	Scheme  string
	Network string
}

// PayloadBase is minimal payload structure (version + payload field only)
// Used by v2 client to return partial payload before core wraps it
type PayloadBase struct {
	X402Version int                    `json:"x402Version"`
	Payload     map[string]interface{} `json:"payload"`
}

// ToPayloadBase unmarshals just version and payload field
func ToPayloadBase(data []byte) (*PayloadBase, error) {
	var base PayloadBase
	if err := json.Unmarshal(data, &base); err != nil {
		return nil, err
	}
	return &base, nil
}

// PaymentRequiredPartial for extracting accepts array as raw bytes
// Keeps accepts as raw bytes to avoid version-specific unmarshaling
type PaymentRequiredPartial struct {
	X402Version int               `json:"x402Version"`
	Error       string            `json:"error,omitempty"`
	Accepts     []json.RawMessage `json:"accepts"` // Keep as raw bytes
	Resource    json.RawMessage   `json:"resource,omitempty"`
	Extensions  json.RawMessage   `json:"extensions,omitempty"`
}

// ToPaymentRequiredPartial unmarshals PaymentRequired keeping accepts as raw bytes
func ToPaymentRequiredPartial(data []byte) (*PaymentRequiredPartial, error) {
	var required PaymentRequiredPartial
	if err := json.Unmarshal(data, &required); err != nil {
		return nil, err
	}
	return &required, nil
}
