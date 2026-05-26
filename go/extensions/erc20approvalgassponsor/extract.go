package erc20approvalgassponsor

import (
	"encoding/json"
	"fmt"
	"regexp"
)

var (
	addressPattern = regexp.MustCompile(`^0x[a-fA-F0-9]{40}$`)
	numericPattern = regexp.MustCompile(`^[0-9]+$`)
	hexPattern     = regexp.MustCompile(`^0x[a-fA-F0-9]+$`)
	versionPattern = regexp.MustCompile(`^[0-9]+(\.[0-9]+)*$`)
)

// ExtractInfo extracts the ERC-20 approval gas sponsoring info from a payment
// payload's extensions map.
//
// Returns the info if the extension is present and contains the required
// client-populated fields, or nil if not present or incomplete.
func ExtractInfo(extensions map[string]interface{}) (*Info, error) {
	if extensions == nil {
		return nil, nil
	}

	extRaw, ok := extensions[ERC20ApprovalGasSponsoring.Key()]
	if !ok {
		return nil, nil
	}

	// Marshal and unmarshal to get the extension structure
	extJSON, err := json.Marshal(extRaw)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal erc20ApprovalGasSponsoring extension: %w", err)
	}

	var ext Extension
	if err := json.Unmarshal(extJSON, &ext); err != nil {
		return nil, fmt.Errorf("failed to unmarshal erc20ApprovalGasSponsoring extension: %w", err)
	}

	// Marshal and unmarshal info to get the typed struct
	infoJSON, err := json.Marshal(ext.Info)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal erc20ApprovalGasSponsoring info: %w", err)
	}

	var info Info
	if err := json.Unmarshal(infoJSON, &info); err != nil {
		return nil, fmt.Errorf("failed to unmarshal erc20ApprovalGasSponsoring info: %w", err)
	}

	// Check that the client has populated the required fields
	if info.From == "" || info.Asset == "" || info.Spender == "" ||
		info.Amount == "" || info.SignedTransaction == "" || info.Version == "" {
		return nil, nil
	}

	return &info, nil
}

// ValidateInfo validates that the ERC-20 approval gas sponsoring info has valid format.
func ValidateInfo(info *Info) bool {
	return addressPattern.MatchString(info.From) &&
		addressPattern.MatchString(info.Asset) &&
		addressPattern.MatchString(info.Spender) &&
		numericPattern.MatchString(info.Amount) &&
		hexPattern.MatchString(info.SignedTransaction) &&
		versionPattern.MatchString(info.Version)
}
