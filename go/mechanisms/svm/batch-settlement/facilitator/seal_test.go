package facilitator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	"github.com/x402-foundation/x402/go/v2/types"
)

const sealNow int64 = 1_800_000_000

func TestBatchSettlementSeal(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	payer := mustKey(t)
	feePayer := mustKey(t)
	authorizer := mustKey(t)
	salt := uint64(0)
	binding := batchsettlement.EncodeReceiverBindingMemo(authorizer.PublicKey().String())
	open, err := paymentchannels.BuildOpenTransaction(paymentchannels.BuildOpenArgs{
		Payer:            payer.PublicKey(),
		Payee:            feePayer.PublicKey(),
		Mint:             solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
		AuthorizedSigner: payer.PublicKey(),
		FeePayer:         feePayer.PublicKey(),
		TokenProgram:     solana.MustPublicKeyFromBase58(svm.TokenProgramAddress),
		Deposit:          10_000,
		Blockhash:        solana.Hash(solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress)),
		OpenSlot:         1,
		GracePeriod:      900,
		Recipients:       []paymentchannels.Split{{Recipient: svm.USDCMainnetAddress, BPS: batchsettlement.FullSplitBPS}},
		Salt:             &salt,
		BindingMemo:      &binding,
	})
	require.NoError(t, err)
	channelID := open.ChannelID.String()
	config := batchsettlement.BatchChannelConfig{
		OpenSlot:           1,
		Payer:              payer.PublicKey().String(),
		PayerAuthorizer:    payer.PublicKey().String(),
		Receiver:           svm.USDCMainnetAddress,
		ReceiverAuthorizer: authorizer.PublicKey().String(),
		Salt:               "0",
		Token:              svm.USDCDevnetAddress,
		WithdrawDelay:      900,
	}
	requirements := types.PaymentRequirements{
		Amount: "1000",
		Asset:  svm.USDCDevnetAddress,
		Extra: map[string]any{
			"feePayer":           feePayer.PublicKey().String(),
			"receiverAuthorizer": authorizer.PublicKey().String(),
			"tokenProgram":       svm.TokenProgramAddress,
			"withdrawDelay":      900,
		},
		MaxTimeoutSeconds: 300,
		Network:           network,
		PayTo:             svm.USDCMainnetAddress,
		Scheme:            batchsettlement.Scheme,
	}
	hash, err := paymentchannels.GetChannelDistributionHash([]paymentchannels.Split{{
		Recipient: svm.USDCMainnetAddress, BPS: batchsettlement.FullSplitBPS,
	}})
	require.NoError(t, err)
	live := func(overrides func(*generated.Channel)) *generated.Channel {
		channel := &generated.Channel{
			Discriminator:    uint8(generated.AccountDiscriminator_Channel),
			Bump:             1,
			Version:          1,
			Status:           uint8(generated.ChannelStatus_Closing),
			Salt:             0,
			Deposit:          10_000,
			Settlement:       generated.SettlementWatermarks{Settled: 1_000, PayoutWatermark: 500},
			ClosureStartedAt: sealNow - 60,
			GracePeriod:      900,
			DistributionHash: hash,
			Payer:            payer.PublicKey(),
			Payee:            feePayer.PublicKey(),
			AuthorizedSigner: payer.PublicKey(),
			Mint:             solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
			RentPayer:        feePayer.PublicKey(),
			OpenSlot:         1,
		}
		if overrides != nil {
			overrides(channel)
		}
		return channel
	}
	openLive := live(func(channel *generated.Channel) {
		channel.Status = uint8(generated.ChannelStatus_Open)
		channel.ClosureStartedAt = 0
	})
	const signature = "signature"
	type sealFixture struct {
		scheme  *BatchSvmScheme
		storage *activityRecordingStorage
		submits []submitCall
	}
	facilitator := func(t *testing.T, channel *generated.Channel, bound bool, configure ...func(*Config)) *sealFixture {
		t.Helper()
		if channel == nil {
			channel = live(nil)
		}
		storage := newActivityRecordingStorage()
		if bound {
			_, err := storage.RecordOpen(context.Background(), paymentchannels.PaymentChannelRecord{
				Network: network, ChannelID: channelID, ReceiverAuthorizer: authorizer.PublicKey().String(), LastActivityAt: time.Now(),
			})
			require.NoError(t, err)
		}
		fixture := &sealFixture{storage: storage}
		cfg := &Config{ChannelStorage: storage}
		for _, apply := range configure {
			apply(cfg)
		}
		scheme := NewBatchSvmScheme(context.Background(), newScriptedSigner(t, 1), cfg)
		terms := BatchTerms{
			FeePayer:           feePayer.PublicKey().String(),
			ReceiverAuthorizer: authorizer.PublicKey().String(),
			TokenProgram:       svm.TokenProgramAddress,
			VoucherSigner:      batchsettlement.VoucherSignerClient,
			WithdrawDelay:      900,
		}
		scheme.hooks.resolveTerms = func(context.Context, batchsettlement.BatchChannelConfig, types.PaymentRequirements, VoucherModeBinding) (BatchTerms, error) {
			return terms, nil
		}
		scheme.hooks.deriveChannelID = func(context.Context, batchsettlement.BatchChannelConfig, string) (string, error) {
			return channelID, nil
		}
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel, nil
		}
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return nil, nil
		}
		scheme.hooks.distributeInstruction = func(context.Context, string, *generated.Channel, BatchTerms, types.PaymentRequirements) (solana.Instruction, error) {
			return solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress), nil, []byte{9}), nil
		}
		scheme.hooks.submitRedemption = func(_ context.Context, fee, net string, instructions []solana.Instruction, key, payer string) (durableResult, error) {
			fixture.submits = append(fixture.submits, submitCall{fee, net, instructions, key, payer})
			return durableResult{OK: true, Signature: signature}, nil
		}
		scheme.hooks.sealDependencies = func() SealDependencies {
			deps := scheme.defaultSealDependencies()
			deps.NowSeconds = func() int64 { return sealNow }
			return deps
		}
		fixture.scheme = scheme
		return fixture
	}
	sealPayload := func(t *testing.T, cumulative uint64) batchsettlement.BatchSealPayload {
		t.Helper()
		voucherSig, err := paymentchannels.SignVoucher(context.Background(), ed25519Signer{payer}, open.ChannelID, cumulative, batchsettlement.ClientVoucherExpiresAt)
		require.NoError(t, err)
		closeAuth, err := batchsettlement.SignCloseAuthorization(context.Background(), ed25519Signer{authorizer}, batchsettlement.CloseAuthorizationBinding{
			Network:            network,
			FeePayer:           feePayer.PublicKey().String(),
			ChannelID:          channelID,
			MaxClaimableAmount: new(big.Int).SetUint64(cumulative),
			VoucherExpiresAt:   batchsettlement.ClientVoucherExpiresAt,
			ValidBefore:        sealNow + 120,
		})
		require.NoError(t, err)
		return batchsettlement.BatchSealPayload{
			Type:               batchsettlement.PayloadTypeSeal,
			ChannelID:          channelID,
			ChannelConfig:      config,
			Voucher:            batchsettlement.BatchVoucher{ChannelID: channelID, MaxClaimableAmount: uintString(cumulative), ExpiresAt: 0, Signature: voucherSig},
			CloseAuthorization: &closeAuth,
		}
	}
	refundPayload := func(t *testing.T, cumulative uint64) batchsettlement.BatchRefundPayload {
		t.Helper()
		payload := sealPayload(t, cumulative)
		return batchsettlement.BatchRefundPayload{
			Type:               batchsettlement.PayloadTypeRefund,
			ChannelConfig:      config,
			Voucher:            &payload.Voucher,
			CloseAuthorization: payload.CloseAuthorization,
		}
	}
	settle := func(t *testing.T, scheme *BatchSvmScheme, payload any) *x402.SettleResponse {
		t.Helper()
		response, err := scheme.Settle(context.Background(), types.PaymentPayload{
			X402Version: 2,
			Accepted:    requirements,
			Payload:     asMap(t, payload),
		}, requirements, nil)
		require.NoError(t, err)
		return response
	}

	t.Run("accepts only a well-formed seal payload", func(t *testing.T) {
		payload := sealPayload(t, 3_000)
		assert.True(t, batchsettlement.IsBatchFacilitatorPayload(asMap(t, payload)))
		without := payload
		without.CloseAuthorization = nil
		assert.True(t, batchsettlement.IsBatchFacilitatorPayload(asMap(t, without)))
		record := asMap(t, payload)
		delete(record, "voucher")
		assert.False(t, batchsettlement.IsBatchFacilitatorPayload(record))
		bad := asMap(t, payload)
		bad["closeAuthorization"] = map[string]any{"signature": "x", "validBefore": 0}
		assert.False(t, batchsettlement.IsBatchFacilitatorPayload(bad))
	})

	t.Run("applies the final voucher with settle_and_seal and a sealed distribute in one transaction", func(t *testing.T) {
		payouts := &payoutLog{}
		fixture := facilitator(t, nil, true, func(cfg *Config) { cfg.OnDistributionConfirmed = payouts.record })
		payload := sealPayload(t, 3_000)
		response := settle(t, fixture.scheme, payload)
		assert.True(t, response.Success)
		assert.Equal(t, "2500", response.Amount)
		assert.Equal(t, "2500", response.Extra["paidToReceiver"])
		assert.Equal(t, payer.PublicKey().String(), response.Payer)
		assert.Equal(t, signature, response.Transaction)
		state := response.Extra["channelState"].(batchsettlement.BatchChannelState)
		assert.Equal(t, "10000", state.Balance)
		assert.Equal(t, channelID, state.ChannelID)
		assert.Equal(t, "3000", state.TotalClaimed)
		assert.Zero(t, state.WithdrawRequestedAt)
		require.Len(t, fixture.submits, 1)
		assert.Equal(t, feePayer.PublicKey().String(), fixture.submits[0].feePayer)
		assert.Equal(t, network, fixture.submits[0].network)
		assert.Len(t, fixture.submits[0].instructions, 3)
		assert.Equal(t, "batch:seal:"+network+":"+channelID+":3000", fixture.submits[0].key)
		calls := payouts.calls()
		require.Len(t, calls, 1)
		assert.Equal(t, "2500", calls[0].response.Amount)
		assert.Equal(t, signature, calls[0].response.Transaction)
		assert.Equal(t, requirements, calls[0].requirements)

		again := settle(t, fixture.scheme, sealPayload(t, 3_000))
		assert.True(t, again.Success)
		assert.Equal(t, "2500", again.Amount)
		assert.Len(t, fixture.submits, 1)
		assert.Len(t, payouts.calls(), 1)
	})

	t.Run("retries payout recording from the durable seal result without rebroadcasting", func(t *testing.T) {
		payouts := &payoutLog{onFirst: func() error { return errors.New("ledger unavailable") }}
		fixture := facilitator(t, nil, true, func(cfg *Config) { cfg.OnDistributionConfirmed = payouts.record })
		payload := sealPayload(t, 3_000)

		pending := settle(t, fixture.scheme, payload)
		assert.False(t, pending.Success)
		assert.Equal(t, x402.ErrSettlementPending, pending.ErrorReason)
		assert.Equal(t, signature, pending.Transaction)
		assert.Equal(t, payer.PublicKey().String(), pending.Payer)

		recovered := settle(t, fixture.scheme, payload)
		assert.True(t, recovered.Success)
		assert.Equal(t, "2500", recovered.Amount)
		assert.Equal(t, "2500", recovered.Extra["paidToReceiver"])
		assert.Equal(t, signature, recovered.Transaction)
		assert.Len(t, fixture.submits, 1)
		calls := payouts.calls()
		require.Len(t, calls, 2)
		assert.Equal(t, "2500", calls[1].response.Amount)

		assert.True(t, settle(t, fixture.scheme, payload).Success)
		assert.Len(t, payouts.calls(), 2)
	})

	t.Run("seals at the current watermark without a precompile when the voucher equals settled", func(t *testing.T) {
		fixture := facilitator(t, nil, true)
		response := settle(t, fixture.scheme, sealPayload(t, 1_000))
		assert.True(t, response.Success)
		assert.Equal(t, "500", response.Amount)
		require.Len(t, fixture.submits, 1)
		assert.Len(t, fixture.submits[0].instructions, 2)
	})

	t.Run("refuses channels that are not closing or whose grace period has elapsed", func(t *testing.T) {
		openChannel := facilitator(t, live(func(channel *generated.Channel) {
			channel.Status = uint8(generated.ChannelStatus_Open)
			channel.ClosureStartedAt = 0
		}), true)
		response := settle(t, openChannel.scheme, sealPayload(t, 3_000))
		assert.False(t, response.Success)
		assert.Equal(t, batchsettlement.ErrCloseState, response.ErrorReason)

		late := facilitator(t, live(func(channel *generated.Channel) {
			channel.ClosureStartedAt = sealNow - 900
		}), true)
		response = settle(t, late.scheme, sealPayload(t, 3_000))
		assert.False(t, response.Success)
		assert.Equal(t, batchsettlement.ErrCloseState, response.ErrorReason)

		behind := facilitator(t, nil, true)
		response = settle(t, behind.scheme, sealPayload(t, 999))
		assert.False(t, response.Success)
		assert.Equal(t, batchsettlement.ErrCloseState, response.ErrorReason)

		above := facilitator(t, nil, true)
		response = settle(t, above.scheme, sealPayload(t, 10_001))
		assert.False(t, response.Success)
		assert.Equal(t, batchsettlement.ErrCloseState, response.ErrorReason)
		assert.Empty(t, openChannel.submits)
	})

	t.Run("authenticates the server through the receiver authorizer bound at deposit", func(t *testing.T) {
		payload := sealPayload(t, 3_000)
		missing := facilitator(t, nil, true)
		without := payload
		without.CloseAuthorization = nil
		response := settle(t, missing.scheme, without)
		assert.False(t, response.Success)
		assert.Equal(t, batchsettlement.ErrCloseAuthorization, response.ErrorReason)

		forged := facilitator(t, nil, true)
		impostor := mustKey(t)
		forgedAuth, err := batchsettlement.SignCloseAuthorization(context.Background(), ed25519Signer{impostor}, batchsettlement.CloseAuthorizationBinding{
			Network: network, FeePayer: feePayer.PublicKey().String(), ChannelID: channelID,
			MaxClaimableAmount: new(big.Int).SetUint64(3_000), ValidBefore: sealNow + 120,
		})
		require.NoError(t, err)
		forgedPayload := payload
		forgedPayload.CloseAuthorization = &forgedAuth
		response = settle(t, forged.scheme, forgedPayload)
		assert.False(t, response.Success)
		assert.Equal(t, batchsettlement.ErrCloseAuthorization, response.ErrorReason)

		stale := facilitator(t, nil, true)
		older := sealPayload(t, 2_000)
		older.CloseAuthorization = payload.CloseAuthorization
		response = settle(t, stale.scheme, older)
		assert.False(t, response.Success)
		assert.Equal(t, batchsettlement.ErrCloseAuthorization, response.ErrorReason)

		unbound := facilitator(t, nil, false)
		response = settle(t, unbound.scheme, payload)
		assert.False(t, response.Success)
		assert.Equal(t, batchsettlement.ErrReceiverBindingUnavailable, response.ErrorReason)

		rebound := facilitator(t, nil, false)
		_, err = rebound.storage.RecordOpen(context.Background(), paymentchannels.PaymentChannelRecord{
			Network: network, ChannelID: channelID, ReceiverAuthorizer: payer.PublicKey().String(), LastActivityAt: time.Now(),
		})
		require.NoError(t, err)
		response = settle(t, rebound.scheme, payload)
		assert.False(t, response.Success)
		assert.Equal(t, batchsettlement.ErrReceiverAuthorizerMismatch, response.ErrorReason)
		assert.Empty(t, missing.submits)
		assert.Empty(t, forged.submits)
		assert.Empty(t, stale.submits)
		assert.Empty(t, unbound.submits)
	})

	t.Run("refunds an open channel cooperatively with the server-authorized voucher", func(t *testing.T) {
		refund := func(t *testing.T, cumulative uint64, configure ...func(*Config)) (*sealFixture, *x402.SettleResponse) {
			t.Helper()
			fixture := facilitator(t, openLive, true, configure...)
			return fixture, settle(t, fixture.scheme, refundPayload(t, cumulative))
		}
		payouts := &payoutLog{}
		above, response := refund(t, 3_000, func(cfg *Config) { cfg.OnDistributionConfirmed = payouts.record })
		assert.True(t, response.Success)
		assert.Equal(t, "7000", response.Amount)
		assert.Equal(t, "2500", response.Extra["paidToReceiver"])
		assert.Equal(t, signature, response.Transaction)
		state := response.Extra["channelState"].(batchsettlement.BatchChannelState)
		assert.Equal(t, channelID, state.ChannelID)
		assert.Zero(t, state.WithdrawRequestedAt)
		require.Len(t, above.submits, 1)
		assert.Len(t, above.submits[0].instructions, 3)
		assert.Equal(t, "batch:refund:"+network+":"+channelID+":3000", above.submits[0].key)
		calls := payouts.calls()
		require.Len(t, calls, 1)
		assert.Equal(t, "2500", calls[0].response.Amount)
		assert.Equal(t, requirements, calls[0].requirements)

		again := settle(t, above.scheme, refundPayload(t, 3_000))
		fresh, err := json.Marshal(response)
		require.NoError(t, err)
		replayed, err := json.Marshal(again)
		require.NoError(t, err)
		assert.JSONEq(t, string(fresh), string(replayed))
		assert.Len(t, above.submits, 1)
		assert.Len(t, payouts.calls(), 1)

		equal, response := refund(t, 1_000)
		assert.True(t, response.Success)
		assert.Equal(t, "9000", response.Amount)
		require.Len(t, equal.submits, 1)
		assert.Len(t, equal.submits[0].instructions, 2)

		payload := sealPayload(t, 3_000)
		closing := facilitator(t, live(nil), true)
		response = settle(t, closing.scheme, batchsettlement.BatchRefundPayload{
			Type:               batchsettlement.PayloadTypeRefund,
			ChannelConfig:      config,
			Voucher:            &payload.Voucher,
			CloseAuthorization: payload.CloseAuthorization,
		})
		assert.False(t, response.Success)
		assert.Equal(t, batchsettlement.ErrCloseState, response.ErrorReason)
	})

	t.Run("recovers refund recording with the receiver amount without rebroadcasting", func(t *testing.T) {
		payouts := &payoutLog{onFirst: func() error { return errors.New("ledger unavailable") }}
		fixture := facilitator(t, openLive, true, func(cfg *Config) { cfg.OnDistributionConfirmed = payouts.record })
		payload := refundPayload(t, 3_000)

		pending := settle(t, fixture.scheme, payload)
		assert.False(t, pending.Success)
		assert.Equal(t, x402.ErrSettlementPending, pending.ErrorReason)
		assert.Equal(t, signature, pending.Transaction)
		assert.Equal(t, payer.PublicKey().String(), pending.Payer)

		recovered := settle(t, fixture.scheme, payload)
		assert.True(t, recovered.Success)
		assert.Equal(t, "7000", recovered.Amount)
		assert.Equal(t, "2500", recovered.Extra["paidToReceiver"])
		assert.Equal(t, signature, recovered.Transaction)
		calls := payouts.calls()
		require.Len(t, calls, 2)
		assert.Equal(t, "2500", calls[1].response.Amount)
		assert.Len(t, fixture.submits, 1)

		assert.Equal(t, recovered, settle(t, fixture.scheme, payload))
		assert.Len(t, payouts.calls(), 2)
	})

	t.Run("keeps a legacy refund result pending when the merchant credit was not stored", func(t *testing.T) {
		store := NewInMemoryPendingSettlementStore()
		key := "batch:refund:" + network + ":" + channelID + ":3000:result"
		encoded, err := json.Marshal(x402.SettleResponse{
			Success:     true,
			Payer:       payer.PublicKey().String(),
			Transaction: signature,
			Network:     x402.Network(network),
			Amount:      "7000",
		})
		require.NoError(t, err)
		require.NoError(t, store.Set(context.Background(), key, string(encoded)))
		calls := 0
		fixture := facilitator(t, openLive, true, func(cfg *Config) {
			cfg.PendingSettlementStore = store
			cfg.OnDistributionConfirmed = func(context.Context, *x402.SettleResponse, types.PaymentRequirements) error {
				calls++
				return nil
			}
		})
		pending := settle(t, fixture.scheme, refundPayload(t, 3_000))
		assert.False(t, pending.Success)
		assert.Equal(t, x402.ErrSettlementPending, pending.ErrorReason)
		assert.Equal(t, signature, pending.Transaction)
		assert.Equal(t, payer.PublicKey().String(), pending.Payer)
		assert.Contains(t, pending.ErrorMessage, "paidToReceiver")
		assert.Empty(t, fixture.submits)
		assert.Zero(t, calls)
	})

	for _, tc := range []struct {
		intent CloseIntent
		fail   bool
	}{
		{CloseIntentSeal, false},
		{CloseIntentRefund, false},
		{CloseIntentSeal, true},
		{CloseIntentRefund, true},
	} {
		t.Run(fmt.Sprintf("coalesces overlapping %s accounting across schemes (callback failure: %t)", tc.intent, tc.fail), func(t *testing.T) {
			channel, payload, amount := live(nil), any(sealPayload(t, 3_000)), "2500"
			if tc.intent == CloseIntentRefund {
				channel, payload, amount = openLive, refundPayload(t, 3_000), "7000"
			}
			store := &readSignalStore{
				PendingSettlementStore: NewInMemoryPendingSettlementStore(),
				key:                    fmt.Sprintf("batch:%s:%s:%s:3000:result", tc.intent, network, channelID),
				read:                   make(chan struct{}, 1),
			}
			entered := make(chan struct{})
			release := make(chan struct{})
			payouts := &payoutLog{onFirst: func() error {
				close(entered)
				<-release
				if tc.fail {
					return errors.New("ledger unavailable")
				}
				return nil
			}}
			configure := func(cfg *Config) {
				cfg.PendingSettlementStore = store
				cfg.OnDistributionConfirmed = payouts.record
			}
			type outcome struct {
				response *x402.SettleResponse
				err      error
			}
			start := func(scheme *BatchSvmScheme) <-chan outcome {
				request := types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: asMap(t, payload)}
				done := make(chan outcome, 1)
				go func() {
					response, err := scheme.Settle(context.Background(), request, requirements, nil)
					done <- outcome{response, err}
				}()
				return done
			}
			first := facilitator(t, channel, true, configure)
			second := facilitator(t, channel, true, configure)

			firstDone := start(first.scheme)
			select {
			case <-entered:
			case <-time.After(10 * time.Second):
				t.Fatal("the first callback never started")
			}
			secondDone := start(second.scheme)
			select {
			case <-store.read:
			case <-time.After(10 * time.Second):
				t.Fatal("the second scheme never read the durable close result")
			}
			var secondOutcome outcome
			finishedBeforeRelease := false
			select {
			case secondOutcome = <-secondDone:
				finishedBeforeRelease = true
			case <-time.After(100 * time.Millisecond):
			}
			callsWhilePending := len(payouts.calls())
			close(release)
			firstOutcome := <-firstDone
			if !finishedBeforeRelease {
				secondOutcome = <-secondDone
			}

			assert.False(t, finishedBeforeRelease)
			assert.Equal(t, 1, callsWhilePending)
			require.NoError(t, firstOutcome.err)
			require.NoError(t, secondOutcome.err)
			assert.Equal(t, firstOutcome.response, secondOutcome.response)
			if tc.fail {
				assert.False(t, firstOutcome.response.Success)
				assert.Equal(t, x402.ErrSettlementPending, firstOutcome.response.ErrorReason)
				assert.Equal(t, signature, firstOutcome.response.Transaction)
			} else {
				assert.True(t, firstOutcome.response.Success)
				assert.Equal(t, amount, firstOutcome.response.Amount)
			}
			assert.Len(t, first.submits, 1)
			assert.Empty(t, second.submits)

			restarted := facilitator(t, channel, true, configure)
			recovered := settle(t, restarted.scheme, payload)
			assert.True(t, recovered.Success)
			assert.Equal(t, amount, recovered.Amount)
			assert.Equal(t, "2500", recovered.Extra["paidToReceiver"])
			assert.Equal(t, signature, recovered.Transaction)
			calls := payouts.calls()
			if tc.fail {
				require.Len(t, calls, 2)
			} else {
				require.Len(t, calls, 1)
			}
			assert.Equal(t, "2500", calls[len(calls)-1].response.Amount)
			assert.Empty(t, restarted.submits)
			assert.Equal(t, recovered, settle(t, restarted.scheme, payload))
			assert.Len(t, payouts.calls(), len(calls))
		})
	}

	t.Run("rejects a claim against a closing channel with the dedicated code", func(t *testing.T) {
		fixture := facilitator(t, nil, true)
		voucherSig, err := paymentchannels.SignVoucher(context.Background(), ed25519Signer{payer}, open.ChannelID, 3_000, 0)
		require.NoError(t, err)
		response := settle(t, fixture.scheme, batchsettlement.BatchClaimPayload{
			Type: batchsettlement.PayloadTypeClaim,
			Claims: []batchsettlement.BatchVoucherClaim{{
				ChannelID:     channelID,
				ChannelConfig: config,
				Voucher: batchsettlement.BatchVoucher{
					ChannelID: channelID, ExpiresAt: 0, MaxClaimableAmount: "3000", Signature: voucherSig,
				},
			}},
		})
		assert.False(t, response.Success)
		assert.Equal(t, batchsettlement.ErrChannelClosing, response.ErrorReason)
	})
}

type submitCall struct {
	feePayer     string
	network      string
	instructions []solana.Instruction
	key          string
	payer        string
}

type payoutCall struct {
	response     x402.SettleResponse
	requirements types.PaymentRequirements
}

type payoutLog struct {
	mu      sync.Mutex
	entries []payoutCall
	onFirst func() error
}

func (l *payoutLog) record(_ context.Context, response *x402.SettleResponse, requirements types.PaymentRequirements) error {
	l.mu.Lock()
	l.entries = append(l.entries, payoutCall{response: *response, requirements: requirements})
	isFirst := len(l.entries) == 1
	l.mu.Unlock()
	if isFirst && l.onFirst != nil {
		return l.onFirst()
	}
	return nil
}

func (l *payoutLog) calls() []payoutCall {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]payoutCall(nil), l.entries...)
}

type readSignalStore struct {
	PendingSettlementStore
	key  string
	read chan struct{}
}

func (s *readSignalStore) Get(ctx context.Context, key string) (string, bool, error) {
	value, ok, err := s.PendingSettlementStore.Get(ctx, key)
	if ok && key == s.key {
		select {
		case s.read <- struct{}{}:
		default:
		}
	}
	return value, ok, err
}

func uintString(value uint64) string {
	return new(big.Int).SetUint64(value).String()
}
