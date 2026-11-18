package types

import (
	"encoding/json"
	"fmt"
	"regexp"
)

var networkV2Pattern = regexp.MustCompile(`^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$`)

// requirementsFields has PaymentRequirements' fields and none of its methods,
// so an envelope can decode nested requirements and then choose the network rule.
type requirementsFields PaymentRequirements

func checkNetworkV2(network string) error {
	if networkV2Pattern.MatchString(network) {
		return nil
	}
	return fmt.Errorf("network %q must be in CAIP-2 format (e.g., 'eip155:84532')", network)
}

// PaymentPayload represents a v2 payment payload structure
// V2 has accepted field with nested scheme/network/requirements
type PaymentPayload struct {
	X402Version int                    `json:"x402Version"`
	Payload     map[string]interface{} `json:"payload"`
	Accepted    PaymentRequirements    `json:"accepted"`
	Resource    *ResourceInfo          `json:"resource,omitempty"`
	Extensions  map[string]interface{} `json:"extensions,omitempty"`
}

// PaymentPayloadView interface implementation for V2
func (p PaymentPayload) GetVersion() int                    { return p.X402Version }
func (p PaymentPayload) GetScheme() string                  { return p.Accepted.Scheme }
func (p PaymentPayload) GetNetwork() string                 { return p.Accepted.Network }
func (p PaymentPayload) GetPayload() map[string]interface{} { return p.Payload }

// PaymentRequirements represents v2 payment requirements structure
type PaymentRequirements struct {
	Scheme            string                 `json:"scheme"`
	Network           string                 `json:"network"`
	Asset             string                 `json:"asset"`
	Amount            string                 `json:"amount"`
	PayTo             string                 `json:"payTo"`
	MaxTimeoutSeconds int                    `json:"maxTimeoutSeconds"`
	Extra             map[string]interface{} `json:"extra,omitempty"`
}

// PaymentRequirementsView interface implementation for V2
func (r PaymentRequirements) GetScheme() string                { return r.Scheme }
func (r PaymentRequirements) GetNetwork() string               { return r.Network }
func (r PaymentRequirements) GetAsset() string                 { return r.Asset }
func (r PaymentRequirements) GetAmount() string                { return r.Amount }
func (r PaymentRequirements) GetPayTo() string                 { return r.PayTo }
func (r PaymentRequirements) GetMaxTimeoutSeconds() int        { return r.MaxTimeoutSeconds }
func (r PaymentRequirements) GetExtra() map[string]interface{} { return r.Extra }

// UnmarshalJSON rejects a V2 network that is not a CAIP-2 identifier.
func (r *PaymentRequirements) UnmarshalJSON(data []byte) error {
	var decoded requirementsFields
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	if err := checkNetworkV2(decoded.Network); err != nil {
		return err
	}
	*r = PaymentRequirements(decoded)
	return nil
}

// UnmarshalJSON rejects a V2 accepted network that is not a CAIP-2 identifier.
// A payload with x402Version 1 keeps the network it was given.
func (p *PaymentPayload) UnmarshalJSON(data []byte) error {
	type payloadFields PaymentPayload
	var decoded payloadFields
	var accepted requirementsFields
	raw := struct {
		*payloadFields
		Accepted *requirementsFields `json:"accepted"`
	}{
		payloadFields: &decoded,
		Accepted:      &accepted,
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if raw.Accepted != nil {
		decoded.Accepted = PaymentRequirements(*raw.Accepted)
	}
	if decoded.X402Version != 1 {
		if err := checkNetworkV2(decoded.Accepted.Network); err != nil {
			return err
		}
	}
	*p = PaymentPayload(decoded)
	return nil
}

// PaymentRequired represents a v2 402 response structure
type PaymentRequired struct {
	X402Version int                    `json:"x402Version"`
	Error       string                 `json:"error,omitempty"`
	Resource    *ResourceInfo          `json:"resource,omitempty"`
	Accepts     []PaymentRequirements  `json:"accepts"`
	Extensions  map[string]interface{} `json:"extensions,omitempty"`
}

// UnmarshalJSON rejects each V2 accepts network that is not a CAIP-2 identifier.
// A response with x402Version 1 keeps the networks it was given.
func (p *PaymentRequired) UnmarshalJSON(data []byte) error {
	type requiredFields PaymentRequired
	var decoded requiredFields
	raw := struct {
		*requiredFields
		Accepts []requirementsFields `json:"accepts"`
	}{requiredFields: &decoded}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if raw.Accepts != nil {
		decoded.Accepts = make([]PaymentRequirements, len(raw.Accepts))
		for i := range raw.Accepts {
			decoded.Accepts[i] = PaymentRequirements(raw.Accepts[i])
		}
	}
	if decoded.X402Version != 1 {
		for i := range decoded.Accepts {
			if err := checkNetworkV2(decoded.Accepts[i].Network); err != nil {
				return err
			}
		}
	}
	*p = PaymentRequired(decoded)
	return nil
}

// ResourceInfo describes the resource being accessed.
//
// ServiceName, Tags, and IconUrl are bazaar service metadata fields. See
// specs/extensions/bazaar.md "Service Metadata on `resource`" for the
// soft-drop validation rules facilitators apply during extraction.
type ResourceInfo struct {
	URL         string   `json:"url"`
	Description string   `json:"description,omitempty"`
	MimeType    string   `json:"mimeType,omitempty"`
	ServiceName string   `json:"serviceName,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	IconUrl     string   `json:"iconUrl,omitempty"`
}

// SupportedKind represents a supported payment configuration
type SupportedKind struct {
	X402Version int                    `json:"x402Version"`
	Scheme      string                 `json:"scheme"`
	Network     string                 `json:"network"`
	Extra       map[string]interface{} `json:"extra,omitempty"`
}

// SupportedResponse describes what payment kinds a facilitator supports
type SupportedResponse struct {
	Kinds      []SupportedKind     `json:"kinds"`      // Array of kinds with version in each element
	Extensions []string            `json:"extensions"` // Protocol extensions supported
	Signers    map[string][]string `json:"signers"`    // CAIP family → Signer addresses
}

// Unmarshal helpers

// ToPaymentPayload unmarshals bytes to v2 payment payload
func ToPaymentPayload(data []byte) (*PaymentPayload, error) {
	var payload PaymentPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	return &payload, nil
}

// ToPaymentRequirements unmarshals bytes to v2 payment requirements
func ToPaymentRequirements(data []byte) (*PaymentRequirements, error) {
	var requirements PaymentRequirements
	if err := json.Unmarshal(data, &requirements); err != nil {
		return nil, err
	}
	return &requirements, nil
}

// ToPaymentRequired unmarshals bytes to v2 payment required response
func ToPaymentRequired(data []byte) (*PaymentRequired, error) {
	var required PaymentRequired
	if err := json.Unmarshal(data, &required); err != nil {
		return nil, err
	}
	return &required, nil
}

// ToSupportedKind unmarshals bytes to v2 supported kind
func ToSupportedKind(data []byte) (*SupportedKind, error) {
	var kind SupportedKind
	if err := json.Unmarshal(data, &kind); err != nil {
		return nil, err
	}
	return &kind, nil
}
