package server_test

import (
	"context"
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

func TestBatchSettlementRedemptionWorkerEdgeCases(t *testing.T) {
	receiverAuthorizer := newTestSigner(t)

	t.Run("refuses a store that cannot enumerate its channels", func(t *testing.T) {
		manager := server.NewBatchChannelManager(server.BatchChannelManagerConfig{
			ReceiverAuthorizer: receiverAuthorizer,
			Requirements:       managerRequirements(),
			Settle: func(context.Context, server.RedemptionRequest, types.PaymentRequirements) (*x402.SettleResponse, error) {
				return okResponse(), nil
			},
			Store: unlistableStore{},
		})
		_, err := manager.Redeem(context.Background())
		require.Error(t, err)
		assert.Regexp(t, "can list its channels", err.Error())
	})

	t.Run("claims a voucher without an expiry as a non-expiring one", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		state := newChannel("chan-a")
		state.HighestVoucherExpiresAt = 0
		require.NoError(t, store.Put(state))
		recorder := recordingSettler(boundDistribute)
		options := withPayout(managerOptions(store, receiverAuthorizer, recorder.settle), 3000)
		_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		require.NotEmpty(t, recorder.payloads)
		claim := recorder.payloads[0].(batchsettlement.BatchClaimPayload)
		assert.Equal(t, int64(0), claim.Claims[0].Voucher.ExpiresAt)
	})

	t.Run("reports unknown reasons and leaves the work for the next pass", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		backlog := newChannel("chan-b")
		backlog.Settled = 3000
		backlog.HighestVoucherSignature = ""
		require.NoError(t, store.Put(backlog))
		var errors []string
		result, err := server.NewBatchChannelManager(server.BatchChannelManagerConfig{
			OnError:            func(err error) { errors = append(errors, err.Error()) },
			ReceiverAuthorizer: receiverAuthorizer,
			Requirements:       managerRequirements(),
			Settle: func(context.Context, server.RedemptionRequest, types.PaymentRequirements) (*x402.SettleResponse, error) {
				return &x402.SettleResponse{Network: svm.SolanaDevnetCAIP2, Success: false}, nil
			},
			Store: store,
		}).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, server.RedemptionResult{Claimed: []string{}, Distributed: []string{}, Sealed: []string{}}, result)
		assert.Equal(t, []string{
			"batch-settlement claim failed: unknown",
			"batch-settlement distribute failed: unknown",
		}, errors)
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(0), stored.Settled)
	})

	t.Run("does not record a distribution whose response is unbound or malformed", func(t *testing.T) {
		mismatch := "batch-settlement distribute response channel mismatch"
		answers := []struct {
			response *x402.SettleResponse
			expected string
		}{
			{&x402.SettleResponse{Success: true, Transaction: "sig", Network: "solana:other", Extra: map[string]any{"channels": []any{"chan-a"}}}, "batch-settlement distribute response bound to another network"},
			{&x402.SettleResponse{Success: true, Transaction: "sig", Network: svm.SolanaDevnetCAIP2, Extra: map[string]any{"channels": "chan-a"}}, mismatch},
			{&x402.SettleResponse{Success: true, Transaction: "sig", Network: svm.SolanaDevnetCAIP2, Extra: map[string]any{"channels": []any{"chan-a", "chan-a"}}}, mismatch},
			{&x402.SettleResponse{Success: true, Transaction: "sig", Network: svm.SolanaDevnetCAIP2, Extra: map[string]any{"channels": []any{"chan-b"}}}, mismatch},
		}
		for _, answer := range answers {
			store := server.NewMemoryChannelStore()
			state := newChannel("chan-a")
			state.Settled = 3000
			state.HighestVoucherSignature = ""
			require.NoError(t, store.Put(state))
			var errors []string
			options := withPayout(managerOptions(store, receiverAuthorizer, func(context.Context, server.RedemptionRequest, types.PaymentRequirements) (*x402.SettleResponse, error) {
				return answer.response, nil
			}), 3000)
			options.OnError = func(err error) { errors = append(errors, err.Error()) }
			result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
			require.NoError(t, err)
			assert.Empty(t, result.Distributed)
			assert.Equal(t, []string{answer.expected}, errors)
			stored, err := store.Get("chan-a")
			require.NoError(t, err)
			assert.Equal(t, uint64(0), stored.PayoutWatermark)
		}
	})

	t.Run("reconciles from the chain when a facilitator answers with the spec's bare responses", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		var errors []error
		options := managerOptions(store, receiverAuthorizer, func(context.Context, server.RedemptionRequest, types.PaymentRequirements) (*x402.SettleResponse, error) {
			return okResponse(), nil
		})
		options.OnError = func(err error) { errors = append(errors, err) }
		options.ReadPayoutWatermark = func(context.Context, string) (uint64, bool, error) { return 3000, true, nil }
		options.ReadSettledWatermark = func(context.Context, string) (uint64, bool, error) { return 3000, true, nil }
		result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Empty(t, errors)
		assert.Equal(t, server.RedemptionResult{Claimed: []string{"chan-a"}, Distributed: []string{"chan-a"}, Sealed: []string{}}, result)
		state, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(3000), state.Settled)
		assert.Equal(t, uint64(3000), state.PayoutWatermark)
	})

	t.Run("leaves a bare-response claim unrecorded until the chain shows the watermark", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		var errors []string
		options := managerOptions(store, receiverAuthorizer, func(context.Context, server.RedemptionRequest, types.PaymentRequirements) (*x402.SettleResponse, error) {
			return okResponse(), nil
		})
		options.OnError = func(err error) { errors = append(errors, err.Error()) }
		options.ReadPayoutWatermark = func(context.Context, string) (uint64, bool, error) { return 0, true, nil }
		options.ReadSettledWatermark = func(context.Context, string) (uint64, bool, error) { return 2999, true, nil }
		result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Empty(t, result.Claimed)
		assert.Equal(t, []string{"confirmed settled watermark unavailable or behind the claim"}, errors)
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(0), stored.Settled)
	})

	t.Run("caps a configured batch size at the spec's four channels", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		for _, id := range []string{"a", "b", "c", "d", "e"} {
			require.NoError(t, store.Put(newChannel("chan-"+id)))
		}
		recorder := recordingSettler(boundDistribute)
		options := withPayout(managerOptions(store, receiverAuthorizer, recorder.settle), 3000)
		options.MaxChannelsPerBatch = 8
		_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		var lengths []int
		for _, payload := range recorder.payloads {
			claim, ok := payload.(batchsettlement.BatchClaimPayload)
			if !ok {
				continue
			}
			lengths = append(lengths, len(claim.Claims))
		}
		assert.Equal(t, []int{4, 1}, lengths)
	})

	t.Run("seals a closing channel with its latest voucher when a claim reports channel_closing", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		openID := svm.TokenProgramAddress
		closingID := svm.USDCDevnetAddress
		require.NoError(t, store.Put(newChannel(openID)))
		require.NoError(t, store.Put(newChannel(closingID)))
		var seen []any
		settle := func(_ context.Context, request server.RedemptionRequest, _ types.PaymentRequirements) (*x402.SettleResponse, error) {
			seen = append(seen, request.Payload)
			switch payload := request.Payload.(type) {
			case batchsettlement.BatchClaimPayload:
				for _, claim := range payload.Claims {
					if claim.Voucher.ChannelID == closingID {
						return &x402.SettleResponse{Network: svm.SolanaDevnetCAIP2, Success: false, ErrorReason: batchsettlement.ErrChannelClosing}, nil
					}
				}
				return okResponse(), nil
			case batchsettlement.BatchSealPayload:
				response := okResponse()
				response.Amount = "3000"
				return response, nil
			default:
				return boundDistribute(request.Payload), nil
			}
		}
		options := managerOptions(store, receiverAuthorizer, settle)
		options.ReadPayoutWatermark = func(context.Context, string) (uint64, bool, error) { return 3000, true, nil }
		options.ReadSettledWatermark = func(context.Context, string) (uint64, bool, error) { return 3000, true, nil }
		result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{openID}, result.Claimed)
		assert.Equal(t, []string{closingID}, result.Sealed)
		assert.Equal(t, []string{"claim", "claim", "claim", "seal", "settle"}, payloadTypeList(seen))
		var seal batchsettlement.BatchSealPayload
		for _, payload := range seen {
			if typed, ok := payload.(batchsettlement.BatchSealPayload); ok {
				seal = typed
			}
		}
		assert.Equal(t, closingID, seal.ChannelID)
		assert.Equal(t, int64(0), seal.Voucher.ExpiresAt)
		assert.Equal(t, "3000", seal.Voucher.MaxClaimableAmount)
		assert.Equal(t, "sig-"+closingID, seal.Voucher.Signature)
		require.NotNil(t, seal.CloseAuthorization)
		assert.True(t, batchsettlement.VerifyCloseAuthorization(*seal.CloseAuthorization, batchsettlement.CloseAuthorizationBinding{
			ChannelID:          closingID,
			FeePayer:           svm.USDCMainnetAddress,
			MaxClaimableAmount: batchsettlement.BigU64(3000),
			Network:            svm.SolanaDevnetCAIP2,
			VoucherExpiresAt:   0,
		}, receiverAuthorizer.Address().String(), 300, time.Now().Unix()))
		stored, err := store.Get(closingID)
		require.NoError(t, err)
		assert.Equal(t, uint64(3000), stored.PayoutWatermark)
		assert.Equal(t, uint64(3000), stored.Settled)
		assert.Equal(t, server.ChannelStatusDistributed, stored.Status)
		openState, err := store.Get(openID)
		require.NoError(t, err)
		assert.Equal(t, server.ChannelStatusOpen, openState.Status)
	})

	t.Run("marks a channel closing and retries its seal after a transient failure", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		id := newTestSigner(t).Address().String()
		require.NoError(t, store.Put(newChannel(id)))
		var errors []string
		var seen []string
		sealAnswer := &x402.SettleResponse{ErrorReason: "settlement_pending", Network: svm.SolanaDevnetCAIP2, Success: false}
		manager := server.NewBatchChannelManager(withPayout(server.BatchChannelManagerConfig{
			OnError:            func(err error) { errors = append(errors, err.Error()) },
			ReceiverAuthorizer: receiverAuthorizer,
			Requirements:       managerRequirements(),
			Settle: func(_ context.Context, request server.RedemptionRequest, _ types.PaymentRequirements) (*x402.SettleResponse, error) {
				payloadType, _ := redemptionFacts(request.Payload)
				seen = append(seen, payloadType)
				if payloadType == batchsettlement.PayloadTypeSeal {
					return sealAnswer, nil
				}
				return &x402.SettleResponse{Network: svm.SolanaDevnetCAIP2, Success: false, ErrorReason: batchsettlement.ErrChannelClosing}, nil
			},
			Store: store,
		}, 3000))
		result, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, server.RedemptionResult{Claimed: []string{}, Distributed: []string{}, Sealed: []string{}}, result)
		assert.Equal(t, []string{"batch-settlement seal failed: settlement_pending"}, errors)
		stored, err := store.Get(id)
		require.NoError(t, err)
		assert.Equal(t, server.ChannelStatusClosing, stored.Status)

		sealAnswer = okResponse()
		result, err = manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, server.RedemptionResult{Claimed: []string{}, Distributed: []string{}, Sealed: []string{id}}, result)
		assert.Equal(t, []string{"claim", "seal", "seal"}, seen)
		stored, err = store.Get(id)
		require.NoError(t, err)
		assert.Equal(t, uint64(3000), stored.Settled)
		assert.Equal(t, server.ChannelStatusDistributed, stored.Status)
	})

	t.Run("does not seal once the grace period has elapsed", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		id := newTestSigner(t).Address().String()
		state := newChannel(id)
		state.CloseRequestedAt = time.Now().Unix() - 900
		state.Status = server.ChannelStatusClosing
		require.NoError(t, store.Put(state))
		var errors []string
		var seen []string
		manager := server.NewBatchChannelManager(server.BatchChannelManagerConfig{
			OnError: func(err error) { errors = append(errors, err.Error()) },
			ReadPayoutWatermark: func(context.Context, string) (uint64, bool, error) {
				return 0, true, nil
			},
			ReceiverAuthorizer: receiverAuthorizer,
			Requirements:       managerRequirements(),
			Settle: func(_ context.Context, request server.RedemptionRequest, _ types.PaymentRequirements) (*x402.SettleResponse, error) {
				payloadType, _ := redemptionFacts(request.Payload)
				seen = append(seen, payloadType)
				return okResponse(), nil
			},
			Store: store,
		})
		_, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		result, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, server.RedemptionResult{Claimed: []string{}, Distributed: []string{}, Sealed: []string{}}, result)
		assert.Empty(t, seen)
		require.Len(t, errors, 1)
		assert.Regexp(t, "grace period elapsed", errors[0])
		stored, err := store.Get(id)
		require.NoError(t, err)
		assert.Equal(t, uint64(0), stored.Settled)
		assert.Equal(t, server.ChannelStatusClosing, stored.Status)
	})

	t.Run("never lowers watermarks the store already advanced past", func(t *testing.T) {
		inner := server.NewMemoryChannelStore()
		store := boostingStore{inner: inner}
		require.NoError(t, store.Put(func() server.ChannelState {
			state := newChannel("chan-a")
			state.PayoutWatermark = 1000
			return state
		}()))
		recorder := recordingSettler(boundDistribute)
		options := withPayout(managerOptions(store, receiverAuthorizer, recorder.settle), 2000)
		result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{"chan-a"}, result.Claimed)
		assert.Empty(t, result.Distributed)
		state, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(5000), state.Settled)
		assert.Equal(t, uint64(2500), state.PayoutWatermark)
	})

	t.Run("surfaces a channel that vanished between the snapshot and the record", func(t *testing.T) {
		inner := server.NewMemoryChannelStore()
		store := vanishingStore{inner: inner}
		require.NoError(t, store.Put(newChannel("chan-a")))
		recorder := recordingSettler(boundDistribute)
		_, err := server.NewBatchChannelManager(withPayout(managerOptions(store, receiverAuthorizer, recorder.settle), 0)).Redeem(context.Background())
		require.Error(t, err)
		assert.Regexp(t, "vanished mid-redemption", err.Error())
	})

	t.Run("seals a closing channel without closeAuthorization when no signer is configured", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		id := newTestSigner(t).Address().String()
		closing := newChannel(id)
		closing.Status = server.ChannelStatusClosing
		require.NoError(t, store.Put(closing))
		var seen []any
		options := managerOptions(store, testSigner{}, func(_ context.Context, request server.RedemptionRequest, _ types.PaymentRequirements) (*x402.SettleResponse, error) {
			seen = append(seen, request.Payload)
			return okResponse(), nil
		})
		options.ReceiverAuthorizer = nil
		options.ReadPayoutWatermark = func(context.Context, string) (uint64, bool, error) { return 3000, true, nil }
		options.ReadSettledWatermark = func(context.Context, string) (uint64, bool, error) { return 3000, true, nil }
		result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{id}, result.Sealed)
		var seal batchsettlement.BatchSealPayload
		found := false
		for _, payload := range seen {
			if typed, ok := payload.(batchsettlement.BatchSealPayload); ok {
				seal = typed
				found = true
			}
		}
		require.True(t, found)
		assert.Equal(t, id, seal.ChannelID)
		assert.Equal(t, batchsettlement.PayloadTypeSeal, seal.Type)
		assert.Nil(t, seal.CloseAuthorization)
	})
}

func boundDistribute(payload any) *x402.SettleResponse {
	response := okResponse()
	_, channels := redemptionFacts(payload)
	response.Extra = map[string]any{"channels": channels}
	if _, ok := payload.(batchsettlement.BatchClaimPayload); ok {
		return recoveredResponse(payload)
	}
	return response
}

func payloadTypeList(payloads []any) []string {
	out := make([]string, 0, len(payloads))
	for _, payload := range payloads {
		payloadType, _ := redemptionFacts(payload)
		out = append(out, payloadType)
	}
	return out
}

type unlistableStore struct{}

func (unlistableStore) Get(string) (*server.ChannelState, error) { return nil, nil }
func (unlistableStore) Put(server.ChannelState) error            { return nil }
func (unlistableStore) Update(string, func(*server.ChannelState) (server.ChannelState, error)) (server.ChannelState, error) {
	return newChannel("x"), nil
}

type boostingStore struct{ inner *server.MemoryChannelStore }

func (s boostingStore) Get(id string) (*server.ChannelState, error) { return s.inner.Get(id) }
func (s boostingStore) List() ([]server.ChannelState, error)        { return s.inner.List() }
func (s boostingStore) Put(state server.ChannelState) error         { return s.inner.Put(state) }
func (s boostingStore) Update(id string, updater func(*server.ChannelState) (server.ChannelState, error)) (server.ChannelState, error) {
	return s.inner.Update(id, func(current *server.ChannelState) (server.ChannelState, error) {
		if current == nil {
			return updater(nil)
		}
		boosted := *current
		boosted.PayoutWatermark = 2500
		boosted.Settled = 5000
		return updater(&boosted)
	})
}

type vanishingStore struct{ inner *server.MemoryChannelStore }

func (s vanishingStore) Get(id string) (*server.ChannelState, error) { return s.inner.Get(id) }
func (s vanishingStore) List() ([]server.ChannelState, error)        { return s.inner.List() }
func (s vanishingStore) Put(state server.ChannelState) error         { return s.inner.Put(state) }
func (s vanishingStore) Update(id string, updater func(*server.ChannelState) (server.ChannelState, error)) (server.ChannelState, error) {
	return s.inner.Update(id, func(*server.ChannelState) (server.ChannelState, error) {
		return updater(nil)
	})
}
