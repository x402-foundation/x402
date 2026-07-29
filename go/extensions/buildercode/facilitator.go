package buildercode

import (
	evm "github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

// BuilderCodeFacilitatorExtension manages builder-code attribution at settlement
// time. When BuilderCode is set, it is encoded as the wallet code (`w`); the app
// code (`a`) and service code (`s`) are read from the client payment payload
// extensions. It implements evm.BuilderCodeFacilitatorExtension so the base evm
// settle paths can resolve and append the ERC-8021 calldata suffix.
type BuilderCodeFacilitatorExtension struct {
	// BuilderCode is the facilitator's own wallet code (`w`), optional.
	BuilderCode string
}

// Ensure the extension satisfies the base evm facilitator-extension interface.
var _ evm.BuilderCodeFacilitatorExtension = (*BuilderCodeFacilitatorExtension)(nil)

// Key returns the builder-code extension identifier.
func (e *BuilderCodeFacilitatorExtension) Key() string {
	return BUILDER_CODE
}

// BuildDataSuffix builds the ERC-8021 Schema 2 calldata suffix for a settlement.
// `a` and `s` come from the client payment payload extensions; `w` is the
// facilitator's own code when configured. Returns nil when no attribution is present.
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

	if data.A == "" && data.W == "" && len(data.S) == 0 {
		return nil, nil
	}

	return EncodeBuilderCodeSuffix(data)
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

// resolveServiceCodes normalizes the client-provided `s` value, accepting a
// string, a []string, or a []interface{} (JSON-decoded), keeps valid entries in
// order, and truncates to MAX_SERVICE_CODES. Returns nil when missing or all
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
	if len(codes) > MAX_SERVICE_CODES {
		codes = codes[:MAX_SERVICE_CODES]
	}
	return codes
}
