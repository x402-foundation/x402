package buildercode

import (
	"context"
	"fmt"

	"github.com/x402-foundation/x402/go/v2/types"
)

// BuilderCodeClientExtension adds builder-code attribution to payment payloads
// by attaching the client's service code(s) (`s`). The core client merge
// preserves the server-declared app code (`a`) and schema after enrichment.
type BuilderCodeClientExtension struct {
	serviceCodes []string
}

// NewBuilderCodeClientExtension creates a client extension that attaches the
// given service code(s) to payments. It accepts one or more codes so layered
// clients (e.g. an MCP middleware) can attribute multiple participants.
//
// It panics when any serviceCode is not a valid builder code (1-32 lowercase
// alphanumeric and underscore characters) or when more than
// MAX_CLIENT_SERVICE_CODES are provided.
func NewBuilderCodeClientExtension(serviceCodes ...string) *BuilderCodeClientExtension {
	if len(serviceCodes) > MAX_CLIENT_SERVICE_CODES {
		panic(fmt.Sprintf("too many service codes: %d exceeds the maximum of %d", len(serviceCodes), MAX_CLIENT_SERVICE_CODES))
	}
	for _, code := range serviceCodes {
		if !validateCode(code) {
			panic(fmt.Sprintf("invalid builder code: %q. Must be 1-32 characters, lowercase alphanumeric and underscores only.", code))
		}
	}
	return &BuilderCodeClientExtension{serviceCodes: serviceCodes}
}

// Key returns the builder-code extension identifier.
func (e *BuilderCodeClientExtension) Key() string {
	return BUILDER_CODE
}

// EnrichPaymentPayload attaches this client's service code(s) (`s`). Core
// extension merging re-applies the server's advertised `a`/`schema` afterwards.
func (e *BuilderCodeClientExtension) EnrichPaymentPayload(
	_ context.Context,
	payload types.PaymentPayload,
	_ types.PaymentRequired,
) (types.PaymentPayload, error) {
	extensions := make(map[string]interface{}, len(payload.Extensions)+1)
	for k, v := range payload.Extensions {
		extensions[k] = v
	}
	extensions[BUILDER_CODE] = map[string]interface{}{
		"info": map[string]interface{}{"s": e.serviceCodes},
	}
	payload.Extensions = extensions
	return payload, nil
}
