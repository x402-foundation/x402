package server_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/server"
	"github.com/x402-foundation/x402/go/v2/types"
)

type termsSubmission struct {
	payloadType  string
	channels     []string
	requirements types.PaymentRequirements
	payload      any
}

// termsRecorder records each request with the requirements it was authored against.
type termsRecorder struct {
	submissions []termsSubmission
}

func (r *termsRecorder) settle(_ context.Context, request server.RedemptionRequest, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
	payloadType, channels := redemptionFacts(request.Payload)
	r.submissions = append(r.submissions, termsSubmission{
		payloadType:  payloadType,
		channels:     channels,
		requirements: requirements,
		payload:      request.Payload,
	})
	if payloadType == batchsettlement.PayloadTypeSeal {
		response := okResponse()
		response.Amount = "3000"
		return response, nil
	}
	return boundDistribute(request.Payload), nil
}

func (r *termsRecorder) of(payloadType string) []termsSubmission {
	var out []termsSubmission
	for _, submission := range r.submissions {
		if submission.payloadType == payloadType {
			out = append(out, submission)
		}
	}
	return out
}

// termsFacilitator answers every redemption with a bare success and records its batch sizes.
type termsFacilitator struct {
	claims  []int
	settles []int
}

func (f *termsFacilitator) Verify(context.Context, []byte, []byte) (*x402.VerifyResponse, error) {
	return nil, nil
}

func (f *termsFacilitator) Settle(_ context.Context, payloadBytes, _ []byte) (*x402.SettleResponse, error) {
	var payment struct {
		Payload struct {
			Type     string `json:"type"`
			Claims   []any  `json:"claims"`
			Channels []any  `json:"channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(payloadBytes, &payment); err != nil {
		return nil, err
	}
	switch payment.Payload.Type {
	case batchsettlement.PayloadTypeClaim:
		f.claims = append(f.claims, len(payment.Payload.Claims))
	case batchsettlement.PayloadTypeSettle:
		f.settles = append(f.settles, len(payment.Payload.Channels))
	}
	return okResponse(), nil
}

func (f *termsFacilitator) GetSupported(context.Context) (x402.SupportedResponse, error) {
	return x402.SupportedResponse{}, nil
}

func redeemWithTerms(t *testing.T, store server.ChannelStore, recorder *termsRecorder, authorizer testSigner) {
	t.Helper()
	options := withPayout(managerOptions(store, authorizer, recorder.settle), 3000)
	_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
	require.NoError(t, err)
}

func TestBatchSettlementRedemptionTermsComeFromChannelState(t *testing.T) {
	receiverAuthorizer := newTestSigner(t)

	t.Run("redeems channels opened under different fee payers in one pass, one batch per fee payer", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		other := newChannel("chan-b")
		other.FeePayer = svm.USDCDevnetAddress
		require.NoError(t, store.Put(newChannel("chan-a")))
		require.NoError(t, store.Put(other))
		require.NoError(t, store.Put(newChannel("chan-c")))
		recorder := &termsRecorder{}

		redeemWithTerms(t, store, recorder, receiverAuthorizer)

		for _, payloadType := range []string{batchsettlement.PayloadTypeClaim, batchsettlement.PayloadTypeSettle} {
			submissions := recorder.of(payloadType)
			require.Len(t, submissions, 2, payloadType)
			assert.ElementsMatch(t, []string{"chan-a", "chan-c"}, submissions[0].channels, payloadType)
			assert.Equal(t, svm.USDCMainnetAddress, submissions[0].requirements.Extra[batchsettlement.ExtraFeePayer])
			assert.Equal(t, []string{"chan-b"}, submissions[1].channels, payloadType)
			assert.Equal(t, svm.USDCDevnetAddress, submissions[1].requirements.Extra[batchsettlement.ExtraFeePayer])
		}
		for _, id := range []string{"chan-a", "chan-b", "chan-c"} {
			stored, err := store.Get(id)
			require.NoError(t, err)
			assert.Equal(t, uint64(3000), stored.PayoutWatermark, id)
		}
	})

	for name, tc := range map[string]struct {
		mutate   func(*server.ChannelState)
		expected func(types.PaymentRequirements) bool
	}{
		"receiver": {
			mutate:   func(c *server.ChannelState) { c.Receiver = svm.TokenProgramAddress },
			expected: func(r types.PaymentRequirements) bool { return r.PayTo == svm.TokenProgramAddress },
		},
		"mint": {
			mutate:   func(c *server.ChannelState) { c.Mint = svm.USDCMainnetAddress },
			expected: func(r types.PaymentRequirements) bool { return r.Asset == svm.USDCMainnetAddress },
		},
		"token program": {
			mutate: func(c *server.ChannelState) { c.TokenProgram = svm.Token2022ProgramAddress },
			expected: func(r types.PaymentRequirements) bool {
				return r.Extra[batchsettlement.ExtraTokenProgram] == svm.Token2022ProgramAddress
			},
		},
		"withdraw delay": {
			mutate: func(c *server.ChannelState) { c.WithdrawDelay = 1800 },
			expected: func(r types.PaymentRequirements) bool {
				return r.Extra[batchsettlement.ExtraWithdrawDelay] == 1800
			},
		},
	} {
		t.Run("never mixes channels with a different "+name+" in one batch", func(t *testing.T) {
			store := server.NewMemoryChannelStore()
			other := newChannel("chan-b")
			tc.mutate(&other)
			require.NoError(t, store.Put(newChannel("chan-a")))
			require.NoError(t, store.Put(other))
			recorder := &termsRecorder{}

			redeemWithTerms(t, store, recorder, receiverAuthorizer)

			claims := recorder.of(batchsettlement.PayloadTypeClaim)
			require.Len(t, claims, 2)
			assert.Equal(t, []string{"chan-a"}, claims[0].channels)
			assert.Equal(t, []string{"chan-b"}, claims[1].channels)
			assert.True(t, tc.expected(claims[1].requirements), "%+v", claims[1].requirements)
		})
	}

	t.Run("authors requirements from stored channel state", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		recorder := &termsRecorder{}

		redeemWithTerms(t, store, recorder, receiverAuthorizer)

		require.NotEmpty(t, recorder.submissions)
		assert.Equal(t, types.PaymentRequirements{
			Scheme:            batchsettlement.Scheme,
			Network:           svm.SolanaDevnetCAIP2,
			Asset:             svm.USDCDevnetAddress,
			Amount:            "0",
			PayTo:             svm.USDCMainnetAddress,
			MaxTimeoutSeconds: 300,
			Extra: map[string]interface{}{
				batchsettlement.ExtraFeePayer:           svm.USDCMainnetAddress,
				batchsettlement.ExtraTokenProgram:       svm.TokenProgramAddress,
				batchsettlement.ExtraWithdrawDelay:      900,
				batchsettlement.ExtraReceiverAuthorizer: svm.TokenProgramAddress,
			},
		}, recorder.submissions[0].requirements)
	})

	t.Run("names the operator for a server-signed channel", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		state := newChannel("chan-a")
		state.ChannelConfig.VoucherSigner = batchsettlement.VoucherSignerServer
		require.NoError(t, store.Put(state))
		recorder := &termsRecorder{}

		redeemWithTerms(t, store, recorder, receiverAuthorizer)

		extra := recorder.submissions[0].requirements.Extra
		assert.Equal(t, svm.USDCDevnetAddress, extra[batchsettlement.ExtraOperator])
		assert.Equal(t, batchsettlement.VoucherSignerServer, extra[batchsettlement.ExtraVoucherSigner])
	})

	t.Run("bounds the seal authorization by the redemption timeout", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		closing := newChannel(svm.USDCDevnetAddress)
		closing.Status = server.ChannelStatusClosing
		require.NoError(t, store.Put(closing))
		recorder := &termsRecorder{}

		before := time.Now().Unix()
		redeemWithTerms(t, store, recorder, receiverAuthorizer)

		seals := recorder.of(batchsettlement.PayloadTypeSeal)
		require.Len(t, seals, 1)
		seal := seals[0].payload.(batchsettlement.BatchSealPayload)
		require.NotNil(t, seal.CloseAuthorization)
		assert.Equal(t, 300, seals[0].requirements.MaxTimeoutSeconds)
		assert.GreaterOrEqual(t, seal.CloseAuthorization.ValidBefore, before+300)
		assert.LessOrEqual(t, seal.CloseAuthorization.ValidBefore, time.Now().Unix()+300)
	})
}

func TestBatchSettlementChannelManagerUsesFacilitatorCapacity(t *testing.T) {
	supportedKind := func(extra map[string]any) types.SupportedKind {
		merged := map[string]any{
			batchsettlement.ExtraFeePayer:           svm.USDCMainnetAddress,
			batchsettlement.ExtraReceiverAuthorizer: svm.TokenProgramAddress,
		}
		for key, value := range extra {
			merged[key] = value
		}
		return types.SupportedKind{Scheme: batchsettlement.Scheme, Network: svm.SolanaDevnetCAIP2, Extra: merged}
	}
	redeemFive := func(t *testing.T, extra map[string]any) *termsFacilitator {
		t.Helper()
		scheme := server.NewBatchSvmScheme(&server.Config{Store: server.NewMemoryChannelStore()})
		for _, id := range []string{"a", "b", "c", "d", "e"} {
			require.NoError(t, scheme.GetChannelStore().Put(newChannel("chan-"+id)))
		}
		if extra != nil {
			require.NoError(t, scheme.ValidateFacilitatorSupport(svm.SolanaDevnetCAIP2, supportedKind(extra), nil))
		}
		facilitator := &termsFacilitator{}
		manager := scheme.CreateChannelManager(facilitator, svm.SolanaDevnetCAIP2, server.BatchChannelManagerConfig{
			ReadPayoutWatermark:  func(context.Context, string) (uint64, bool, error) { return 3000, true, nil },
			ReadSettledWatermark: func(context.Context, string) (uint64, bool, error) { return 3000, true, nil },
		})
		_, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		return facilitator
	}

	t.Run("uses four per batch before the scheme has seen /supported", func(t *testing.T) {
		facilitator := redeemFive(t, nil)
		assert.Equal(t, []int{4, 1}, facilitator.claims)
		assert.Equal(t, []int{4, 1}, facilitator.settles)
	})

	t.Run("uses the capacity advertised for the network", func(t *testing.T) {
		// JSON-decoded /supported numbers arrive as float64.
		facilitator := redeemFive(t, map[string]any{
			batchsettlement.ExtraMaxClaimChannels:  float64(2),
			batchsettlement.ExtraMaxSettleChannels: float64(3),
		})
		assert.Equal(t, []int{2, 2, 1}, facilitator.claims)
		assert.Equal(t, []int{3, 2}, facilitator.settles)
	})

	for _, value := range []any{"18", 0, -3, 2.5, nil} {
		t.Run("falls back to four for an invalid advertised capacity", func(t *testing.T) {
			facilitator := redeemFive(t, map[string]any{batchsettlement.ExtraMaxClaimChannels: value})
			assert.Equal(t, []int{4, 1}, facilitator.claims, "%v", value)
		})
	}
}
