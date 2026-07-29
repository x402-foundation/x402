// Package buildercode provides types and helpers for the Builder Code Extension (ERC-8021).
//
// The extension enables attribution tracking for x402 payments by appending
// ERC-8021 Schema 2 builder codes to settlement transaction calldata. Three
// parties attach their builder code:
//   - Server: declares "a" (app) in the 402 response via DeclareBuilderCodeExtension.
//   - Client: adds "s" (service) via BuilderCodeClientExtension.
//   - Facilitator: optionally adds "w" (wallet) at settlement via BuilderCodeFacilitatorExtension.
package buildercode

import "regexp"

// BUILDER_CODE is the extension identifier.
const BUILDER_CODE = "builder-code"

// ERC_8021_MARKER is the 16-byte (hex) marker appended at the end of every suffix.
const ERC_8021_MARKER = "80218021802180218021802180218021"

// SCHEMA_2_ID is the ERC-8021 Schema 2 identifier byte.
const SCHEMA_2_ID = 0x02

// BUILDER_CODE_PATTERN matches valid builder codes: 1-32 lowercase alphanumeric
// characters and underscores.
var BUILDER_CODE_PATTERN = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)

// MAX_SERVICE_CODES is the maximum number of service codes (`s`) encoded onchain
// at settlement.
const MAX_SERVICE_CODES = 5

// BuilderCodeExtensionData holds the ERC-8021 Schema 2 fields as they appear in
// PaymentRequired/PaymentPayload extensions.
//   - A: app builder code — the x402 service that exposed the paid endpoint.
//   - W: wallet builder code — the facilitator that settled the payment on-chain.
//   - S: service builder codes — client-provided attribution codes (encoded as an
//     array on wire).
type BuilderCodeExtensionData struct {
	A string   `json:"a,omitempty"`
	W string   `json:"w,omitempty"`
	S []string `json:"s,omitempty"`
}

// validateCode reports whether code matches BUILDER_CODE_PATTERN.
func validateCode(code string) bool {
	return BUILDER_CODE_PATTERN.MatchString(code)
}
