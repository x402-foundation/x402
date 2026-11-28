package facilitator

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestVerifySchemeMismatchReportsUnsupportedScheme(t *testing.T) {
	cases := map[string]func(string) (types.PaymentPayload, types.PaymentRequirements){
		"eip3009": func(a string) (types.PaymentPayload, types.PaymentRequirements) { return canonicalAmountEIP3009(a) },
		"permit2": func(a string) (types.PaymentPayload, types.PaymentRequirements) { return canonicalAmountPermit2(a) },
	}

	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			payload, requirements := build("1000")
			payload.Accepted.Scheme = "intent"
			scheme := NewExactEvmScheme(canonicalAmountSigner{}, nil)

			_, err := scheme.Verify(context.Background(), payload, requirements, nil)

			var reason *x402.VerifyError
			require.ErrorAs(t, err, &reason)
			assert.Equal(t, "unsupported_scheme", reason.InvalidReason)
		})
	}
}
