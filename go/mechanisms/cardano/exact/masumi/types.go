package masumi

import (
	"encoding/json"
	"fmt"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

// Error is a Masumi rejection carrying the wire-visible reason.
type Error struct {
	Reason string
	Detail string
}

func (e *Error) Error() string {
	if e.Detail == "" {
		return e.Reason
	}
	return e.Reason + ": " + e.Detail
}

// OptionalValue is a JSON value whose absence is distinct from JSON null.
type OptionalValue struct {
	Set   bool
	Value interface{}
}

// IsZero reports absence, so omitzero drops an unset value.
func (o OptionalValue) IsZero() bool { return !o.Set }

// MarshalJSON encodes the value (null when set to nil).
func (o OptionalValue) MarshalJSON() ([]byte, error) { return json.Marshal(o.Value) }

// UnmarshalJSON marks the value present.
func (o *OptionalValue) UnmarshalJSON(b []byte) error {
	o.Set = true
	return json.Unmarshal(b, &o.Value)
}

// AgentIdentifier is the three-state terms.agentIdentifier: absent, JSON null,
// or a string. The states are distinct signed wire values.
type AgentIdentifier struct {
	Set   bool
	Null  bool
	Value string
}

// IsZero reports absence, so omitzero drops an unset identifier.
func (a AgentIdentifier) IsZero() bool { return !a.Set }

// Hex is the effective identifier: the string value, or empty when absent or null.
func (a AgentIdentifier) Hex() string {
	if !a.Set || a.Null {
		return ""
	}
	return a.Value
}

func (a AgentIdentifier) wire() interface{} {
	if a.Null {
		return nil
	}
	return a.Value
}

// MarshalJSON encodes null or the string value.
func (a AgentIdentifier) MarshalJSON() ([]byte, error) { return json.Marshal(a.wire()) }

// UnmarshalJSON accepts null or a string.
func (a *AgentIdentifier) UnmarshalJSON(b []byte) error {
	var v *string
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*a = AgentIdentifier{Set: true, Null: v == nil}
	if v != nil {
		a.Value = *v
	}
	return nil
}

// CommitmentPart is one part of the request commitment.
type CommitmentPart struct {
	Name             string        `json:"name"`
	Canonicalization string        `json:"canonicalization"`
	MediaType        *string       `json:"mediaType,omitempty"`
	Content          OptionalValue `json:"content,omitzero"`
	Digest           string        `json:"digest"`
}

// InputCommitment is the request commitment whose digest is terms.inputHash.
type InputCommitment struct {
	Version   string           `json:"version"`
	Algorithm string           `json:"algorithm"`
	Parts     []CommitmentPart `json:"parts"`
	Digest    string           `json:"digest"`
}

// Terms are the seller-signed terms.
type Terms struct {
	Version                   string          `json:"version"`
	PaymentType               string          `json:"paymentType"`
	SellerAddress             string          `json:"sellerAddress"`
	SellerReturnAddress       *string         `json:"sellerReturnAddress,omitempty"`
	SellerNonce               string          `json:"sellerNonce"`
	BuyerNonce                string          `json:"buyerNonce"`
	AgentIdentifier           AgentIdentifier `json:"agentIdentifier,omitzero"`
	InputHash                 string          `json:"inputHash"`
	PayByTime                 string          `json:"payByTime"`
	SubmitResultTime          string          `json:"submitResultTime"`
	UnlockTime                string          `json:"unlockTime"`
	ExternalDisputeUnlockTime string          `json:"externalDisputeUnlockTime"`
}

// Deployment are the vested_pay parameters baked into the escrow script hash.
type Deployment struct {
	RequiredAdmins string   `json:"requiredAdmins"`
	AdminVkeys     []string `json:"adminVkeys"`
	CooldownPeriod string   `json:"cooldownPeriod"`
}

// Extra is the closed requirements.extra block of the masumi method.
type Extra struct {
	AssetTransferMethod  string                      `json:"assetTransferMethod"`
	ConfirmationPolicy   *cardano.ConfirmationPolicy `json:"confirmationPolicy,omitempty"`
	AreFeesSponsored     *bool                       `json:"areFeesSponsored,omitempty"`
	InputCommitment      InputCommitment             `json:"inputCommitment"`
	Terms                Terms                       `json:"terms"`
	ReferenceKey         string                      `json:"referenceKey"`
	ReferenceSignature   string                      `json:"referenceSignature"`
	BlockchainIdentifier string                      `json:"blockchainIdentifier"`
	Deployment           *Deployment                 `json:"deployment,omitempty"`
}

// ToMap renders the extra as the JSON-decoded map carried in PaymentRequirements.
func (e *Extra) ToMap() (map[string]interface{}, error) {
	raw, err := json.Marshal(e)
	if err != nil {
		return nil, fmt.Errorf("cannot encode masumi extra: %w", err)
	}
	var out map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}
