package types

import (
	"encoding/json"
	"fmt"
)

// GetSchemeAndNetwork extracts scheme and network from payment payload bytes
// This is one of TWO version-aware functions in core (co-located for maintainability)
// Used by facilitator for routing
func GetSchemeAndNetwork(version int, payloadBytes []byte) (scheme string, network string, err error) {
	switch version {
	case 1:
		// V1: scheme and network at top level
		var partial struct {
			Scheme  string `json:"scheme"`
			Network string `json:"network"`
		}
		if err := json.Unmarshal(payloadBytes, &partial); err != nil {
			return "", "", fmt.Errorf("failed to parse v1 payload: %w", err)
		}
		return partial.Scheme, partial.Network, nil

	case 2:
		// V2: scheme and network in accepted field
		var partial struct {
			Accepted struct {
				Scheme  string `json:"scheme"`
				Network string `json:"network"`
			} `json:"accepted"`
		}
		if err := json.Unmarshal(payloadBytes, &partial); err != nil {
			return "", "", fmt.Errorf("failed to parse v2 payload: %w", err)
		}
		return partial.Accepted.Scheme, partial.Accepted.Network, nil

	default:
		return "", "", fmt.Errorf("unsupported version: %d", version)
	}
}

// MatchPayloadToRequirements checks if payment payload matches requirements
// This is one of TWO version-aware functions in core (co-located for maintainability)
// Used by server.FindMatchingRequirements
func MatchPayloadToRequirements(
	version int,
	payloadBytes []byte,
	requirementsBytes []byte,
) (bool, error) {
	switch version {
	case 1:
		// V1: Compare scheme and network from top level
		payloadScheme, payloadNetwork, err := GetSchemeAndNetwork(1, payloadBytes)
		if err != nil {
			return false, err
		}

		reqInfo, err := ExtractRequirementsInfo(requirementsBytes)
		if err != nil {
			return false, err
		}

		return payloadScheme == reqInfo.Scheme && payloadNetwork == reqInfo.Network, nil

	case 2:
		// V2: Compare key fields from accepted to requirements
		var payloadPartial struct {
			Accepted struct {
				Scheme  string `json:"scheme"`
				Network string `json:"network"`
				Amount  string `json:"amount"`
				Asset   string `json:"asset"`
				PayTo   string `json:"payTo"`
			} `json:"accepted"`
		}
		if err := json.Unmarshal(payloadBytes, &payloadPartial); err != nil {
			return false, err
		}

		var req struct {
			Scheme  string `json:"scheme"`
			Network string `json:"network"`
			Amount  string `json:"amount"`
			Asset   string `json:"asset"`
			PayTo   string `json:"payTo"`
		}
		if err := json.Unmarshal(requirementsBytes, &req); err != nil {
			return false, err
		}

		return payloadPartial.Accepted.Scheme == req.Scheme &&
			payloadPartial.Accepted.Network == req.Network &&
			payloadPartial.Accepted.Amount == req.Amount &&
			payloadPartial.Accepted.Asset == req.Asset &&
			payloadPartial.Accepted.PayTo == req.PayTo, nil

	default:
		return false, fmt.Errorf("unsupported version: %d", version)
	}
}
