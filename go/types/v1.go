package types

import (
	"encoding/json"
)

// PaymentPayloadV1 represents a v1 payment payload structure
// V1 has scheme and network at top level (not in accepted field)
type PaymentPayloadV1 struct {
	X402Version int                    `json:"x402Version"`
	Scheme      string                 `json:"scheme"`
	Network     string                 `json:"network"`
	Payload     map[string]interface{} `json:"payload"`
}

// PaymentPayloadView interface implementation for V1
func (p PaymentPayloadV1) GetVersion() int                    { return p.X402Version }
func (p PaymentPayloadV1) GetScheme() string                  { return p.Scheme }
func (p PaymentPayloadV1) GetNetwork() string                 { return p.Network }
func (p PaymentPayloadV1) GetPayload() map[string]interface{} { return p.Payload }

// PaymentRequirementsV1 represents v1 payment requirements structure
type PaymentRequirementsV1 struct {
	Scheme            string           `json:"scheme"`
	Network           string           `json:"network"`
	MaxAmountRequired string           `json:"maxAmountRequired"`
	Resource          string           `json:"resource"`
	Description       string           `json:"description,omitempty"`
	MimeType          string           `json:"mimeType,omitempty"`
	PayTo             string           `json:"payTo"`
	MaxTimeoutSeconds int              `json:"maxTimeoutSeconds"`
	Asset             string           `json:"asset"`
	OutputSchema      *json.RawMessage `json:"outputSchema,omitempty"`
	Extra             *json.RawMessage `json:"extra,omitempty"`
}

// PaymentRequirementsView interface implementation for V1
func (r PaymentRequirementsV1) GetScheme() string         { return r.Scheme }
func (r PaymentRequirementsV1) GetNetwork() string        { return r.Network }
func (r PaymentRequirementsV1) GetAsset() string          { return r.Asset }
func (r PaymentRequirementsV1) GetAmount() string         { return r.MaxAmountRequired }
func (r PaymentRequirementsV1) GetPayTo() string          { return r.PayTo }
func (r PaymentRequirementsV1) GetMaxTimeoutSeconds() int { return r.MaxTimeoutSeconds }
func (r PaymentRequirementsV1) GetExtra() map[string]interface{} {
	if r.Extra == nil {
		return nil
	}
	var m map[string]interface{}
	if err := json.Unmarshal(*r.Extra, &m); err != nil {
		return make(map[string]interface{}) // Return empty on error
	}
	return m
}

// PaymentRequiredV1 represents a v1 402 response structure
type PaymentRequiredV1 struct {
	X402Version int                     `json:"x402Version"`
	Error       string                  `json:"error,omitempty"`
	Accepts     []PaymentRequirementsV1 `json:"accepts"`
}

// SupportedKindV1 represents a V1 supported payment configuration
type SupportedKindV1 struct {
	X402Version int              `json:"x402Version"`
	Scheme      string           `json:"scheme"`
	Network     string           `json:"network"`
	Extra       *json.RawMessage `json:"extra,omitempty"`
}

// Unmarshal helpers

// ToPaymentPayloadV1 unmarshals bytes to v1 payment payload
func ToPaymentPayloadV1(data []byte) (*PaymentPayloadV1, error) {
	var payload PaymentPayloadV1
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	return &payload, nil
}

// ToPaymentRequirementsV1 unmarshals bytes to v1 payment requirements
func ToPaymentRequirementsV1(data []byte) (*PaymentRequirementsV1, error) {
	var requirements PaymentRequirementsV1
	if err := json.Unmarshal(data, &requirements); err != nil {
		return nil, err
	}
	return &requirements, nil
}

// ToPaymentRequiredV1 unmarshals bytes to v1 payment required response
func ToPaymentRequiredV1(data []byte) (*PaymentRequiredV1, error) {
	var required PaymentRequiredV1
	if err := json.Unmarshal(data, &required); err != nil {
		return nil, err
	}
	return &required, nil
}

// SupportedResponseV1 is the old supported response format (V1 only, no extensions)
type SupportedResponseV1 struct {
	Kinds []SupportedKindV1 `json:"kinds"`
}

// ToSupportedKindV1 unmarshals bytes to v1 supported kind
func ToSupportedKindV1(data []byte) (*SupportedKindV1, error) {
	var kind SupportedKindV1
	if err := json.Unmarshal(data, &kind); err != nil {
		return nil, err
	}
	return &kind, nil
}
