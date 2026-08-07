package buildercode

import (
	"fmt"

	evm "github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

// BuilderCodeFacilitatorExtension manages builder-code attribution at settlement
// time. When BuilderCode is set, it is encoded as the wallet code (`w`); the app
// code (`a`) and service code (`s`) are read from the client payment payload
// extensions. When ServiceCode is set, it is appended to `s` within the
// facilitator's own MAX_FACILITATOR_SERVICE_CODES reservation. It implements
// evm.BuilderCodeFacilitatorExtension so the base evm settle paths can resolve
// and append the ERC-8021 calldata suffix.
type BuilderCodeFacilitatorExtension struct {
	// BuilderCode is the facilitator's own wallet code (`w`), optional.
	BuilderCode string

	// ServiceCode is the facilitator's own service code, appended to the `s`
	// field at settlement when provided, within its own
	// MAX_FACILITATOR_SERVICE_CODES reservation. BuildDataSuffix returns an
	// error if this is set to an invalid builder code.
	ServiceCode string
}

// Ensure the extension satisfies the base evm facilitator-extension interface.
var _ evm.BuilderCodeFacilitatorExtension = (*BuilderCodeFacilitatorExtension)(nil)

// Key returns the builder-code extension identifier.
func (e *BuilderCodeFacilitatorExtension) Key() string {
	return BUILDER_CODE
}

// BuildDataSuffix builds the ERC-8021 Schema 2 calldata suffix for a settlement.
// `a` and `s` come from the client payment payload extensions; `w` is the
// facilitator's own code when configured. The facilitator's own `s` entry
// (ServiceCode) is appended after the echoed client/server codes, within its
// own MAX_FACILITATOR_SERVICE_CODES reservation. Returns an error when
// ServiceCode is set but is not a valid builder code. Returns nil when no
// attribution is present.
func (e *BuilderCodeFacilitatorExtension) BuildDataSuffix(ctx evm.DataSuffixContext) ([]byte, error) {
	clientExt := extractClientExtension(ctx.Payload.Extensions)

	data := BuilderCodeExtensionData{}
	if validateCode(e.BuilderCode) {
		data.W = e.BuilderCode
	}
	if a, ok := clientExt["a"].(string); ok && validateCode(a) {
		data.A = a
	}
	data.S = resolveServiceCodes(clientExt["s"])
	if e.ServiceCode != "" {
		if !validateCode(e.ServiceCode) {
			return nil, fmt.Errorf("invalid builder code %q: must be 1-32 characters, lowercase alphanumeric and underscores only", e.ServiceCode)
		}
		if !containsCode(data.S, e.ServiceCode) {
			data.S = append(data.S, e.ServiceCode)
		}
	}

	if data.A == "" && data.W == "" && len(data.S) == 0 {
		return nil, nil
	}

	return EncodeBuilderCodeSuffix(data)
}

// containsCode reports whether codes contains code.
func containsCode(codes []string, code string) bool {
	for _, c := range codes {
		if c == code {
			return true
		}
	}
	return false
}

// extractClientExtension returns the `info` object of the builder-code extension
// from payment-payload extensions, or nil if absent or malformed.
func extractClientExtension(extensions map[string]interface{}) map[string]interface{} {
	ext, ok := extensions[BUILDER_CODE].(map[string]interface{})
	if !ok {
		return nil
	}
	info, ok := ext["info"].(map[string]interface{})
	if !ok {
		return nil
	}
	return info
}

// maxEchoedServiceCodes is the maximum echoed client+server service codes,
// before the facilitator's own MAX_FACILITATOR_SERVICE_CODES reservation is
// appended. Each side already caps its own contribution
// (MAX_CLIENT_SERVICE_CODES, MAX_SERVER_SERVICE_CODES) at declaration time, so
// this bound is a defensive backstop against a malformed or hand-crafted
// payload rather than something a compliant client/server pair could ever hit.
const maxEchoedServiceCodes = MAX_CLIENT_SERVICE_CODES + MAX_SERVER_SERVICE_CODES

// resolveServiceCodes normalizes the client-provided `s` value, accepting a
// string, a []string, or a []interface{} (JSON-decoded), keeps valid entries in
// order, and truncates to maxEchoedServiceCodes. Returns nil when missing or all
// entries are invalid.
func resolveServiceCodes(raw interface{}) []string {
	var codes []string
	appendValid := func(s string) {
		if validateCode(s) {
			codes = append(codes, s)
		}
	}

	switch v := raw.(type) {
	case string:
		appendValid(v)
	case []string:
		for _, s := range v {
			appendValid(s)
		}
	case []interface{}:
		for _, item := range v {
			if s, ok := item.(string); ok {
				appendValid(s)
			}
		}
	}
	if len(codes) > maxEchoedServiceCodes {
		codes = codes[:maxEchoedServiceCodes]
	}
	return codes
}
