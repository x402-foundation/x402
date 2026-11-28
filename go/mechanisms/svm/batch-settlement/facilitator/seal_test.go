package facilitator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
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
	sealedAt3000 := func() *generated.Channel {
		return live(func(channel *generated.Channel) {
			channel.Status = uint8(generated.ChannelStatus_Sealed)
			channel.Settlement = generated.SettlementWatermarks{Settled: 3_000, PayoutWatermark: 3_000}
		})
	}
	const signature = "signature"
	// closeCumulative is the voucher of the latest close payload built.
	var closeCumulative uint64
	type sealFixture struct {
		scheme  *BatchSvmScheme
		signer  *capabilitySigner
		storage *activityRecordingStorage
		submits []submitCall
		// attribute reads the confirmed close; by default it reports a close that no sweep raced.
		attribute func(context.Context, string, types.PaymentRequirements, BatchTerms, string) (CloseAttribution, error)
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
		fixture.signer = &capabilitySigner{scriptedSigner: newScriptedSigner(t, 1)}
		scheme := NewBatchSvmScheme(context.Background(), fixture.signer, cfg)
		scheme.hooks.waitForChannelRead = func(int) error { return nil }
		fixture.attribute = func(context.Context, string, types.PaymentRequirements, BatchTerms, string) (CloseAttribution, error) {
			return CloseAttribution{
				PaidToReceiver:  closeCumulative - channel.Settlement.PayoutWatermark,
				RefundedToPayer: channel.Deposit - closeCumulative,
			}, nil
		}
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
			deps.AttributeClose = fixture.attribute
			return deps
		}
		fixture.scheme = scheme
		return fixture
	}
	sealPayload := func(t *testing.T, cumulative uint64) batchsettlement.BatchSealPayload {
		t.Helper()
		closeCumulative = cumulative
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
	settleThrown := func(t *testing.T, scheme *BatchSvmScheme, payload any) *x402.SettleError {
		t.Helper()
		response, err := scheme.Settle(context.Background(), types.PaymentPayload{
			X402Version: 2,
			Accepted:    requirements,
			Payload:     asMap(t, payload),
		}, requirements, nil)
		require.Nil(t, response)
		var settleErr *x402.SettleError
		require.ErrorAs(t, err, &settleErr)
		return settleErr
	}

	// attributing replaces the confirmed-transaction read a recovered close uses.
	attributing := func(fixture *sealFixture, attribution CloseAttribution, err error) {
		base := fixture.scheme.hooks.sealDependencies
		fixture.scheme.hooks.sealDependencies = func() SealDependencies {
			deps := base()
			deps.AttributeClose = func(context.Context, string, types.PaymentRequirements, BatchTerms, string) (CloseAttribution, error) {
				return attribution, err
			}
			return deps
		}
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
		reads := 0
		fixture.scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			reads++
			return live(nil), nil
		}
		payload := sealPayload(t, 3_000)
		response := settle(t, fixture.scheme, payload)
		assert.True(t, response.Success)
		assert.Zero(t, reads, "a close reads the confirmed transaction, not the channel")
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

		_, stored, err := fixture.scheme.payoutStore.Get(context.Background(), resultKey("batch:seal:"+network+":"+channelID+":3000"))
		require.NoError(t, err)
		assert.False(t, stored, "the payout record is deleted once the hook has run")

		fixture.scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return sealedAt3000(), nil
		}
		again := settle(t, fixture.scheme, sealPayload(t, 3_000))
		assert.False(t, again.Success)
		assert.Equal(t, batchsettlement.ErrCloseState, again.ErrorReason)
		assert.Len(t, fixture.submits, 1)
		assert.Len(t, payouts.calls(), 1)
	})

	t.Run("fails a hookless seal retry with close_state and writes no payout record", func(t *testing.T) {
		fixture := facilitator(t, nil, true)
		first := settle(t, fixture.scheme, sealPayload(t, 3_000))
		assert.True(t, first.Success)
		_, stored, err := fixture.scheme.pendingStore.Get(context.Background(), resultKey("batch:seal:"+network+":"+channelID+":3000"))
		require.NoError(t, err)
		assert.False(t, stored)

		fixture.scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return sealedAt3000(), nil
		}
		again := settle(t, fixture.scheme, sealPayload(t, 3_000))
		assert.False(t, again.Success)
		assert.Equal(t, batchsettlement.ErrCloseState, again.ErrorReason)
		assert.Empty(t, again.Transaction)
		assert.Equal(t, payer.PublicKey().String(), again.Payer)
		assert.Equal(t, map[string]any{batchsettlement.ExtraChannelStates: []batchsettlement.BatchRedemptionChannelState{{
			ChannelID: channelID, Status: batchsettlement.ChannelStatusSealed, Balance: "10000", TotalClaimed: "3000", PayoutWatermark: "3000",
		}}}, again.Extra)
		assert.Len(t, fixture.submits, 1)
	})

	t.Run("answers a seal retry that finds the channel distributed with that state, with the payout hook set", func(t *testing.T) {
		payouts := &payoutLog{}
		fixture := facilitator(t, nil, true, func(cfg *Config) { cfg.OnDistributionConfirmed = payouts.record })
		require.True(t, settle(t, fixture.scheme, sealPayload(t, 3_000)).Success)

		fixture.scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return live(func(channel *generated.Channel) {
				channel.Status = uint8(generated.ChannelStatus_Distributed)
				channel.Settlement = generated.SettlementWatermarks{Settled: 3_000, PayoutWatermark: 3_000}
			}), nil
		}
		again := settle(t, fixture.scheme, sealPayload(t, 3_000))
		assert.False(t, again.Success)
		assert.Equal(t, batchsettlement.ErrCloseState, again.ErrorReason)
		assert.Equal(t, map[string]any{batchsettlement.ExtraChannelStates: []batchsettlement.BatchRedemptionChannelState{{
			ChannelID: channelID, Status: batchsettlement.ChannelStatusDistributed, Balance: "10000", TotalClaimed: "3000", PayoutWatermark: "3000",
		}}}, again.Extra)
		assert.Len(t, fixture.submits, 1)
		assert.Len(t, payouts.calls(), 1)
	})

	t.Run("answers a voucher below settled with the closing channel state and no broadcast", func(t *testing.T) {
		fixture := facilitator(t, nil, true)
		response := settle(t, fixture.scheme, sealPayload(t, 999))
		assert.False(t, response.Success)
		assert.Equal(t, batchsettlement.ErrCloseState, response.ErrorReason)
		assert.Equal(t, map[string]any{batchsettlement.ExtraChannelStates: []batchsettlement.BatchRedemptionChannelState{{
			ChannelID: channelID, Status: batchsettlement.ChannelStatusClosing, Balance: "10000", TotalClaimed: "1000", PayoutWatermark: "500", WithdrawRequestedAt: sealNow - 60,
		}}}, response.Extra)
		assert.Empty(t, fixture.submits)
	})

	t.Run("rejects a channel that does not match the configuration before revealing its state", func(t *testing.T) {
		fixture := facilitator(t, live(func(channel *generated.Channel) {
			channel.Status = uint8(generated.ChannelStatus_Sealed)
		}), true)
		deps := fixture.scheme.defaultSealDependencies()
		deps.NowSeconds = func() int64 { return sealNow }
		deps.AssertClaimChannel = func(*generated.Channel, batchsettlement.BatchChannelConfig, BatchTerms, types.PaymentRequirements, []generated.ChannelStatus) error {
			return errors.New(batchsettlement.ErrChannelState)
		}
		fixture.scheme.hooks.sealDependencies = func() SealDependencies { return deps }
		response := settle(t, fixture.scheme, sealPayload(t, 3_000))
		assert.False(t, response.Success)
		assert.NotEqual(t, batchsettlement.ErrCloseState, response.ErrorReason)
		assert.NotContains(t, response.Extra, batchsettlement.ExtraChannelStates)
	})

	t.Run("answers a seal whose channel is absent past open_slot + OpenSlotWindow with closed channel state", func(t *testing.T) {
		fixture := facilitator(t, nil, true)
		fixture.scheme.hooks.fetchChannel = nil
		fixture.scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return nil, nil
		}
		fixture.signer.clusterSlot = uint64(config.OpenSlot) + paymentchannels.OpenSlotWindow + 1

		response := settle(t, fixture.scheme, sealPayload(t, 3_000))
		assert.False(t, response.Success)
		assert.Equal(t, batchsettlement.ErrChannelState, response.ErrorReason)
		assert.Equal(t, payer.PublicKey().String(), response.Payer)
		assert.Equal(t, map[string]any{batchsettlement.ExtraChannelStates: []batchsettlement.BatchRedemptionChannelState{{
			ChannelID: channelID, Status: batchsettlement.ChannelStatusClosed, Balance: "0", TotalClaimed: "0", PayoutWatermark: "0",
		}}}, response.Extra)
		assert.Empty(t, fixture.submits)
	})

	t.Run("does not report closed state on seal within open_slot + OpenSlotWindow or on cooperative refund", func(t *testing.T) {
		fixture := facilitator(t, nil, true)
		fixture.scheme.hooks.fetchChannel = nil
		fixture.scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return nil, nil
		}
		fixture.signer.clusterSlot = uint64(config.OpenSlot) + paymentchannels.OpenSlotWindow

		withinWindow := settle(t, fixture.scheme, sealPayload(t, 3_000))
		assert.False(t, withinWindow.Success)
		assert.Equal(t, batchsettlement.ErrChannelState, withinWindow.ErrorReason)
		assert.NotContains(t, withinWindow.Extra, batchsettlement.ExtraChannelStates)

		fixture.signer.clusterSlot = uint64(config.OpenSlot) + paymentchannels.OpenSlotWindow + 1
		refund := settle(t, fixture.scheme, refundPayload(t, 3_000))
		assert.False(t, refund.Success)
		assert.Equal(t, batchsettlement.ErrChannelState, refund.ErrorReason)
		assert.NotContains(t, refund.Extra, batchsettlement.ExtraChannelStates)
		assert.Empty(t, fixture.submits)
	})

	t.Run("answers settlement_pending and keeps the payout record when deleting it fails", func(t *testing.T) {
		store := &resultDeleteFailingStore{PendingSettlementStore: x402.NewInMemoryPendingSettlementStore()}
		store.fail.Store(true)
		payouts := &payoutLog{}
		fixture := facilitator(t, nil, true, func(cfg *Config) {
			cfg.PayoutStore = store
			cfg.OnDistributionConfirmed = payouts.record
		})
		payload := sealPayload(t, 3_000)

		pending := settleThrown(t, fixture.scheme, payload)
		assert.Equal(t, x402.ErrSettlementPending, pending.ErrorReason)
		assert.Equal(t, signature, pending.Transaction)
		_, stored, err := store.Get(context.Background(), resultKey("batch:seal:"+network+":"+channelID+":3000"))
		require.NoError(t, err)
		assert.True(t, stored)

		store.fail.Store(false)
		recovered := settle(t, fixture.scheme, payload)
		assert.True(t, recovered.Success)
		assert.Equal(t, signature, recovered.Transaction)
		assert.Len(t, fixture.submits, 1)
		assert.Len(t, payouts.calls(), 2, "the hook runs again because the record outlived it")
		_, stored, err = store.Get(context.Background(), resultKey("batch:seal:"+network+":"+channelID+":3000"))
		require.NoError(t, err)
		assert.False(t, stored)
	})

	t.Run("retries payout recording from the durable seal result without rebroadcasting", func(t *testing.T) {
		payouts := &payoutLog{onFirst: func() error { return errors.New("ledger unavailable") }}
		fixture := facilitator(t, nil, true, func(cfg *Config) { cfg.OnDistributionConfirmed = payouts.record })
		payload := sealPayload(t, 3_000)

		pending := settleThrown(t, fixture.scheme, payload)
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

		fixture.scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return sealedAt3000(), nil
		}
		finished := settle(t, fixture.scheme, payload)
		assert.False(t, finished.Success)
		assert.Equal(t, batchsettlement.ErrCloseState, finished.ErrorReason)
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
			reads := 0
			fixture.scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
				reads++
				return openLive, nil
			}
			response := settle(t, fixture.scheme, refundPayload(t, cumulative))
			assert.Zero(t, reads, "a refund reads the confirmed transaction, not the channel")
			return fixture, response
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

		above.scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return sealedAt3000(), nil
		}
		again := settle(t, above.scheme, refundPayload(t, 3_000))
		assert.False(t, again.Success)
		assert.Equal(t, batchsettlement.ErrCloseState, again.ErrorReason)
		assert.Empty(t, again.Transaction)
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

		pending := settleThrown(t, fixture.scheme, payload)
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

		fixture.scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return sealedAt3000(), nil
		}
		finished := settle(t, fixture.scheme, payload)
		assert.False(t, finished.Success)
		assert.Equal(t, batchsettlement.ErrCloseState, finished.ErrorReason)
		assert.Len(t, payouts.calls(), 2)
	})

	for _, intent := range []CloseIntent{CloseIntentSeal, CloseIntentRefund} {
		for _, withHook := range []bool{false, true} {
			t.Run(fmt.Sprintf("answers the retry of a %s that timed out and then landed (payout hook: %t)", intent, withHook), func(t *testing.T) {
				channel, payload, amount := live(nil), any(sealPayload(t, 3_000)), "2500"
				if intent == CloseIntentRefund {
					channel, payload, amount = openLive, refundPayload(t, 3_000), "7000"
				}
				payouts := &payoutLog{}
				fixture := facilitator(t, channel, true, func(cfg *Config) {
					if withHook {
						cfg.OnDistributionConfirmed = payouts.record
					}
				})
				attributing(fixture, CloseAttribution{PaidToReceiver: 2_500, RefundedToPayer: 7_000}, nil)
				ctx := context.Background()
				key := fmt.Sprintf("batch:%s:%s:%s:3000", intent, network, channelID)
				// A timed-out broadcast leaves its record under the key, as sendDurably does.
				fixture.scheme.hooks.submitRedemption = func(_ context.Context, fee, net string, instructions []solana.Instruction, key, payerAddress string) (durableResult, error) {
					fixture.submits = append(fixture.submits, submitCall{fee, net, instructions, key, payerAddress})
					require.NoError(t, fixture.scheme.pendingStore.Set(ctx, key, signature))
					return durableResult{Response: SettlementPending(x402.Network(network), payerAddress, signature, "confirmation timed out")}, nil
				}
				request := types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: asMap(t, payload)}
				first, err := fixture.scheme.Settle(ctx, request, requirements, nil)
				require.Nil(t, first)
				var settleErr *x402.SettleError
				require.ErrorAs(t, err, &settleErr)
				assert.Equal(t, x402.ErrSettlementPending, settleErr.ErrorReason)

				// The close landed: the channel no longer has the status a new close needs.
				fixture.scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
					return live(func(channel *generated.Channel) {
						channel.Status = uint8(generated.ChannelStatus_Distributed)
						channel.Settlement = generated.SettlementWatermarks{Settled: 3_000, PayoutWatermark: 3_000}
					}), nil
				}
				fixture.scheme.hooks.reconcileBroadcast = func(context.Context, string, string, string, string) (durableResult, error) {
					return durableResult{OK: true, Signature: signature}, nil
				}
				// A lagging read that still shows the pre-close status does not hold back a confirmed close.
				fixture.scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
					return channel, nil
				}
				recovered := settle(t, fixture.scheme, payload)
				assert.True(t, recovered.Success, "a retry reconciles the remembered broadcast instead of failing with close_state")
				assert.Equal(t, amount, recovered.Amount)
				assert.Equal(t, "2500", recovered.Extra["paidToReceiver"], "the payout is read from the confirmed transaction")
				assert.Equal(t, signature, recovered.Transaction)
				assert.Len(t, fixture.submits, 1)
				if withHook {
					calls := payouts.calls()
					require.Len(t, calls, 1)
					assert.Equal(t, "2500", calls[0].response.Amount)
				}
				_, stored, err := fixture.scheme.pendingStore.Get(ctx, key)
				require.NoError(t, err)
				assert.False(t, stored)
				if withHook {
					_, stored, err = fixture.scheme.payoutStore.Get(ctx, resultKey(key))
					require.NoError(t, err)
					assert.False(t, stored)
				}

				again := settle(t, fixture.scheme, payload)
				assert.False(t, again.Success)
				assert.Equal(t, batchsettlement.ErrCloseState, again.ErrorReason)
				assert.Len(t, payouts.calls(), map[bool]int{false: 0, true: 1}[withHook], "the payout is not delivered twice")
			})
		}
	}

	for _, intent := range []CloseIntent{CloseIntentSeal, CloseIntentRefund} {
		t.Run(fmt.Sprintf("delivers the payout of a confirmed %s on retry when its payout record could not be written", intent), func(t *testing.T) {
			channel, payload, amount := live(nil), any(sealPayload(t, 3_000)), "2500"
			if intent == CloseIntentRefund {
				channel, payload, amount = openLive, refundPayload(t, 3_000), "7000"
			}
			payouts := &payoutLog{}
			fixture := facilitator(t, channel, true, func(cfg *Config) { cfg.OnDistributionConfirmed = payouts.record })
			attributing(fixture, CloseAttribution{PaidToReceiver: 2_500, RefundedToPayer: 7_000}, nil)
			store := &resultSetFailingStore{PendingSettlementStore: fixture.scheme.payoutStore}
			store.fail.Store(true)
			fixture.scheme.payoutStore = store
			ctx := context.Background()
			key := fmt.Sprintf("batch:%s:%s:%s:3000", intent, network, channelID)
			distributed := func() *generated.Channel {
				return live(func(channel *generated.Channel) {
					channel.Status = uint8(generated.ChannelStatus_Distributed)
					channel.Settlement = generated.SettlementWatermarks{Settled: 3_000, PayoutWatermark: 3_000}
				})
			}
			fixture.scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
				return distributed(), nil
			}

			first := settleThrown(t, fixture.scheme, payload)
			assert.Equal(t, x402.ErrSettlementPending, first.ErrorReason)
			assert.Equal(t, signature, first.Transaction)
			assert.Empty(t, payouts.calls())
			stored, found, err := fixture.scheme.pendingStore.Get(ctx, key)
			require.NoError(t, err)
			require.True(t, found, "the confirmed close keeps its signature for a retry")
			assert.Equal(t, signature, stored)

			// The close landed: the channel no longer has the status a new close needs.
			store.fail.Store(false)
			fixture.scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
				return distributed(), nil
			}
			fixture.scheme.hooks.reconcileBroadcast = func(context.Context, string, string, string, string) (durableResult, error) {
				return durableResult{OK: true, Signature: signature}, nil
			}
			recovered := settle(t, fixture.scheme, payload)
			assert.True(t, recovered.Success, "a retry reconciles the remembered close instead of failing with close_state")
			assert.Equal(t, amount, recovered.Amount)
			assert.Equal(t, "2500", recovered.Extra["paidToReceiver"])
			assert.Equal(t, signature, recovered.Transaction)
			assert.Len(t, fixture.submits, 1)
			calls := payouts.calls()
			require.Len(t, calls, 1)
			assert.Equal(t, "2500", calls[0].response.Amount)
			_, found, err = fixture.scheme.pendingStore.Get(ctx, key)
			require.NoError(t, err)
			assert.False(t, found)
			_, found, err = store.Get(ctx, resultKey(key))
			require.NoError(t, err)
			assert.False(t, found)

			again := settle(t, fixture.scheme, payload)
			assert.False(t, again.Success)
			assert.Equal(t, batchsettlement.ErrCloseState, again.ErrorReason)
			assert.Len(t, payouts.calls(), 1, "the payout is not delivered twice")
		})
	}

	// closeEvidence is a confirmed close that paid the receiver 2000 and returned 7000 to the payer.
	closeEvidence := func(t *testing.T) *svm.FacilitatorConfirmedTransaction {
		t.Helper()
		tokenProgram := solana.MustPublicKeyFromBase58(svm.TokenProgramAddress)
		mint := solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress)
		receiverATA, err := paymentchannels.FindATA(solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress), mint, tokenProgram)
		require.NoError(t, err)
		payerATA, err := paymentchannels.FindATA(payer.PublicKey(), mint, tokenProgram)
		require.NoError(t, err)
		balance := func(index int, owner, amount string) svm.FacilitatorTokenBalance {
			return svm.FacilitatorTokenBalance{AccountIndex: index, Mint: svm.USDCDevnetAddress, Owner: owner, UITokenAmount: svm.FacilitatorTokenAmount{Amount: amount}}
		}
		return &svm.FacilitatorConfirmedTransaction{
			Slot:        100,
			AccountKeys: []string{receiverATA.String(), payerATA.String()},
			Meta: &svm.FacilitatorConfirmedMeta{
				PreTokenBalances:  []svm.FacilitatorTokenBalance{balance(0, svm.USDCMainnetAddress, "200"), balance(1, payer.PublicKey().String(), "50")},
				PostTokenBalances: []svm.FacilitatorTokenBalance{balance(0, svm.USDCMainnetAddress, "2200"), balance(1, payer.PublicKey().String(), "7050")},
			},
		}
	}
	closeCase := func(t *testing.T, intent CloseIntent) (*generated.Channel, any) {
		t.Helper()
		if intent == CloseIntentRefund {
			return openLive, refundPayload(t, 3_000)
		}
		return live(nil), sealPayload(t, 3_000)
	}

	// attributeFromChain reads closes from the signer's confirmed transactions, under a signature it can decode.
	confirmedSignature := solana.Signature{1}.String()
	attributeFromChain := func(fixture *sealFixture, confirmed func() *svm.FacilitatorConfirmedTransaction) {
		fixture.attribute = fixture.scheme.attributeClose
		fixture.signer.confirmed = func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
			return confirmed(), nil
		}
		fixture.scheme.hooks.submitRedemption = func(_ context.Context, fee, net string, instructions []solana.Instruction, key, payerAddress string) (durableResult, error) {
			fixture.submits = append(fixture.submits, submitCall{fee, net, instructions, key, payerAddress})
			return durableResult{OK: true, Signature: confirmedSignature}, nil
		}
	}

	for _, intent := range []CloseIntent{CloseIntentSeal, CloseIntentRefund} {
		t.Run(fmt.Sprintf("pays and records a fresh %s from the confirmed transaction when a sweep moved the payout watermark after the channel read", intent), func(t *testing.T) {
			channel, payload := closeCase(t, intent)
			payouts := &payoutLog{onFirst: func() error { return errors.New("ledger unavailable") }}
			fixture := facilitator(t, channel, true, func(cfg *Config) { cfg.OnDistributionConfirmed = payouts.record })
			attributeFromChain(fixture, func() *svm.FacilitatorConfirmedTransaction { return closeEvidence(t) })
			wantAmount := map[CloseIntent]string{CloseIntentSeal: "2000", CloseIntentRefund: "7000"}[intent]

			pending := settleThrown(t, fixture.scheme, payload)
			assert.Equal(t, x402.ErrSettlementPending, pending.ErrorReason)
			key := fmt.Sprintf("batch:%s:%s:%s:3000", intent, network, channelID)
			encoded, stored, err := fixture.scheme.payoutStore.Get(context.Background(), resultKey(key))
			require.NoError(t, err)
			require.True(t, stored)
			var record x402.SettleResponse
			require.NoError(t, json.Unmarshal([]byte(encoded), &record))
			assert.Equal(t, wantAmount, record.Amount)
			assert.Equal(t, "2000", record.Extra["paidToReceiver"], "the stored payout is the verified one")

			recovered := settle(t, fixture.scheme, payload)
			assert.True(t, recovered.Success)
			assert.Equal(t, wantAmount, recovered.Amount, "a refund keeps the payer amount")
			assert.Equal(t, "2000", recovered.Extra["paidToReceiver"])
			calls := payouts.calls()
			require.Len(t, calls, 2)
			for _, call := range calls {
				assert.Equal(t, "2000", call.response.Amount, "the callback is given the verified payout")
			}
			assert.Len(t, fixture.submits, 1)
		})

		t.Run(fmt.Sprintf("reports the deposit and refund of a fresh %s from the confirmed transaction when a top-up raised the deposit after the channel read", intent), func(t *testing.T) {
			channel, payload := closeCase(t, intent)
			payouts := &payoutLog{onFirst: func() error { return errors.New("ledger unavailable") }}
			fixture := facilitator(t, channel, true, func(cfg *Config) { cfg.OnDistributionConfirmed = payouts.record })
			attributeFromChain(fixture, func() *svm.FacilitatorConfirmedTransaction {
				evidence := closeEvidence(t)
				evidence.Meta.PostTokenBalances[1].UITokenAmount.Amount = "12050"
				return evidence
			})
			wantAmount := map[CloseIntent]string{CloseIntentSeal: "2000", CloseIntentRefund: "12000"}[intent]

			pending := settleThrown(t, fixture.scheme, payload)
			assert.Equal(t, x402.ErrSettlementPending, pending.ErrorReason)
			key := fmt.Sprintf("batch:%s:%s:%s:3000", intent, network, channelID)
			encoded, stored, err := fixture.scheme.payoutStore.Get(context.Background(), resultKey(key))
			require.NoError(t, err)
			require.True(t, stored)
			var record x402.SettleResponse
			require.NoError(t, json.Unmarshal([]byte(encoded), &record))
			assert.Equal(t, wantAmount, record.Amount)
			assert.Equal(t, "15000", record.Extra["channelState"].(map[string]any)["balance"], "the stored balance is the deposit the close paid out")

			recovered := settle(t, fixture.scheme, payload)
			assert.True(t, recovered.Success)
			assert.Equal(t, wantAmount, recovered.Amount)
			assert.Equal(t, "2000", recovered.Extra["paidToReceiver"])
			assert.Equal(t, "15000", recovered.Extra["channelState"].(map[string]any)["balance"])
			assert.Len(t, payouts.calls(), 2)
		})

		t.Run(fmt.Sprintf("keeps a fresh %s pending while its transaction metadata is not visible and attributes it from the transaction on retry", intent), func(t *testing.T) {
			channel, payload := closeCase(t, intent)
			payouts := &payoutLog{}
			fixture := facilitator(t, channel, true, func(cfg *Config) { cfg.OnDistributionConfirmed = payouts.record })
			evidence := &svm.FacilitatorConfirmedTransaction{Slot: 100}
			attributeFromChain(fixture, func() *svm.FacilitatorConfirmedTransaction { return evidence })
			ctx := context.Background()
			key := fmt.Sprintf("batch:%s:%s:%s:3000", intent, network, channelID)

			pending := settleThrown(t, fixture.scheme, payload)
			assert.Equal(t, x402.ErrSettlementPending, pending.ErrorReason)
			assert.Equal(t, confirmedSignature, pending.Transaction)
			assert.Equal(t, ChannelReadAttempts, fixture.signer.confirmedCalls, "the metadata read is bounded")
			assert.Empty(t, payouts.calls(), "an unverified payout is never reported")
			recorded, stored, err := fixture.scheme.pendingStore.Get(ctx, key)
			require.NoError(t, err)
			require.True(t, stored, "the confirmed close is remembered for the retry")
			assert.Equal(t, confirmedSignature, recorded)
			_, stored, err = fixture.scheme.payoutStore.Get(ctx, resultKey(key))
			require.NoError(t, err)
			assert.False(t, stored)

			evidence = closeEvidence(t)
			fixture.scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
				return sealedAt3000(), nil
			}
			fixture.scheme.hooks.reconcileBroadcast = func(context.Context, string, string, string, string) (durableResult, error) {
				return durableResult{OK: true, Signature: confirmedSignature}, nil
			}
			recovered := settle(t, fixture.scheme, payload)
			assert.True(t, recovered.Success)
			assert.Equal(t, "2000", recovered.Extra["paidToReceiver"])
			require.Len(t, payouts.calls(), 1)
			assert.Equal(t, "2000", payouts.calls()[0].response.Amount)
			assert.Len(t, fixture.submits, 1)
			_, stored, err = fixture.scheme.pendingStore.Get(ctx, key)
			require.NoError(t, err)
			assert.False(t, stored)
		})

		t.Run(fmt.Sprintf("fails a fresh %s whose confirmed transaction cannot attribute the payout, without reporting one", intent), func(t *testing.T) {
			channel, payload := closeCase(t, intent)
			payouts := &payoutLog{}
			fixture := facilitator(t, channel, true, func(cfg *Config) { cfg.OnDistributionConfirmed = payouts.record })
			attributeFromChain(fixture, func() *svm.FacilitatorConfirmedTransaction {
				evidence := closeEvidence(t)
				evidence.AccountKeys = evidence.AccountKeys[:1]
				return evidence
			})

			failed := settleThrown(t, fixture.scheme, payload)
			assert.Equal(t, batchsettlement.ErrPayoutAttributionAmbiguous, failed.ErrorReason)
			assert.Equal(t, confirmedSignature, failed.Transaction)
			assert.Empty(t, payouts.calls())
			key := fmt.Sprintf("batch:%s:%s:%s:3000", intent, network, channelID)
			_, stored, err := fixture.scheme.pendingStore.Get(context.Background(), key)
			require.NoError(t, err)
			assert.False(t, stored)
			_, stored, err = fixture.scheme.payoutStore.Get(context.Background(), resultKey(key))
			require.NoError(t, err)
			assert.False(t, stored)
		})
	}

	t.Run("answers a retried close whose remembered broadcast failed onchain with that failure", func(t *testing.T) {
		fixture := facilitator(t, nil, true)
		ctx := context.Background()
		fixture.scheme.hooks.submitRedemption = func(_ context.Context, fee, net string, instructions []solana.Instruction, key, payerAddress string) (durableResult, error) {
			fixture.submits = append(fixture.submits, submitCall{fee, net, instructions, key, payerAddress})
			require.NoError(t, fixture.scheme.pendingStore.Set(ctx, key, signature))
			return durableResult{Response: SettlementPending(x402.Network(network), payerAddress, signature, "confirmation timed out")}, nil
		}
		request := types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: asMap(t, sealPayload(t, 3_000))}
		_, err := fixture.scheme.Settle(ctx, request, requirements, nil)
		require.Error(t, err)

		fixture.scheme.hooks.reconcileBroadcast = func(context.Context, string, string, string, string) (durableResult, error) {
			return durableResult{Response: SettleFailureWithTransaction(x402.Network(network), "transaction_failed", payer.PublicKey().String(), "failed", signature)}, nil
		}
		failed := settleThrown(t, fixture.scheme, sealPayload(t, 3_000))
		assert.Equal(t, "transaction_failed", failed.ErrorReason)
		assert.Equal(t, signature, failed.Transaction)
	})

	t.Run("keeps a recovered close pending until its transaction can be attributed, and fails it when it cannot be", func(t *testing.T) {
		ctx := context.Background()
		key := fmt.Sprintf("batch:seal:%s:%s:3000", network, channelID)
		fixture := facilitator(t, nil, true)
		fixture.scheme.hooks.submitRedemption = func(_ context.Context, fee, net string, instructions []solana.Instruction, key, payerAddress string) (durableResult, error) {
			fixture.submits = append(fixture.submits, submitCall{fee, net, instructions, key, payerAddress})
			require.NoError(t, fixture.scheme.pendingStore.Set(ctx, key, signature))
			return durableResult{Response: SettlementPending(x402.Network(network), payerAddress, signature, "confirmation timed out")}, nil
		}
		request := types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: asMap(t, sealPayload(t, 3_000))}
		_, err := fixture.scheme.Settle(ctx, request, requirements, nil)
		require.Error(t, err)
		fixture.scheme.hooks.reconcileBroadcast = func(context.Context, string, string, string, string) (durableResult, error) {
			return durableResult{OK: true, Signature: signature}, nil
		}

		attributing(fixture, CloseAttribution{}, errors.New("payout transaction metadata is not visible yet"))
		notYet := settleThrown(t, fixture.scheme, sealPayload(t, 3_000))
		assert.Equal(t, x402.ErrSettlementPending, notYet.ErrorReason)
		assert.Equal(t, signature, notYet.Transaction)
		_, stored, err := fixture.scheme.pendingStore.Get(ctx, key)
		require.NoError(t, err)
		assert.True(t, stored, "the broadcast stays remembered until the close is attributed")

		attributing(fixture, CloseAttribution{}, &PayoutAttributionAmbiguousError{})
		ambiguous := settleThrown(t, fixture.scheme, sealPayload(t, 3_000))
		assert.Equal(t, batchsettlement.ErrPayoutAttributionAmbiguous, ambiguous.ErrorReason)
		assert.Equal(t, signature, ambiguous.Transaction)
		_, stored, err = fixture.scheme.pendingStore.Get(ctx, key)
		require.NoError(t, err)
		assert.False(t, stored, "an unattributable close is not retried forever")

		require.NoError(t, fixture.scheme.pendingStore.Set(ctx, key, signature))
		attributing(fixture, CloseAttribution{PaidToReceiver: 2_500, RefundedToPayer: math.MaxUint64}, nil)
		overflow := settleThrown(t, fixture.scheme, sealPayload(t, 3_000))
		assert.Equal(t, batchsettlement.ErrPayoutAttributionAmbiguous, overflow.ErrorReason)
		assert.Equal(t, signature, overflow.Transaction)
		_, stored, err = fixture.scheme.pendingStore.Get(ctx, key)
		require.NoError(t, err)
		assert.False(t, stored, "an attribution that overflows the deposit is not retried forever")
	})

	t.Run("keeps a legacy refund result pending when the merchant credit was not stored", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
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
			cfg.PayoutStore = store
			cfg.OnDistributionConfirmed = func(context.Context, *x402.SettleResponse, types.PaymentRequirements) error {
				calls++
				return nil
			}
		})
		pending := settleThrown(t, fixture.scheme, refundPayload(t, 3_000))
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
		t.Run(fmt.Sprintf("finishes an unfinished %s payout record from another scheme only when the hook failed (callback failure: %t)", tc.intent, tc.fail), func(t *testing.T) {
			channel, payload, amount := live(nil), any(sealPayload(t, 3_000)), "2500"
			if tc.intent == CloseIntentRefund {
				channel, payload, amount = openLive, refundPayload(t, 3_000), "7000"
			}
			store := x402.NewInMemoryPendingSettlementStore()
			payouts := &payoutLog{onFirst: func() error {
				if tc.fail {
					return errors.New("ledger unavailable")
				}
				return nil
			}}
			configure := func(cfg *Config) {
				cfg.PendingSettlementStore = store
				cfg.PayoutStore = store
				cfg.OnDistributionConfirmed = payouts.record
			}
			first := facilitator(t, channel, true, configure)
			second := facilitator(t, channel, true, configure)
			recordKey := resultKey(fmt.Sprintf("batch:%s:%s:%s:3000", tc.intent, network, channelID))

			firstOutcome, err := first.scheme.Settle(context.Background(), types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: asMap(t, payload)}, requirements, nil)
			assert.Len(t, first.submits, 1)
			if tc.fail {
				var settleErr *x402.SettleError
				require.Nil(t, firstOutcome)
				require.ErrorAs(t, err, &settleErr)
				assert.Equal(t, x402.ErrSettlementPending, settleErr.ErrorReason)
				assert.Equal(t, signature, settleErr.Transaction)
				_, stored, err := store.Get(context.Background(), recordKey)
				require.NoError(t, err)
				assert.True(t, stored, "a failed hook keeps the payout record")
			} else {
				require.NoError(t, err)
				assert.True(t, firstOutcome.Success)
				assert.Equal(t, amount, firstOutcome.Amount)
				_, stored, err := store.Get(context.Background(), recordKey)
				require.NoError(t, err)
				assert.False(t, stored, "a successful hook leaves no payout record")
			}

			second.scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
				return sealedAt3000(), nil
			}
			retried := settle(t, second.scheme, payload)
			assert.Empty(t, second.submits)
			if !tc.fail {
				assert.False(t, retried.Success)
				assert.Equal(t, batchsettlement.ErrCloseState, retried.ErrorReason)
				assert.Len(t, payouts.calls(), 1)
				return
			}
			assert.True(t, retried.Success)
			assert.Equal(t, amount, retried.Amount)
			assert.Equal(t, "2500", retried.Extra["paidToReceiver"])
			assert.Equal(t, signature, retried.Transaction)
			calls := payouts.calls()
			require.Len(t, calls, 2)
			assert.Equal(t, "2500", calls[1].response.Amount)

			finished := settle(t, second.scheme, payload)
			assert.False(t, finished.Success)
			assert.Equal(t, batchsettlement.ErrCloseState, finished.ErrorReason)
			assert.Len(t, payouts.calls(), 2)
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

func uintString(value uint64) string {
	return new(big.Int).SetUint64(value).String()
}
