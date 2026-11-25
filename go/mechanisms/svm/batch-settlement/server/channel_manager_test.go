package server_test

import (
	"context"
	"encoding/json"
	"sort"
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

	t.Run("reports a thrown settlement_pending claim and continues the pass", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		settled := newChannel("chan-b")
		settled.Settled = 3000
		require.NoError(t, store.Put(settled))
		var errors []error
		var submitted []string
		options := withPayout(managerOptions(store, receiverAuthorizer, func(ctx context.Context, request server.RedemptionRequest, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
			payloadType, _ := redemptionFacts(request.Payload)
			submitted = append(submitted, payloadType)
			if payloadType == batchsettlement.PayloadTypeClaim {
				return nil, x402.NewSettleError(x402.ErrSettlementPending, "payer", svm.SolanaDevnetCAIP2, "claim-tx", "")
			}
			return recoveredResponse(request.Payload), nil
		}), 3000)
		options.OnError = func(err error) { errors = append(errors, err) }
		result, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.NoError(t, err)
		assert.Empty(t, result.Claimed)
		assert.Equal(t, []string{"chan-b"}, result.Distributed)
		assert.Equal(t, []string{"claim", "settle"}, submitted)
		require.Len(t, errors, 1)
		assert.Contains(t, errors[0].Error(), x402.ErrSettlementPending)
		stored, err := store.Get("chan-a")
		require.NoError(t, err)
		assert.Equal(t, uint64(0), stored.Settled)
	})

	t.Run("propagates a settle error that carries no transaction", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		options := withPayout(managerOptions(store, receiverAuthorizer, func(context.Context, server.RedemptionRequest, types.PaymentRequirements) (*x402.SettleResponse, error) {
			return nil, assert.AnError
		}), 3000)
		_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
		require.ErrorIs(t, err, assert.AnError)
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
		options.ReadSettledWatermark = func(context.Context, string) (uint64, bool, error) { return 0, false, nil }
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

func TestBatchSettlementRedemptionTermsComeFromChannelState(t *testing.T) {
	receiverAuthorizer := newTestSigner(t)

	t.Run("redeems channels opened under different fee payers in one pass, one batch per fee payer", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		other := newChannel("chan-b")
		other.FeePayer = svm.USDCDevnetAddress
		require.NoError(t, store.Put(newChannel("chan-a")))
		require.NoError(t, store.Put(other))
		require.NoError(t, store.Put(newChannel("chan-c")))
		recorder := redeemWithTerms(t, store, receiverAuthorizer)

		for _, payloadType := range []string{batchsettlement.PayloadTypeClaim, batchsettlement.PayloadTypeSettle} {
			submissions := submissionsOf(recorder.submitted, payloadType)
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
			mutate:   func(c *server.ChannelState) { c.ChannelConfig.Receiver = svm.TokenProgramAddress },
			expected: func(r types.PaymentRequirements) bool { return r.PayTo == svm.TokenProgramAddress },
		},
		"mint": {
			mutate:   func(c *server.ChannelState) { c.ChannelConfig.Token = svm.USDCMainnetAddress },
			expected: func(r types.PaymentRequirements) bool { return r.Asset == svm.USDCMainnetAddress },
		},
		"token program": {
			mutate: func(c *server.ChannelState) { c.TokenProgram = svm.Token2022ProgramAddress },
			expected: func(r types.PaymentRequirements) bool {
				return r.Extra[batchsettlement.ExtraTokenProgram] == svm.Token2022ProgramAddress
			},
		},
		"withdraw delay": {
			mutate: func(c *server.ChannelState) { c.ChannelConfig.WithdrawDelay = 1800 },
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
			recorder := redeemWithTerms(t, store, receiverAuthorizer)

			claims := submissionsOf(recorder.submitted, batchsettlement.PayloadTypeClaim)
			require.Len(t, claims, 2)
			assert.Equal(t, []string{"chan-a"}, claims[0].channels)
			assert.Equal(t, []string{"chan-b"}, claims[1].channels)
			assert.True(t, tc.expected(claims[1].requirements), "%+v", claims[1].requirements)
		})
	}

	t.Run("ignores top-level copies that drifted from the channel config", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		drifted := newChannel("chan-b")
		drifted.Receiver = svm.TokenProgramAddress
		drifted.Mint = svm.USDCMainnetAddress
		drifted.WithdrawDelay = 1800
		require.NoError(t, store.Put(newChannel("chan-a")))
		require.NoError(t, store.Put(drifted))
		recorder := redeemWithTerms(t, store, receiverAuthorizer)

		claims := submissionsOf(recorder.submitted, batchsettlement.PayloadTypeClaim)
		require.Len(t, claims, 1)
		assert.ElementsMatch(t, []string{"chan-a", "chan-b"}, claims[0].channels)
		assert.Equal(t, svm.USDCMainnetAddress, claims[0].requirements.PayTo)
		assert.Equal(t, svm.USDCDevnetAddress, claims[0].requirements.Asset)
		assert.Equal(t, 900, claims[0].requirements.Extra[batchsettlement.ExtraWithdrawDelay])
	})

	t.Run("authors requirements from stored channel state", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(newChannel("chan-a")))
		recorder := redeemWithTerms(t, store, receiverAuthorizer)

		require.NotEmpty(t, recorder.submitted)
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
		}, recorder.submitted[0].requirements)
	})

	t.Run("names the operator for a server-signed channel", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		state := newChannel("chan-a")
		state.ChannelConfig.VoucherSigner = batchsettlement.VoucherSignerServer
		require.NoError(t, store.Put(state))
		recorder := redeemWithTerms(t, store, receiverAuthorizer)

		extra := recorder.submitted[0].requirements.Extra
		assert.Equal(t, svm.USDCDevnetAddress, extra[batchsettlement.ExtraOperator])
		assert.Equal(t, batchsettlement.VoucherSignerServer, extra[batchsettlement.ExtraVoucherSigner])
	})

	t.Run("bounds the seal authorization by the redemption timeout", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		closing := newChannel(svm.USDCDevnetAddress)
		closing.Status = server.ChannelStatusClosing
		require.NoError(t, store.Put(closing))

		before := time.Now().Unix()
		recorder := redeemWithTerms(t, store, receiverAuthorizer)

		seals := submissionsOf(recorder.submitted, batchsettlement.PayloadTypeSeal)
		require.Len(t, seals, 1)
		var seal batchsettlement.BatchSealPayload
		for _, payload := range recorder.payloads {
			typed, ok := payload.(batchsettlement.BatchSealPayload)
			if ok {
				seal = typed
			}
		}
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

func newChannel(id string) server.ChannelState {
	return server.ChannelState{
		ChannelConfig: batchsettlement.BatchChannelConfig{
			OpenSlot:           1,
			Payer:              svm.USDCDevnetAddress,
			PayerAuthorizer:    svm.USDCDevnetAddress,
			Receiver:           svm.USDCMainnetAddress,
			ReceiverAuthorizer: svm.TokenProgramAddress,
			Salt:               "0",
			Token:              svm.USDCDevnetAddress,
			WithdrawDelay:      900,
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
		Network:            svm.SolanaDevnetCAIP2,
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
	payloadType  string
	channels     []string
	requirements types.PaymentRequirements
}

type payloadRecorder struct {
	settle    server.RedemptionSettler
	submitted []submittedPayload
	payloads  []any
}

func recordingSettler(answer func(any) *x402.SettleResponse) *payloadRecorder {
	recorder := &payloadRecorder{}
	recorder.settle = func(_ context.Context, request server.RedemptionRequest, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
		payloadType, channels := redemptionFacts(request.Payload)
		recorder.submitted = append(recorder.submitted, submittedPayload{
			payloadType:  payloadType,
			channels:     channels,
			requirements: requirements,
		})
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

func submissionsOf(submitted []submittedPayload, payloadType string) []submittedPayload {
	var out []submittedPayload
	for _, submission := range submitted {
		if submission.payloadType == payloadType {
			out = append(out, submission)
		}
	}
	return out
}

func redeemWithTerms(t *testing.T, store server.ChannelStore, authorizer testSigner) *payloadRecorder {
	t.Helper()
	recorder := recordingSettler(boundDistribute)
	options := withPayout(managerOptions(store, authorizer, recorder.settle), 3000)
	_, err := server.NewBatchChannelManager(options).Redeem(context.Background())
	require.NoError(t, err)
	return recorder
}

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
			Type     string     `json:"type"`
			Claims   []struct{} `json:"claims"`
			Channels []struct{} `json:"channels"`
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
