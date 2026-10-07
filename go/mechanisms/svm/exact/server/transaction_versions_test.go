package server

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestEnhancePaymentRequirementsForwardsTransactionVersions(t *testing.T) {
	requirements := types.PaymentRequirements{
		Scheme:            "exact",
		Network:           "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
		Asset:             "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
		Amount:            "100000",
		PayTo:             "GsbwXfJraMomNxBcjK7xK2xQx5MQgQUF2k3wEX2Q9z3w",
		MaxTimeoutSeconds: 300,
	}

	t.Run("copies the facilitator's advertised versions", func(t *testing.T) {
		supportedKind := types.SupportedKind{
			X402Version: 2,
			Scheme:      "exact",
			Network:     requirements.Network,
			Extra: map[string]interface{}{
				"feePayer":                   "FeePay3r1111111111111111111111111111111111",
				svm.ExtraTransactionVersions: []interface{}{float64(0)},
			},
		}
		enhanced, err := NewExactSvmScheme().EnhancePaymentRequirements(context.Background(), requirements, supportedKind, nil)
		require.NoError(t, err)
		assert.Equal(t, []interface{}{float64(0)}, enhanced.Extra[svm.ExtraTransactionVersions])
	})

	t.Run("leaves the field absent for facilitators that predate it", func(t *testing.T) {
		supportedKind := types.SupportedKind{
			X402Version: 2,
			Scheme:      "exact",
			Network:     requirements.Network,
			Extra:       map[string]interface{}{"feePayer": "FeePay3r1111111111111111111111111111111111"},
		}
		enhanced, err := NewExactSvmScheme().EnhancePaymentRequirements(context.Background(), requirements, supportedKind, nil)
		require.NoError(t, err)
		assert.NotContains(t, enhanced.Extra, svm.ExtraTransactionVersions)
	})
}
