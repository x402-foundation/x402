package server_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/server"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestBatchSettlementServerDelegatedReceiverAuthorizer(t *testing.T) {
	t.Run("fails startup without a local signer or an advertised key", func(t *testing.T) {
		facilitatorKey := newTestSigner(t)
		delegated := server.NewBatchSvmScheme(nil)
		err := delegated.ValidateFacilitatorSupport(svm.SolanaDevnetCAIP2, supportedKind(map[string]any{
			"feePayer": facilitatorKey.Address().String(),
		}), nil)
		require.Error(t, err)
		assert.Regexp(t, "receiverAuthorizer", err.Error())

		err = delegated.ValidateFacilitatorSupport(svm.SolanaDevnetCAIP2, supportedKind(map[string]any{
			"feePayer":           facilitatorKey.Address().String(),
			"receiverAuthorizer": facilitatorKey.Address().String(),
		}), nil)
		assert.NoError(t, err)

		enhanced, err := delegated.EnhancePaymentRequirements(context.Background(), delegatedRequirements(), supportedKind(map[string]any{
			"feePayer":           facilitatorKey.Address().String(),
			"receiverAuthorizer": facilitatorKey.Address().String(),
		}), nil)
		require.NoError(t, err)
		assert.Equal(t, facilitatorKey.Address().String(), enhanced.Extra["receiverAuthorizer"])

		_, err = delegated.EnhancePaymentRequirements(context.Background(), delegatedRequirements(), supportedKind(map[string]any{
			"feePayer": facilitatorKey.Address().String(),
		}), nil)
		require.Error(t, err)
		assert.Regexp(t, "valid extra.receiverAuthorizer", err.Error())
	})

	t.Run("prefers the local signer when the facilitator advertises a different key", func(t *testing.T) {
		local := newTestSigner(t)
		other := newTestSigner(t)
		resourceServer := server.NewBatchSvmScheme(&server.Config{ReceiverAuthorizer: local})
		err := resourceServer.ValidateFacilitatorSupport(svm.SolanaDevnetCAIP2, supportedKind(map[string]any{
			"feePayer": other.Address().String(),
		}), nil)
		assert.NoError(t, err)

		enhanced, err := resourceServer.EnhancePaymentRequirements(context.Background(), delegatedRequirements(), supportedKind(map[string]any{
			"feePayer":           other.Address().String(),
			"receiverAuthorizer": other.Address().String(),
		}), nil)
		require.NoError(t, err)
		assert.Equal(t, other.Address().String(), enhanced.Extra["feePayer"])
		assert.Equal(t, local.Address().String(), enhanced.Extra["receiverAuthorizer"])
	})
}

func delegatedRequirements() types.PaymentRequirements {
	return types.PaymentRequirements{
		Amount:            "1000",
		Asset:             svm.USDCDevnetAddress,
		MaxTimeoutSeconds: 300,
		Network:           svm.SolanaDevnetCAIP2,
		PayTo:             svm.USDCMainnetAddress,
		Scheme:            batchsettlement.Scheme,
	}
}

func supportedKind(extra map[string]any) types.SupportedKind {
	return types.SupportedKind{
		X402Version: 2,
		Scheme:      batchsettlement.Scheme,
		Network:     svm.SolanaDevnetCAIP2,
		Extra:       extra,
	}
}
