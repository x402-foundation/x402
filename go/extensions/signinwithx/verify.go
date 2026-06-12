package signinwithx

import (
	"context"
	"fmt"
	"strings"
)

// VerifySignature verifies a payload's signature cryptographically, routing by
// the chainId namespace. It reconstructs the signed message from the payload
// fields, so callers should ValidateMessage first to bind domain, URI, nonce,
// and timestamps. EVM defaults to EOA; pass VerifyOptions.EVMVerifier for
// smart-wallet support.
func VerifySignature(ctx context.Context, p Payload, opts *VerifyOptions) VerifyResult {
	message, err := CreateMessage(p.ChainID, fieldsFromPayload(p))
	if err != nil {
		return VerifyResult{Error: err.Error()}
	}
	switch {
	case strings.HasPrefix(p.ChainID, "eip155:"):
		return verifyEVM(ctx, message, p, opts)
	case strings.HasPrefix(p.ChainID, "solana:"):
		return verifySolana(message, p)
	default:
		return VerifyResult{Error: fmt.Sprintf("unsupported chain namespace: %s", p.ChainID)}
	}
}

// Verify validates the payload fields against the expected resource URI and
// then verifies the signature. It is the one-call server entry point: a valid
// result means the wallet in res.Address proved control of its key over a
// fresh, domain-bound challenge. Pass valOpts to enforce nonce uniqueness or a
// custom max age; pass verOpts (or nil for EOA-only) to control EVM signature
// verification.
func Verify(ctx context.Context, p Payload, expectedResourceURI string, valOpts ValidationOptions, verOpts *VerifyOptions) VerifyResult {
	if res := ValidateMessage(p, expectedResourceURI, valOpts); !res.Valid {
		return VerifyResult{Error: res.Error}
	}
	return VerifySignature(ctx, p, verOpts)
}
