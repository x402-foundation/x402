package eip2612gassponsor

import (
	"encoding/json"
	"fmt"
	"regexp"
)

// ExtractEip2612GasSponsoringInfo extracts the EIP-2612 gas sponsoring info
// from a payment payload's extensions (raw JSON bytes).
//
// Returns the info if the extension is present and contains the required
// client-populated fields, or nil if not present.
func ExtractEip2612GasSponsoringInfo(extensions map[string]interface{}) (*Info, error) {
	if extensions == nil {
		return nil, nil
	}

	extRaw, ok := extensions[EIP2612GasSponsoring.Key()]
	if !ok {
		return nil, nil
	}

	// Marshal and unmarshal to get the extension structure
	extJSON, err := json.Marshal(extRaw)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal eip2612GasSponsoring extension: %w", err)
	}

	var ext Extension
	if err := json.Unmarshal(extJSON, &ext); err != nil {
		return nil, fmt.Errorf("failed to unmarshal eip2612GasSponsoring extension: %w", err)
	}

	// Marshal and unmarshal info to get the typed struct
	infoJSON, err := json.Marshal(ext.Info)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal eip2612GasSponsoring info: %w", err)
	}

	var info Info
	if err := json.Unmarshal(infoJSON, &info); err != nil {
		return nil, fmt.Errorf("failed to unmarshal eip2612GasSponsoring info: %w", err)
	}

	// Check that the client has populated the required fields
	if info.From == "" || info.Asset == "" || info.Spender == "" ||
		info.Amount == "" || info.Nonce == "" || info.Deadline == "" ||
		info.Signature == "" || info.Version == "" {
		return nil, nil
	}

	return &info, nil
}

// ExtractEip2612GasSponsoringInfoFromPayloadBytes extracts the EIP-2612 gas
// sponsoring info from raw payment payload JSON bytes.
func ExtractEip2612GasSponsoringInfoFromPayloadBytes(payloadBytes []byte) (*Info, error) {
	var payload struct {
		Extensions map[string]interface{} `json:"extensions"`
	}
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}

	return ExtractEip2612GasSponsoringInfo(payload.Extensions)
}

var (
	addressPattern = regexp.MustCompile(`^0x[a-fA-F0-9]{40}$`)
	numericPattern = regexp.MustCompile(`^[0-9]+$`)
	hexPattern     = regexp.MustCompile(`^0x[a-fA-F0-9]+$`)
	versionPattern = regexp.MustCompile(`^[0-9]+(\.[0-9]+)*$`)
)

// ValidateEip2612GasSponsoringInfo validates that the EIP-2612 gas sponsoring
// info has valid format.
func ValidateEip2612GasSponsoringInfo(info *Info) bool {
	return addressPattern.MatchString(info.From) &&
		addressPattern.MatchString(info.Asset) &&
		addressPattern.MatchString(info.Spender) &&
		numericPattern.MatchString(info.Amount) &&
		numericPattern.MatchString(info.Nonce) &&
		numericPattern.MatchString(info.Deadline) &&
		hexPattern.MatchString(info.Signature) &&
		versionPattern.MatchString(info.Version)
}
