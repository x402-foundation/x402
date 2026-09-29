// Package buildercode provides types and helpers for the Builder Code Extension (ERC-8021).
//
// The extension enables attribution tracking for x402 payments by appending
// ERC-8021 Schema 2 builder codes to settlement transaction calldata. Three
// parties attach their builder code, each with its own dedicated, non-overlapping
// reservation in "s" so that no party can crowd out another's entries:
//   - Server: declares "a" (app), and optionally up to MAX_SERVER_SERVICE_CODES of
//     its own "s" (service) code(s), in the 402 response via DeclareBuilderCodeExtension.
//   - Client: adds up to MAX_CLIENT_SERVICE_CODES of "s" (service) via
//     NewBuilderCodeClientExtension; when the server also declared "s", the core
//     client merges both (client first).
//   - Facilitator: optionally adds "w" (wallet) at settlement via
//     BuilderCodeFacilitatorExtension, and may append its own "s" entry (up to
//     MAX_FACILITATOR_SERVICE_CODES) via BuilderCodeFacilitatorExtension.ServiceCode.
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

const (
	// MAX_CLIENT_SERVICE_CODES is the maximum client-provided service codes
	// reserved in the `s` array. Enforced by NewBuilderCodeClientExtension
	// independently of the server's reservation so one side can never crowd out
	// the other.
	MAX_CLIENT_SERVICE_CODES = 5

	// MAX_SERVER_SERVICE_CODES is the maximum server-declared service codes
	// reserved in the `s` array. Enforced by DeclareBuilderCodeExtension
	// independently of the client's reservation so one side can never crowd out
	// the other.
	MAX_SERVER_SERVICE_CODES = 5

	// MAX_FACILITATOR_SERVICE_CODES is the maximum facilitator-appended service
	// codes reserved in the `s` array. Enforced by BuilderCodeFacilitatorExtension
	// for its own ServiceCode field.
	MAX_FACILITATOR_SERVICE_CODES = 1

	// MAX_SERVICE_CODES is the maximum number of service codes (`s`) encoded
	// onchain at settlement — the sum of each side's dedicated reservation
	// (MAX_CLIENT_SERVICE_CODES, MAX_SERVER_SERVICE_CODES, MAX_FACILITATOR_SERVICE_CODES).
	MAX_SERVICE_CODES = MAX_CLIENT_SERVICE_CODES + MAX_SERVER_SERVICE_CODES + MAX_FACILITATOR_SERVICE_CODES
)

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
