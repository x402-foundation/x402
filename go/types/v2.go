package types

import (
	"encoding/json"
)

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

// PaymentRequired represents a v2 402 response structure
type PaymentRequired struct {
	X402Version int                    `json:"x402Version"`
	Error       string                 `json:"error,omitempty"`
	Resource    *ResourceInfo          `json:"resource,omitempty"`
	Accepts     []PaymentRequirements  `json:"accepts"`
	Extensions  map[string]interface{} `json:"extensions,omitempty"`
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
