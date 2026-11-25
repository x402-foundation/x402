package server

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

// Processes of one server copy /supported at their own times, so the process
// that receives a payment may hold a different redemption capacity than the
// one that issued its 402.
func TestFindMatchingRequirementsIgnoresCopiedRedemptionCapacity(t *testing.T) {
	f := newLifecycleFixture(t)
	scheme := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer})
	enhance := func(capacity map[string]any) types.PaymentRequirements {
		t.Helper()
		extra := map[string]any{batchsettlement.ExtraFeePayer: f.feePayer.Address().String()}
		for key, value := range capacity {
			extra[key] = value
		}
		enhanced, err := scheme.EnhancePaymentRequirements(
			context.Background(),
			f.requirements(),
			types.SupportedKind{Network: svm.SolanaDevnetCAIP2, Scheme: batchsettlement.Scheme, X402Version: 2, Extra: extra},
			nil,
		)
		require.NoError(t, err)
		return enhanced
	}
	absent := enhance(nil)
	small := enhance(map[string]any{batchsettlement.ExtraMaxClaimChannels: 4, batchsettlement.ExtraMaxSettleChannels: 4})
	larger := enhance(map[string]any{batchsettlement.ExtraMaxClaimChannels: 18, batchsettlement.ExtraMaxSettleChannels: 13})
	require.Equal(t, 18, larger.Extra[batchsettlement.ExtraMaxClaimChannels])

	resourceServer := x402.Newx402ResourceServer(x402.WithSchemeServer(x402.Network(svm.SolanaDevnetCAIP2), scheme))
	// accepted arrives as JSON, as it would from a client.
	paying := func(accepted types.PaymentRequirements) types.PaymentPayload {
		t.Helper()
		raw, err := json.Marshal(accepted)
		require.NoError(t, err)
		var decoded types.PaymentRequirements
		require.NoError(t, json.Unmarshal(raw, &decoded))
		return types.PaymentPayload{X402Version: 2, Accepted: decoded}
	}
	for _, pair := range [][2]types.PaymentRequirements{
		{absent, larger},
		{larger, absent},
		{small, larger},
		{larger, small},
	} {
		issued, held := pair[0], pair[1]
		matched := resourceServer.FindMatchingRequirements([]types.PaymentRequirements{held}, paying(issued))
		require.NotNil(t, matched, "issued %v, held %v", issued.Extra, held.Extra)
	}

	// Every other field is still compared.
	otherFeePayer := enhance(map[string]any{batchsettlement.ExtraMaxClaimChannels: 18, batchsettlement.ExtraMaxSettleChannels: 13})
	otherFeePayer.Extra[batchsettlement.ExtraFeePayer] = f.payer.Address().String()
	require.Nil(t, resourceServer.FindMatchingRequirements([]types.PaymentRequirements{otherFeePayer}, paying(small)))
}
