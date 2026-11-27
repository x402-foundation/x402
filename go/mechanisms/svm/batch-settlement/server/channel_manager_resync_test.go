package server_test

import (
	"context"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/server"
	"github.com/x402-foundation/x402/go/v2/types"
)

const payoutUnknown = "distribute confirmed but payout unknown: facilitator sent no channelStates and neither RPCURL nor ReadPayoutWatermark is set"

func channelStateEntry(id, status string, deposit, settled, payout uint64) map[string]any {
	return map[string]any{
		"channelId":           id,
		"status":              status,
		"balance":             strconv.FormatUint(deposit, 10),
		"totalClaimed":        strconv.FormatUint(settled, 10),
		"payoutWatermark":     strconv.FormatUint(payout, 10),
		"withdrawRequestedAt": float64(0),
	}
}

func withChannelStates(response *x402.SettleResponse, entries ...map[string]any) *x402.SettleResponse {
	states := make([]any, len(entries))
	for i, entry := range entries {
		states[i] = entry
	}
	response.Extra = map[string]any{batchsettlement.ExtraChannelStates: states}
	return response
}

func resyncFailure(reason string, entries ...map[string]any) *x402.SettleResponse {
	return withChannelStates(&x402.SettleResponse{Network: svm.SolanaDevnetCAIP2, Success: false, ErrorReason: reason}, entries...)
}

func errorCollector(options *server.BatchChannelManagerConfig) *[]string {
	var errors []string
	options.OnError = func(err error) { errors = append(errors, err.Error()) }
	return &errors
}

func claimsOf(recorder *payloadRecorder) [][]string {
	var claims [][]string
	for _, payload := range recorder.submitted {
		if payload.payloadType == batchsettlement.PayloadTypeClaim {
			claims = append(claims, sorted(payload.channels))
		}
	}
	return claims
}

func TestBatchSettlementRedemptionResyncFromFacilitator(t *testing.T) {
	receiverAuthorizer := newTestSigner(t)

	t.Run("infers a confirmed claim but not a distribute's payout when no reader is configured", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		options := managerOptions(store, receiverAuthorizer, recordingSettler(func(payload any) *x402.SettleResponse {
			payloadType, channels := redemptionFacts(payload)
			response := okResponse()
			if payloadType == batchsettlement.PayloadTypeSettle {
				response.Extra = map[string]any{"channels": channels}
			}
			return response
		}).settle)
		errors := errorCollector(&options)
		result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{payoutUnknown}, *errors)
		assert.Equal(t, server.RedemptionResult{Claimed: []string{"chan-a"}, Distributed: []string{}, Sealed: []string{}}, result)
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(3000), stored.Settled)
		assert.Zero(t, stored.PayoutWatermark, "the payout stays payable until the facilitator or a reader reports it")
	})

	t.Run("reports a successful distribute with unusable channel states and no reader", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		state := newChannel("chan-a")
		state.Settled = 3000
		state.HighestVoucherSignature = ""
		require.NoError(t, store.Put(state))
		var settles []server.SettleResult
		options := managerOptions(store, receiverAuthorizer, func(context.Context, server.RedemptionRequest, types.PaymentRequirements) (*x402.SettleResponse, error) {
			return withChannelStates(okResponse(), channelStateEntry("chan-z", batchsettlement.ChannelStatusOpen, 10000, 3000, 3000)), nil
		})
		options.OnSettle = func(result server.SettleResult) { settles = append(settles, result) }
		errors := errorCollector(&options)
		result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{payoutUnknown}, *errors)
		assert.Empty(t, result.Distributed)
		assert.Empty(t, settles)
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Zero(t, stored.PayoutWatermark)
	})

	t.Run("keeps an unpaid balance payable when a recovered distribute answers without channel states", func(t *testing.T) {
		// An earlier sweep paid through 1700; a later claim advanced settled to 2200.
		store := server.NewMemoryChannelStore()
		channel := newChannel("chan-a")
		channel.Settled = 2200
		channel.PayoutWatermark = 1000
		channel.HighestVoucherSignature = ""
		require.NoError(t, store.Put(channel))
		recorder := recordingSettler(func(payload any) *x402.SettleResponse {
			_, channels := redemptionFacts(payload)
			response := okResponse()
			response.Extra = map[string]any{"channels": channels}
			return response
		})
		options := managerOptions(store, receiverAuthorizer, recorder.settle)
		manager := server.NewBatchChannelManager(options)

		result, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Empty(t, result.Distributed)
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(1000), stored.PayoutWatermark, "the server does not credit 2200 the recovered sweep never paid")

		_, err = manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{batchsettlement.PayloadTypeSettle, batchsettlement.PayloadTypeSettle}, payloadTypes(recorder.submitted), "the next pass sweeps again")
	})

	t.Run("adopts the facilitator's channel states on a successful distribute", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		open := newChannel("chan-a")
		open.Settled = 3000
		open.HighestVoucherSignature = ""
		sealed := newChannel("chan-b")
		sealed.Settled = 3000
		sealed.HighestVoucherSignature = ""
		require.NoError(t, store.Put(open))
		require.NoError(t, store.Put(sealed))
		var settles []server.SettleResult
		options := managerOptions(store, receiverAuthorizer, func(context.Context, server.RedemptionRequest, types.PaymentRequirements) (*x402.SettleResponse, error) {
			response := withChannelStates(okResponse(),
				channelStateEntry("chan-a", batchsettlement.ChannelStatusOpen, 10000, 3500, 3500),
				channelStateEntry("chan-b", batchsettlement.ChannelStatusDistributed, 10000, 3000, 3000))
			response.Extra["channels"] = []any{"chan-a", "chan-b"}
			return response, nil
		})
		options.OnSettle = func(result server.SettleResult) { settles = append(settles, result) }
		result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{"chan-a", "chan-b"}, sorted(result.Distributed))
		assert.Equal(t, []server.SettleResult{{Transaction: "sig"}}, settles)
		a, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(3500), a.PayoutWatermark)
		assert.Equal(t, uint64(3500), a.Settled)
		assert.Equal(t, server.ChannelStatusOpen, a.Status)
		b, err := store.Get("chan-b")
		require.NoError(t, err)
		assert.Equal(t, server.ChannelStatusDistributed, b.Status)
	})

	t.Run("re-claims only the channels that are behind after a mixed batch is rejected", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		require.NoError(t, store.Put(newChannel("chan-b")))
		recorder := recordingSettler(func(payload any) *x402.SettleResponse {
			payloadType, channels := redemptionFacts(payload)
			if payloadType == batchsettlement.PayloadTypeClaim && len(channels) == 2 {
				return resyncFailure(batchsettlement.ErrCumulativeAmountMismatch,
					channelStateEntry("chan-a", batchsettlement.ChannelStatusOpen, 10000, 3000, 0),
					channelStateEntry("chan-b", batchsettlement.ChannelStatusOpen, 10000, 0, 0))
			}
			return boundDistribute(payload)
		})
		var claims []server.ClaimResult
		options := managerOptions(store, receiverAuthorizer, recorder.settle)
		options.OnClaim = func(result server.ClaimResult) { claims = append(claims, result) }
		errors := errorCollector(&options)
		result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{payoutUnknown}, *errors, "one report for the two-channel batch")
		assert.Equal(t, [][]string{{"chan-a", "chan-b"}, {"chan-b"}}, claimsOf(recorder))
		assert.Equal(t, []string{"chan-b"}, result.Claimed, "a resynced channel is not a new claim")
		assert.Equal(t, []server.ClaimResult{{Transaction: "sig", Vouchers: 1}}, claims)
		a, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(3000), a.Settled)
		b, err := store.Get("chan-b")
		require.NoError(t, err)
		assert.Equal(t, uint64(3000), b.Settled)
	})

	t.Run("resyncs a fully applied claim without resubmitting", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		recorder := recordingSettler(func(payload any) *x402.SettleResponse {
			payloadType, _ := redemptionFacts(payload)
			if payloadType == batchsettlement.PayloadTypeClaim {
				return resyncFailure(batchsettlement.ErrCumulativeAmountMismatch,
					channelStateEntry("chan-a", batchsettlement.ChannelStatusOpen, 10000, 4000, 0))
			}
			response := withChannelStates(okResponse(), channelStateEntry("chan-a", batchsettlement.ChannelStatusOpen, 10000, 4000, 4000))
			response.Extra["channels"] = []any{"chan-a"}
			return response
		})
		var claims []server.ClaimResult
		options := managerOptions(store, receiverAuthorizer, recorder.settle)
		options.OnClaim = func(result server.ClaimResult) { claims = append(claims, result) }
		errors := errorCollector(&options)
		result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Empty(t, *errors)
		assert.Empty(t, claims)
		assert.Empty(t, result.Claimed)
		assert.Equal(t, [][]string{{"chan-a"}}, claimsOf(recorder))
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(4000), stored.Settled)
		assert.Equal(t, []string{"chan-a"}, result.Distributed)
	})

	t.Run("stops retrying when nothing resyncs", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		require.NoError(t, store.Put(newChannel("chan-b")))
		recorder := recordingSettler(func(any) *x402.SettleResponse {
			return resyncFailure(batchsettlement.ErrCumulativeAmountMismatch,
				channelStateEntry("chan-a", batchsettlement.ChannelStatusOpen, 10000, 0, 0),
				channelStateEntry("chan-b", batchsettlement.ChannelStatusOpen, 10000, 2999, 0))
		})
		options := managerOptions(store, receiverAuthorizer, recorder.settle)
		errors := errorCollector(&options)
		_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Len(t, claimsOf(recorder), 1)
		assert.Equal(t, []string{"batch-settlement claim failed: " + batchsettlement.ErrCumulativeAmountMismatch}, *errors)
	})

	t.Run("re-claims at most once after a resync", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		require.NoError(t, store.Put(newChannel("chan-b")))
		recorder := recordingSettler(func(payload any) *x402.SettleResponse {
			payloadType, channels := redemptionFacts(payload)
			if payloadType != batchsettlement.PayloadTypeClaim {
				return boundDistribute(payload)
			}
			if len(channels) == 2 {
				return resyncFailure(batchsettlement.ErrCumulativeAmountMismatch,
					channelStateEntry("chan-a", batchsettlement.ChannelStatusOpen, 10000, 3000, 0),
					channelStateEntry("chan-b", batchsettlement.ChannelStatusOpen, 10000, 0, 0))
			}
			return resyncFailure(batchsettlement.ErrCumulativeAmountMismatch,
				channelStateEntry(channels[0], batchsettlement.ChannelStatusOpen, 10000, 0, 0))
		})
		options := managerOptions(store, receiverAuthorizer, recorder.settle)
		errors := errorCollector(&options)
		_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, [][]string{{"chan-a", "chan-b"}, {"chan-b"}}, claimsOf(recorder))
		assert.Equal(t, []string{"batch-settlement claim failed: " + batchsettlement.ErrCumulativeAmountMismatch, payoutUnknown}, *errors)
	})

	t.Run("ignores channel states that do not name exactly the submitted batch or carry impossible values", func(t *testing.T) {
		valid := channelStateEntry("chan-a", batchsettlement.ChannelStatusOpen, 10000, 3000, 0)
		with := func(field string, value any) map[string]any {
			entry := channelStateEntry("chan-a", batchsettlement.ChannelStatusOpen, 10000, 3000, 0)
			entry[field] = value
			return entry
		}
		cases := map[string][]map[string]any{
			"another channel":           {channelStateEntry("chan-z", batchsettlement.ChannelStatusOpen, 10000, 3000, 0)},
			"an extra channel":          {valid, channelStateEntry("chan-b", batchsettlement.ChannelStatusOpen, 10000, 3000, 0)},
			"a duplicate":               {valid, valid},
			"no entries":                {},
			"payout above settled":      {channelStateEntry("chan-a", batchsettlement.ChannelStatusOpen, 10000, 3000, 3001)},
			"settled above the deposit": {channelStateEntry("chan-a", batchsettlement.ChannelStatusOpen, 2000, 3000, 0)},
			"an unknown status":         {with("status", "frozen")},
			"closed with nonzero balance": {channelStateEntry("chan-a", batchsettlement.ChannelStatusClosed, 10000, 0, 0)},
			"closed with nonzero settled": {channelStateEntry("chan-a", batchsettlement.ChannelStatusClosed, 0, 1, 0)},
			"a malformed amount":        {with("totalClaimed", "30x0")},
			"a numeric amount":          {with("totalClaimed", float64(3000))},
			"a missing amount":          {with("payoutWatermark", nil)},
		}
		for name, entries := range cases {
			t.Run(name, func(t *testing.T) {
				store := server.NewMemoryChannelStore()
				require.NoError(t, store.Put(newChannel("chan-a")))
				recorder := recordingSettler(func(any) *x402.SettleResponse {
					return resyncFailure(batchsettlement.ErrCumulativeAmountMismatch, entries...)
				})
				options := managerOptions(store, receiverAuthorizer, recorder.settle)
				errors := errorCollector(&options)
				_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
				require.NoError(t, err)
				assert.Len(t, claimsOf(recorder), 1)
				assert.Len(t, *errors, 1)
				stored, err := store.Get("chan-a")
				require.NoError(t, err)
				assert.Equal(t, uint64(0), stored.Settled)
			})
		}
	})

	t.Run("ignores channel states bound to another network", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		recorder := recordingSettler(func(any) *x402.SettleResponse {
			response := resyncFailure(batchsettlement.ErrCumulativeAmountMismatch,
				channelStateEntry("chan-a", batchsettlement.ChannelStatusOpen, 10000, 3000, 0))
			response.Network = "solana:other"
			return response
		})
		options := managerOptions(store, receiverAuthorizer, recorder.settle)
		errors := errorCollector(&options)
		_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Len(t, *errors, 1)
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(0), stored.Settled)
	})

	t.Run("falls back to a configured reader when the facilitator sends no usable state", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		recorder := recordingSettler(func(payload any) *x402.SettleResponse {
			payloadType, _ := redemptionFacts(payload)
			if payloadType == batchsettlement.PayloadTypeClaim {
				return &x402.SettleResponse{Network: svm.SolanaDevnetCAIP2, ErrorReason: batchsettlement.ErrCumulativeAmountMismatch}
			}
			return boundDistribute(payload)
		})
		options := managerOptions(store, receiverAuthorizer, recorder.settle)
		options.ReadSettledWatermark = func(context.Context, string) (uint64, bool, error) { return 3000, true, nil }
		errors := errorCollector(&options)
		_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{payoutUnknown}, *errors)
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(3000), stored.Settled)
	})

	t.Run("resyncs the payout watermark when a distribute finds nothing left to sweep", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		state := newChannel("chan-a")
		state.Settled = 3000
		state.HighestVoucherSignature = ""
		require.NoError(t, store.Put(state))
		var settles []server.SettleResult
		options := managerOptions(store, receiverAuthorizer, func(context.Context, server.RedemptionRequest, types.PaymentRequirements) (*x402.SettleResponse, error) {
			return resyncFailure(batchsettlement.ErrCumulativeAmountMismatch,
				channelStateEntry("chan-a", batchsettlement.ChannelStatusOpen, 10000, 3000, 3000)), nil
		})
		options.OnSettle = func(result server.SettleResult) { settles = append(settles, result) }
		errors := errorCollector(&options)
		result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Empty(t, *errors)
		assert.Empty(t, settles)
		assert.Empty(t, result.Distributed)
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(3000), stored.PayoutWatermark)
	})

	t.Run("reports a distribute rejection that carries no state and leaves local state alone without a reader", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		state := newChannel("chan-a")
		state.Settled = 3000
		state.HighestVoucherSignature = ""
		require.NoError(t, store.Put(state))
		options := managerOptions(store, receiverAuthorizer, func(context.Context, server.RedemptionRequest, types.PaymentRequirements) (*x402.SettleResponse, error) {
			return &x402.SettleResponse{Network: svm.SolanaDevnetCAIP2, ErrorReason: batchsettlement.ErrCumulativeAmountMismatch}, nil
		})
		errors := errorCollector(&options)
		_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{"batch-settlement distribute failed: " + batchsettlement.ErrCumulativeAmountMismatch}, *errors, "a rejected distribute is not reported as confirmed")
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(0), stored.PayoutWatermark)
	})

	t.Run("records a paid-out channel when a seal finds it distributed, without calling OnSeal", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		id := newTestSigner(t).Address().String()
		closing := newChannel(id)
		closing.Status = server.ChannelStatusClosing
		require.NoError(t, store.Put(closing))
		var seals []server.SealResult
		recorder := recordingSettler(func(any) *x402.SettleResponse {
			return resyncFailure(batchsettlement.ErrCloseState, channelStateEntry(id, batchsettlement.ChannelStatusDistributed, 10000, 3000, 3000))
		})
		options := managerOptions(store, receiverAuthorizer, recorder.settle)
		options.OnSeal = func(result server.SealResult) { seals = append(seals, result) }
		errors := errorCollector(&options)
		manager := server.NewBatchChannelManager(options)
		result, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Empty(t, *errors)
		assert.Empty(t, seals)
		assert.Empty(t, result.Sealed)
		stored, err := store.Get(id)
		require.NoError(t, err)
		assert.Equal(t, server.ChannelStatusDistributed, stored.Status)
		assert.Equal(t, uint64(3000), stored.Settled)
		assert.Equal(t, uint64(3000), stored.PayoutWatermark)

		_, err = manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{batchsettlement.PayloadTypeSeal}, payloadTypes(recorder.submitted), "the paid-out channel is not sealed again")
	})

	t.Run("records a sealed channel as sealed and distributes its unpaid settled amount", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		id := newTestSigner(t).Address().String()
		closing := newChannel(id)
		closing.Status = server.ChannelStatusClosing
		require.NoError(t, store.Put(closing))
		recorder := recordingSettler(func(payload any) *x402.SettleResponse {
			payloadType, channels := redemptionFacts(payload)
			if payloadType == batchsettlement.PayloadTypeSettle {
				response := withChannelStates(okResponse(), channelStateEntry(id, batchsettlement.ChannelStatusDistributed, 10000, 3000, 3000))
				response.Extra["channels"] = channels
				return response
			}
			return resyncFailure(batchsettlement.ErrCloseState, channelStateEntry(id, batchsettlement.ChannelStatusSealed, 10000, 3000, 0))
		})
		options := managerOptions(store, receiverAuthorizer, recorder.settle)
		errors := errorCollector(&options)
		manager := server.NewBatchChannelManager(options)
		result, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{"batch-settlement seal failed: " + batchsettlement.ErrCloseState}, *errors)
		assert.Equal(t, []string{id}, result.Distributed, "a sealed channel is swept in the same pass")
		assert.Equal(t, []string{batchsettlement.PayloadTypeSeal, batchsettlement.PayloadTypeSettle}, payloadTypes(recorder.submitted))
		stored, err := store.Get(id)
		require.NoError(t, err)
		assert.Equal(t, server.ChannelStatusDistributed, stored.Status)
		assert.Equal(t, uint64(3000), stored.Settled)
		assert.Equal(t, uint64(3000), stored.PayoutWatermark)
	})

	t.Run("keeps a sealed channel sealed and payable until a distribute lands", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		id := newTestSigner(t).Address().String()
		closing := newChannel(id)
		closing.Status = server.ChannelStatusClosing
		require.NoError(t, store.Put(closing))
		options := managerOptions(store, receiverAuthorizer, func(context.Context, server.RedemptionRequest, types.PaymentRequirements) (*x402.SettleResponse, error) {
			return resyncFailure(batchsettlement.ErrCloseState, channelStateEntry(id, batchsettlement.ChannelStatusSealed, 10000, 3000, 1000)), nil
		})
		errorCollector(&options)
		_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		stored, err := store.Get(id)
		require.NoError(t, err)
		assert.Equal(t, server.ChannelStatusSealed, stored.Status)
		assert.Equal(t, uint64(3000), stored.Settled)
		assert.Equal(t, uint64(1000), stored.PayoutWatermark)
	})

	t.Run("reports a seal rejection for a channel that is still closing without recording it", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		id := newTestSigner(t).Address().String()
		closing := newChannel(id)
		closing.Status = server.ChannelStatusClosing
		require.NoError(t, store.Put(closing))
		options := managerOptions(store, receiverAuthorizer, func(context.Context, server.RedemptionRequest, types.PaymentRequirements) (*x402.SettleResponse, error) {
			return resyncFailure(batchsettlement.ErrCloseState, channelStateEntry(id, batchsettlement.ChannelStatusClosing, 10000, 4000, 0)), nil
		})
		errors := errorCollector(&options)
		_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Len(t, *errors, 1)
		stored, err := store.Get(id)
		require.NoError(t, err)
		assert.Equal(t, uint64(0), stored.Settled)
		assert.Equal(t, server.ChannelStatusClosing, stored.Status)
	})

	t.Run("adopts closed status on a recovered distribute success and stops retrying", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		sealed := newChannel("chan-a")
		sealed.Status = server.ChannelStatusSealed
		sealed.Settled = 3000
		sealed.HighestVoucherSignature = ""
		require.NoError(t, store.Put(sealed))
		var settles []server.SettleResult
		recorder := recordingSettler(func(payload any) *x402.SettleResponse {
			_, channels := redemptionFacts(payload)
			response := withChannelStates(okResponse(),
				channelStateEntry("chan-a", batchsettlement.ChannelStatusClosed, 0, 0, 0))
			response.Extra["channels"] = channels
			return response
		})
		options := managerOptions(store, receiverAuthorizer, recorder.settle)
		options.OnSettle = func(result server.SettleResult) { settles = append(settles, result) }
		errors := errorCollector(&options)
		manager := server.NewBatchChannelManager(options)

		result, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Empty(t, *errors)
		assert.Equal(t, []string{"chan-a"}, result.Distributed)
		assert.Len(t, settles, 1)
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, server.ChannelStatusDistributed, stored.Status)
		assert.Equal(t, uint64(3000), stored.Settled)
		assert.Equal(t, uint64(3000), stored.PayoutWatermark)

		_, err = manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Len(t, recorder.submitted, 1, "closed channel is not distributed again")
	})

	t.Run("retires a closed channel on distribute ErrChannelState and distributes remaining live channels in the same pass", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		closedCh := newChannel("chan-a")
		closedCh.Status = server.ChannelStatusSealed
		closedCh.Settled = 3000
		closedCh.HighestVoucherSignature = ""
		liveCh := newChannel("chan-b")
		liveCh.Settled = 2000
		liveCh.HighestVoucherSignature = ""
		require.NoError(t, store.Put(closedCh))
		require.NoError(t, store.Put(liveCh))
		var settles []server.SettleResult
		recorder := recordingSettler(func(payload any) *x402.SettleResponse {
			_, channels := redemptionFacts(payload)
			if len(channels) == 2 {
				return resyncFailure(batchsettlement.ErrChannelState,
					channelStateEntry("chan-a", batchsettlement.ChannelStatusClosed, 0, 0, 0),
					channelStateEntry("chan-b", batchsettlement.ChannelStatusOpen, 10000, 2000, 0))
			}
			response := withChannelStates(okResponse(),
				channelStateEntry("chan-b", batchsettlement.ChannelStatusOpen, 10000, 2000, 2000))
			response.Extra["channels"] = channels
			return response
		})
		options := managerOptions(store, receiverAuthorizer, recorder.settle)
		options.OnSettle = func(result server.SettleResult) { settles = append(settles, result) }
		errors := errorCollector(&options)
		manager := server.NewBatchChannelManager(options)

		result, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Empty(t, *errors)
		assert.Equal(t, []string{"chan-b"}, result.Distributed)
		assert.Len(t, settles, 1)
		a, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, server.ChannelStatusDistributed, a.Status)
		assert.Equal(t, uint64(3000), a.PayoutWatermark)
		b, err := store.Get("chan-b")
		require.NoError(t, err)
		assert.Equal(t, uint64(2000), b.PayoutWatermark)

		_, err = manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Len(t, recorder.submitted, 2, "neither channel is retried on the next pass")
	})

	t.Run("retires a closed channel on claim ErrChannelState without inflating settled, reports unclaimed loss, and claims live peers", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		closedCh := newChannel("chan-a")
		closedCh.Settled = 1000
		closedCh.SignedMaxClaimable = 3000
		liveCh := newChannel("chan-b")
		liveCh.SignedMaxClaimable = 2000
		require.NoError(t, store.Put(closedCh))
		require.NoError(t, store.Put(liveCh))
		recorder := recordingSettler(func(payload any) *x402.SettleResponse {
			payloadType, channels := redemptionFacts(payload)
			if payloadType == batchsettlement.PayloadTypeClaim && len(channels) == 2 {
				return resyncFailure(batchsettlement.ErrChannelState,
					channelStateEntry("chan-a", batchsettlement.ChannelStatusClosed, 0, 0, 0),
					channelStateEntry("chan-b", batchsettlement.ChannelStatusOpen, 10000, 0, 0))
			}
			if payloadType == batchsettlement.PayloadTypeSettle {
				response := withChannelStates(okResponse(),
					channelStateEntry("chan-b", batchsettlement.ChannelStatusOpen, 10000, 2000, 2000))
				response.Extra["channels"] = channels
				return response
			}
			return okResponse()
		})
		options := managerOptions(store, receiverAuthorizer, recorder.settle)
		errors := errorCollector(&options)
		manager := server.NewBatchChannelManager(options)

		result, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{"chan-b"}, result.Claimed)
		assert.Equal(t, []string{"chan-b"}, result.Distributed)
		require.Len(t, *errors, 1)
		assert.Contains(t, (*errors)[0], "closed onchain with unclaimed voucher value")

		a, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, server.ChannelStatusDistributed, a.Status)
		assert.Equal(t, uint64(1000), a.Settled, "unclaimed voucher value is not fabricated as settled")
		assert.Equal(t, uint64(1000), a.PayoutWatermark)
		b, err := store.Get("chan-b")
		require.NoError(t, err)
		assert.Equal(t, uint64(2000), b.Settled)
		assert.Equal(t, uint64(2000), b.PayoutWatermark)

		claimsBefore := len(claimsOf(recorder))
		_, err = manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, claimsBefore, len(claimsOf(recorder)), "closed channel is not claimed again")
	})

	t.Run("retires a closed channel on seal ErrChannelState without calling OnSeal and reports unclaimed loss", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		id := newTestSigner(t).Address().String()
		closing := newChannel(id)
		closing.Status = server.ChannelStatusClosing
		closing.Settled = 1000
		closing.SignedMaxClaimable = 3000
		require.NoError(t, store.Put(closing))
		var seals []server.SealResult
		recorder := recordingSettler(func(any) *x402.SettleResponse {
			return resyncFailure(batchsettlement.ErrChannelState,
				channelStateEntry(id, batchsettlement.ChannelStatusClosed, 0, 0, 0))
		})
		options := managerOptions(store, receiverAuthorizer, recorder.settle)
		options.OnSeal = func(result server.SealResult) { seals = append(seals, result) }
		errors := errorCollector(&options)
		manager := server.NewBatchChannelManager(options)

		result, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Empty(t, result.Sealed)
		assert.Empty(t, seals)
		require.Len(t, *errors, 1)
		assert.Contains(t, (*errors)[0], "closed onchain with unclaimed voucher value")
		stored, err := store.Get(id)
		require.NoError(t, err)
		assert.Equal(t, server.ChannelStatusDistributed, stored.Status)
		assert.Equal(t, uint64(1000), stored.Settled)
		assert.Equal(t, uint64(1000), stored.PayoutWatermark)

		_, err = manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Len(t, recorder.submitted, 1, "closed channel is not sealed again")
	})
}
