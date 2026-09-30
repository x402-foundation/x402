package server_test

import (
	"context"
	"sort"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/server"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestBatchSettlementRedemptionWorker(t *testing.T) {
	receiverAuthorizer := newTestSigner(t)

	t.Run("does not mark a newer claim paid when a retry recovers an older sweep", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		state := newChannel("chan-a")
		state.Settled = 3000
		state.PayoutWatermark = 1000
		require.NoError(t, store.Put(state))
		options := managerOptions(store, receiverAuthorizer, recordingSettler(recoveredResponse).settle)
		result, err := server.NewBatchChannelManager(withPayout(options, 1000)).Redeem(context.Background())
		require.NoError(t, err)
		assert.Empty(t, result.Distributed)
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(1000), stored.PayoutWatermark)

		recovered, err := server.NewBatchChannelManager(withPayout(options, 3000)).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{"chan-a"}, recovered.Distributed)
	})

	t.Run("keeps payout work after an unavailable or missing account read", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		state := newChannel("chan-a")
		state.Settled = 3000
		require.NoError(t, store.Put(state))
		readers := []server.WatermarkReader{
			func(context.Context, string) (uint64, bool, error) { return 0, false, nil },
			func(context.Context, string) (uint64, bool, error) { return 0, false, assert.AnError },
		}
		for _, reader := range readers {
			options := managerOptions(store, receiverAuthorizer, recordingSettler(recoveredResponse).settle)
			options.ReadPayoutWatermark = reader
			_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
			require.NoError(t, err)
			stored, err := store.Get("chan-a")
			require.NoError(t, err)
			assert.Equal(t, uint64(0), stored.PayoutWatermark)
		}
	})

	t.Run("claims unclaimed vouchers, then distributes what they settled", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		settled := newChannel("chan-b")
		settled.Settled = 3000
		require.NoError(t, store.Put(settled))
		done := newChannel("chan-c")
		done.PayoutWatermark = 3000
		done.Settled = 3000
		require.NoError(t, store.Put(done))
		recorder := recordingSettler(recoveredResponse)
		manager := server.NewBatchChannelManager(withPayout(managerOptions(store, receiverAuthorizer, recorder.settle), 3000))
		result, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{"chan-a"}, result.Claimed)
		assert.Equal(t, []string{"chan-a", "chan-b"}, sorted(result.Distributed))
		assert.Equal(t, []string{"claim", "settle"}, payloadTypes(recorder.submitted))

		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(3000), stored.Settled)
		assert.Equal(t, uint64(3000), stored.PayoutWatermark)
		again, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, server.RedemptionResult{Claimed: []string{}, Distributed: []string{}, Sealed: []string{}}, again)
	})

	t.Run("packs no more than four channels into one claim", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		var want []string
		for index := 0; index < 9; index++ {
			id := "chan-" + string(rune('0'+index))
			want = append(want, id)
			require.NoError(t, store.Put(newChannel(id)))
		}
		recorder := recordingSettler(recoveredResponse)
		manager := server.NewBatchChannelManager(withPayout(managerOptions(store, receiverAuthorizer, recorder.settle), 3000))
		result, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Len(t, result.Claimed, 9)
		var lengths []int
		var got []string
		for _, payload := range recorder.submitted {
			if payload.payloadType != batchsettlement.PayloadTypeClaim {
				continue
			}
			lengths = append(lengths, len(payload.channels))
			got = append(got, payload.channels...)
		}
		assert.Equal(t, []int{4, 4, 1}, lengths)
		assert.Equal(t, sorted(want), sorted(got))
	})

	t.Run("leaves a failed batch for the next pass instead of recording it", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		var errors []error
		options := withPayout(managerOptions(store, receiverAuthorizer, func(ctx context.Context, request server.RedemptionRequest, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
			payloadType, _ := redemptionFacts(request.Payload)
			if payloadType == batchsettlement.PayloadTypeClaim {
				return &x402.SettleResponse{ErrorReason: "settlement_pending", Network: svm.SolanaDevnetCAIP2, Success: false, Transaction: ""}, nil
			}
			return recoveredResponse(request.Payload), nil
		}), 3000)
		options.OnError = func(err error) { errors = append(errors, err) }
		result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Empty(t, result.Claimed)
		assert.Len(t, errors, 1)
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(0), stored.Settled)
	})

	t.Run("repairs merchant state and finishes payout after a lost response and restart", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		pending := func(ctx context.Context, request server.RedemptionRequest, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
			payloadType, _ := redemptionFacts(request.Payload)
			if payloadType == batchsettlement.PayloadTypeClaim {
				return &x402.SettleResponse{ErrorReason: "settlement_pending", Network: svm.SolanaDevnetCAIP2, Success: false, Transaction: "claim-tx"}, nil
			}
			return recoveredResponse(request.Payload), nil
		}
		_, err := server.NewBatchChannelManager(withPayout(managerOptions(store, receiverAuthorizer, pending), 3000)).Redeem(context.Background())
		require.NoError(t, err)
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(0), stored.Settled)

		result, err := server.NewBatchChannelManager(withPayout(managerOptions(store, receiverAuthorizer, recordingSettler(recoveredResponse).settle), 3000)).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, server.RedemptionResult{Claimed: []string{"chan-a"}, Distributed: []string{"chan-a"}, Sealed: []string{}}, result)
		stored, err = store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(3000), stored.Settled)
		assert.Equal(t, uint64(3000), stored.PayoutWatermark)
	})

	t.Run("does not advance local state from an unbound success response", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		var errors []error
		options := withPayout(managerOptions(store, receiverAuthorizer, func(context.Context, server.RedemptionRequest, types.PaymentRequirements) (*x402.SettleResponse, error) {
			return okResponse(), nil
		}), 3000)
		options.OnError = func(err error) { errors = append(errors, err) }
		result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, server.RedemptionResult{Claimed: []string{}, Distributed: []string{}, Sealed: []string{}}, result)
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(0), stored.Settled)
		assert.Len(t, errors, 1)
	})

	t.Run("stop with flush runs one final redeem pass", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		recorder := recordingSettler(recoveredResponse)
		manager := server.NewBatchChannelManager(withPayout(managerOptions(store, receiverAuthorizer, recorder.settle), 3000))
		manager.Start(3600)
		require.NoError(t, manager.Stop(context.Background(), server.StopOptions{Flush: true}))
		assert.Equal(t, []string{"claim", "settle"}, payloadTypes(recorder.submitted))
	})

	t.Run("uses empty transaction in lifecycle callbacks when the facilitator omits it", func(t *testing.T) {
		var claims []server.ClaimResult
		var settles []server.SettleResult
		var seals []server.SealResult
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		options := withPayout(managerOptions(store, receiverAuthorizer, func(_ context.Context, request server.RedemptionRequest, _ types.PaymentRequirements) (*x402.SettleResponse, error) {
			response := recoveredResponse(request.Payload)
			response.Transaction = ""
			return response, nil
		}), 3000)
		options.OnClaim = func(result server.ClaimResult) { claims = append(claims, result) }
		options.OnSettle = func(result server.SettleResult) { settles = append(settles, result) }
		_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []server.ClaimResult{{Transaction: "", Vouchers: 1}}, claims)
		assert.Equal(t, []server.SettleResult{{Transaction: ""}}, settles)

		id := newTestSigner(t).Address().String()
		closing := newChannel(id)
		closing.Status = server.ChannelStatusClosing
		require.NoError(t, store.Put(closing))
		sealOptions := withPayout(managerOptions(store, receiverAuthorizer, options.Settle), 3000)
		sealOptions.OnSeal = func(result server.SealResult) { seals = append(seals, result) }
		_, err = server.NewBatchChannelManager(sealOptions).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []server.SealResult{{Channel: id, Transaction: ""}}, seals)
	})

	t.Run("fires onClaim, onSettle, and onSeal with facilitator transaction signatures", func(t *testing.T) {
		var claims []server.ClaimResult
		var settles []server.SettleResult
		var seals []server.SealResult
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		options := withPayout(managerOptions(store, receiverAuthorizer, recordingSettler(recoveredResponse).settle), 3000)
		options.OnClaim = func(result server.ClaimResult) { claims = append(claims, result) }
		options.OnSettle = func(result server.SettleResult) { settles = append(settles, result) }
		_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []server.ClaimResult{{Transaction: "sig", Vouchers: 1}}, claims)
		assert.Equal(t, []server.SettleResult{{Transaction: "sig"}}, settles)

		id := newTestSigner(t).Address().String()
		closing := newChannel(id)
		closing.Status = server.ChannelStatusClosing
		require.NoError(t, store.Put(closing))
		sealOptions := withPayout(managerOptions(store, receiverAuthorizer, recordingSettler(recoveredResponse).settle), 3000)
		sealOptions.OnSeal = func(result server.SealResult) { seals = append(seals, result) }
		_, err = server.NewBatchChannelManager(sealOptions).Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []server.SealResult{{Channel: id, Transaction: "sig"}}, seals)
	})

	t.Run("seals a closing channel instead of claiming it", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		id := newTestSigner(t).Address().String()
		closing := newChannel(id)
		closing.Status = server.ChannelStatusClosing
		require.NoError(t, store.Put(closing))
		recorder := recordingSettler(recoveredResponse)
		manager := server.NewBatchChannelManager(withPayout(managerOptions(store, receiverAuthorizer, recorder.settle), 3000))
		result, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		assert.Equal(t, server.RedemptionResult{Claimed: []string{}, Distributed: []string{}, Sealed: []string{id}}, result)
		assert.Equal(t, []string{batchsettlement.PayloadTypeSeal}, payloadTypes(recorder.submitted))
		stored, err := store.Get(id)
		require.NoError(t, err)
		assert.Equal(t, server.ChannelStatusDistributed, stored.Status)
	})
}

func managerRequirements() types.PaymentRequirements {
	return types.PaymentRequirements{
		Amount: "1000",
		Asset:  svm.USDCDevnetAddress,
		Extra: map[string]any{
			"feePayer":      svm.USDCMainnetAddress,
			"tokenProgram":  svm.TokenProgramAddress,
			"withdrawDelay": 900,
		},
		MaxTimeoutSeconds: 300,
		Network:           svm.SolanaDevnetCAIP2,
		PayTo:             svm.USDCMainnetAddress,
		Scheme:            batchsettlement.Scheme,
	}
}

func newChannel(id string) server.ChannelState {
	return server.ChannelState{
		ChannelConfig: batchsettlement.BatchChannelConfig{
			OpenSlot:        1,
			Payer:           svm.USDCDevnetAddress,
			PayerAuthorizer: svm.USDCDevnetAddress,
			Receiver:        svm.USDCMainnetAddress,
			Salt:            "0",
			Token:           svm.USDCDevnetAddress,
			WithdrawDelay:   900,
		},
		ChannelID:               id,
		ChargedCumulativeAmount: 3000,
		Deposit:                 10000,
		FeePayer:                svm.USDCMainnetAddress,
		HighestVoucherExpiresAt: 0,
		HighestVoucherSignature: "sig-" + id,
		Mint:                    svm.USDCDevnetAddress,
		OpenSlot:                1,
		Payer:                   svm.USDCDevnetAddress,
		PayerAuthorizer:         svm.USDCDevnetAddress,
		PayoutWatermark:         0,
		Receiver:                svm.USDCMainnetAddress,
		Salt:                    0,
		Settled:                 0,
		SignedMaxClaimable:      3000,
		Status:                  server.ChannelStatusOpen,
		TokenProgram:            svm.TokenProgramAddress,
		WithdrawDelay:           900,
	}
}

func managerOptions(store server.ChannelStore, authorizer testSigner, settle server.RedemptionSettler) server.BatchChannelManagerConfig {
	return server.BatchChannelManagerConfig{
		ReceiverAuthorizer: authorizer,
		Requirements:       managerRequirements(),
		Settle:             settle,
		Store:              store,
	}
}

func withPayout(options server.BatchChannelManagerConfig, paid uint64) server.BatchChannelManagerConfig {
	options.ReadPayoutWatermark = func(context.Context, string) (uint64, bool, error) {
		return paid, true, nil
	}
	return options
}

func okResponse() *x402.SettleResponse {
	return &x402.SettleResponse{Network: svm.SolanaDevnetCAIP2, Success: true, Transaction: "sig"}
}

func recoveredResponse(payload any) *x402.SettleResponse {
	response := okResponse()
	payloadType, channels := redemptionFacts(payload)
	if payloadType == batchsettlement.PayloadTypeClaim {
		claim := payload.(batchsettlement.BatchClaimPayload)
		accepts := make([]any, 0, len(claim.Claims))
		for _, item := range claim.Claims {
			accepts = append(accepts, map[string]any{
				"channelId":    item.Voucher.ChannelID,
				"totalClaimed": item.Voucher.MaxClaimableAmount,
			})
		}
		response.Extra = map[string]any{"accepts": accepts}
		return response
	}
	response.Extra = map[string]any{"channels": channels}
	return response
}

type submittedPayload struct {
	payloadType string
	channels    []string
}

type payloadRecorder struct {
	settle    server.RedemptionSettler
	submitted []submittedPayload
	payloads  []any
}

func recordingSettler(answer func(any) *x402.SettleResponse) *payloadRecorder {
	recorder := &payloadRecorder{}
	recorder.settle = func(_ context.Context, request server.RedemptionRequest, _ types.PaymentRequirements) (*x402.SettleResponse, error) {
		payloadType, channels := redemptionFacts(request.Payload)
		recorder.submitted = append(recorder.submitted, submittedPayload{payloadType: payloadType, channels: channels})
		recorder.payloads = append(recorder.payloads, request.Payload)
		return answer(request.Payload), nil
	}
	return recorder
}

func redemptionFacts(payload any) (string, []string) {
	switch typed := payload.(type) {
	case batchsettlement.BatchClaimPayload:
		channels := make([]string, 0, len(typed.Claims))
		for _, claim := range typed.Claims {
			channels = append(channels, claim.Voucher.ChannelID)
		}
		return typed.Type, channels
	case batchsettlement.BatchSettlePayload:
		channels := make([]string, 0, len(typed.Channels))
		for _, channel := range typed.Channels {
			channels = append(channels, channel.ChannelID)
		}
		return typed.Type, channels
	case batchsettlement.BatchSealPayload:
		return typed.Type, nil
	default:
		return "", nil
	}
}

func payloadTypes(submitted []submittedPayload) []string {
	types := make([]string, 0, len(submitted))
	for _, payload := range submitted {
		types = append(types, payload.payloadType)
	}
	return types
}

func sorted(values []string) []string {
	out := append([]string(nil), values...)
	sort.Strings(out)
	return out
}
