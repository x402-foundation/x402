package server

import (
	"context"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestEnhancePaymentRequirementsForwardsTransactionVersions(t *testing.T) {
	scheme, _ := newTestScheme(t)
	requirements := types.PaymentRequirements{
		Scheme:            svm.SchemeUpto,
		Network:           testNetwork,
		Amount:            "10000",
		Asset:             svm.USDCDevnetAddress,
		PayTo:             solana.SysVarRentPubkey.String(),
		MaxTimeoutSeconds: 600,
	}
	supportedKind := types.SupportedKind{
		Scheme:  svm.SchemeUpto,
		Network: testNetwork,
		Extra: map[string]interface{}{
			upto.ExtraFeePayer:            solana.SysVarClockPubkey.String(),
			upto.ExtraTransactionVersions: []interface{}{float64(0)},
		},
	}

	enhanced, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, supportedKind, nil)
	require.NoError(t, err)
	assert.Equal(t, []interface{}{float64(0)}, enhanced.Extra[upto.ExtraTransactionVersions])
}
