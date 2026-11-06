package server

import (
	"context"
	"errors"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestEnhancePaymentRequirementsRefusesUnadvertisedSplits(t *testing.T) {
	feePayer := solana.NewWallet().PublicKey().String()
	requirements := func(extra map[string]interface{}) types.PaymentRequirements {
		base := map[string]interface{}{
			"splits": []interface{}{
				map[string]interface{}{"payTo": solana.NewWallet().PublicKey().String(), "amount": "40000", "memo": "platform fee"},
				map[string]interface{}{"payTo": solana.NewWallet().PublicKey().String(), "amount": "10000"},
			},
		}
		for k, v := range extra {
			base[k] = v
		}
		return types.PaymentRequirements{
			Scheme: svm.SchemeExact, Network: svm.SolanaDevnetCAIP2, Asset: svm.USDCDevnetAddress,
			Amount: "1050000", PayTo: solana.NewWallet().PublicKey().String(), Extra: base,
		}
	}
	kind := func(extra map[string]interface{}) types.SupportedKind {
		base := map[string]interface{}{"feePayer": feePayer}
		for k, v := range extra {
			base[k] = v
		}
		return types.SupportedKind{X402Version: 2, Scheme: svm.SchemeExact, Network: svm.SolanaDevnetCAIP2, Extra: base}
	}
	reasonOf := func(err error) string {
		var se *svm.SplitsError
		require.True(t, errors.As(err, &se), "expected *svm.SplitsError, got %v", err)
		return se.Reason
	}
	server := NewExactSvmScheme()
	ctx := context.Background()

	_, err := server.EnhancePaymentRequirements(ctx, requirements(nil), kind(nil), nil)
	require.Error(t, err)
	assert.Equal(t, svm.ErrSplitCountExceeded, reasonOf(err))

	_, err = server.EnhancePaymentRequirements(ctx, requirements(nil), kind(map[string]interface{}{"maxSplits": "2"}), nil)
	require.Error(t, err)
	assert.Equal(t, svm.ErrSplitCountExceeded, reasonOf(err), "a non-integer maxSplits reads as 0")

	_, err = server.EnhancePaymentRequirements(ctx, requirements(map[string]interface{}{"ataCreationRequired": true}),
		kind(map[string]interface{}{"maxSplits": float64(2)}), nil)
	require.Error(t, err)
	assert.Equal(t, svm.ErrSplitAtaCreationNotAuthorized, reasonOf(err))

	_, err = server.EnhancePaymentRequirements(ctx, requirements(map[string]interface{}{
		"splits": []interface{}{map[string]interface{}{"payTo": "bad", "amount": "1"}},
	}), kind(map[string]interface{}{"maxSplits": 8}), nil)
	require.Error(t, err)
	assert.Equal(t, svm.ErrSplitsInvalid, reasonOf(err))

	enhanced, err := server.EnhancePaymentRequirements(ctx, requirements(nil), kind(map[string]interface{}{"maxSplits": 2}), nil)
	require.NoError(t, err)
	assert.Equal(t, feePayer, enhanced.Extra["feePayer"])

	enhanced, err = server.EnhancePaymentRequirements(ctx, requirements(map[string]interface{}{"ataCreationRequired": true}),
		kind(map[string]interface{}{"maxSplits": 2, "ataCreationSponsored": true}), nil)
	require.NoError(t, err)
	assert.Equal(t, true, enhanced.Extra["ataCreationRequired"])

	// Single-payee requirements are unaffected by a facilitator without split support.
	_, err = server.EnhancePaymentRequirements(ctx, requirements(map[string]interface{}{"splits": []interface{}{}}), kind(nil), nil)
	require.NoError(t, err)
}
