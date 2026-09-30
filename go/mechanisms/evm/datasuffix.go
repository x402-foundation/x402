package evm

import (
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/types"
)

// BuilderCodeKey is the extension key for the ERC-8021 builder-code extension.
// It is replicated here (rather than imported from the buildercode extension
// package) so the base evm mechanism stays a dependency-free leaf — the
// buildercode package defines its own matching public constant and imports
// evm, mirroring the TS shared/extensions BUILDER_CODE_KEY pattern.
const BuilderCodeKey = "builder-code"

// DataSuffixContext carries the settlement payload and requirements a
// facilitator extension inspects when building an ERC-8021 calldata suffix.
type DataSuffixContext struct {
	Payload      types.PaymentPayload
	Requirements types.PaymentRequirements
}

// BuilderCodeFacilitatorExtension is implemented by the builder-code facilitator
// extension. BuildDataSuffix returns the encoded ERC-8021 suffix for the given
// settlement, or nil when there is nothing to attribute.
type BuilderCodeFacilitatorExtension interface {
	x402.FacilitatorExtension
	BuildDataSuffix(ctx DataSuffixContext) ([]byte, error)
}

// ResolveDataSuffix fetches the builder-code facilitator extension from fctx
// and returns the data suffix it produces. Returns nil when fctx is nil, no
// matching extension is registered, or the extension produces no suffix.
func ResolveDataSuffix(fctx *x402.FacilitatorContext, ctx DataSuffixContext) ([]byte, error) {
	if fctx == nil {
		return nil, nil
	}
	ext, ok := fctx.GetExtension(BuilderCodeKey).(BuilderCodeFacilitatorExtension)
	if !ok {
		return nil, nil
	}
	suffix, err := ext.BuildDataSuffix(ctx)
	if err != nil {
		return nil, err
	}
	if len(suffix) == 0 {
		return nil, nil
	}
	return suffix, nil
}

// AppendDataSuffix appends an ERC-8021 data suffix to ABI-encoded calldata,
// returning the calldata unchanged when suffix is empty. Signers call this after
// packing the call so the suffix lands on-chain. Mirrors TS appendDataSuffix.
func AppendDataSuffix(calldata, suffix []byte) []byte {
	if len(suffix) == 0 {
		return calldata
	}
	return append(append([]byte{}, calldata...), suffix...)
}
