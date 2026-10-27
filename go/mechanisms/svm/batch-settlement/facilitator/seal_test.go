package facilitator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sync/atomic"
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
	signature := solana.Signature{7}.String()
	type sealFixture struct {
		signer      *capabilitySigner
		transaction *svm.FacilitatorConfirmedTransaction
		scheme      *BatchSvmScheme
		storage     *activityRecordingStorage
		submits     []submitCall
	}
	facilitator := func(t *testing.T, channel *generated.Channel, bound bool, configs ...Config) *sealFixture {
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
		cfg := Config{}
		if len(configs) != 0 {
			cfg = configs[0]
		}
		cfg.ChannelStorage = storage
		paid := uint64(0)
		if channel.Settlement.PayoutWatermark < 3_000 {
			paid = 3_000 - channel.Settlement.PayoutWatermark
		}
		fixture.transaction = lifecyclePayoutEvidence(t, channelID, requirements.PayTo, requirements.Asset, "100", uintString(100+paid))
		fixture.transaction.Meta.PreTokenBalances[1].UITokenAmount.Amount = uintString(channel.Deposit - channel.Settlement.PayoutWatermark)
		fixture.transaction.Meta.PostTokenBalances = fixture.transaction.Meta.PostTokenBalances[:1]
		fixture.signer = &capabilitySigner{scriptedSigner: newScriptedSigner(t, 1), confirmed: func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
			return fixture.transaction, nil
		}}
		scheme := NewBatchSvmScheme(context.Background(), fixture.signer, &cfg)
		scheme.hooks.waitForChannelRead = func(int) error { return nil }
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
		fixture := facilitator(t, nil, true)
		payload := sealPayload(t, 3_000)
		response := settle(t, fixture.scheme, payload)
		assert.True(t, response.Success)
		assert.Equal(t, "2500", response.Amount)
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

		again := settle(t, fixture.scheme, sealPayload(t, 3_000))
		assert.True(t, again.Success)
		assert.Equal(t, "2500", again.Amount)
		assert.Len(t, fixture.submits, 1)
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
		openLive := live(func(channel *generated.Channel) {
			channel.Status = uint8(generated.ChannelStatus_Open)
			channel.ClosureStartedAt = 0
		})
		refund := func(t *testing.T, cumulative uint64) (*sealFixture, *x402.SettleResponse) {
			t.Helper()
			payload := sealPayload(t, cumulative)
			fixture := facilitator(t, openLive, true)
			response := settle(t, fixture.scheme, batchsettlement.BatchRefundPayload{
				Type:               batchsettlement.PayloadTypeRefund,
				ChannelConfig:      config,
				Voucher:            &payload.Voucher,
				CloseAuthorization: payload.CloseAuthorization,
			})
			return fixture, response
		}
		above, response := refund(t, 3_000)
		assert.True(t, response.Success)
		assert.Equal(t, "7000", response.Amount)
		assert.Equal(t, signature, response.Transaction)
		state := response.Extra["channelState"].(batchsettlement.BatchChannelState)
		assert.Equal(t, channelID, state.ChannelID)
		assert.Zero(t, state.WithdrawRequestedAt)
		require.Len(t, above.submits, 1)
		assert.Len(t, above.submits[0].instructions, 3)
		assert.Equal(t, "batch:refund:"+network+":"+channelID+":3000", above.submits[0].key)

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

	t.Run("accounts only the refund payout after an intervening sweep", func(t *testing.T) {
		program := live(func(ch *generated.Channel) { ch.Status = uint8(generated.ChannelStatus_Open); ch.ClosureStartedAt = 0 })
		snapshot := *program
		var ledgerPaid uint64
		var signatures []string
		cfg := Config{OnDistributionConfirmed: func(_ context.Context, response *x402.SettleResponse, _ types.PaymentRequirements) error {
			ledgerPaid += mustParseU64(t, response.Amount)
			signatures = append(signatures, response.Transaction)
			return nil
		}}
		refund := facilitator(t, &snapshot, true, cfg)
		sweep := facilitator(t, program, true, cfg)
		sweepSignature := solana.Signature{8}.String()
		sweep.transaction = lifecyclePayoutEvidence(t, channelID, requirements.PayTo, requirements.Asset, "100", "600")
		submitSweep := sweep.scheme.hooks.submitRedemption
		sweep.scheme.hooks.submitRedemption = func(ctx context.Context, fee, net string, instructions []solana.Instruction, key, payer string) (durableResult, error) {
			result, err := submitSweep(ctx, fee, net, instructions, key, payer)
			result.Signature = sweepSignature
			return result, err
		}
		submitRefund := refund.scheme.hooks.submitRedemption
		refund.scheme.hooks.submitRedemption = func(ctx context.Context, fee, net string, instructions []solana.Instruction, key, payer string) (durableResult, error) {
			// Run the public sweep flow after the refund reads its channel snapshot.
			// Program transitions and confirmed token balances are synthetic.
			response := settle(t, sweep.scheme, batchsettlement.BatchSettlePayload{
				Type:     batchsettlement.PayloadTypeSettle,
				Channels: []batchsettlement.BatchSettleChannel{{ChannelID: channelID, ChannelConfig: config}},
			})
			require.True(t, response.Success)
			require.Equal(t, "500", response.Amount)
			program.Settlement.PayoutWatermark = program.Settlement.Settled
			merchantPaid := uint64(3_000) - program.Settlement.PayoutWatermark
			refund.transaction = lifecyclePayoutEvidence(t, channelID, requirements.PayTo, requirements.Asset, "600", uintString(600+merchantPaid))
			refund.transaction.Meta.PostTokenBalances = refund.transaction.Meta.PostTokenBalances[:1]
			return submitRefund(ctx, fee, net, instructions, key, payer)
		}
		voucher := sealPayload(t, 3_000)
		response := settle(t, refund.scheme, batchsettlement.BatchRefundPayload{
			Type: batchsettlement.PayloadTypeRefund, ChannelConfig: config,
			Voucher: &voucher.Voucher, CloseAuthorization: voucher.CloseAuthorization,
		})
		require.True(t, response.Success)
		assert.Equal(t, "7000", response.Amount)
		assert.Equal(t, "2000", response.Extra["paidToReceiver"])
		assert.Equal(t, uint64(2_500), ledgerPaid, "500 sweep plus 2000 refund payout")
		assert.Equal(t, []string{sweepSignature, signature}, signatures)
		assert.Len(t, sweep.submits, 1)
		assert.Len(t, refund.submits, 1)
		again := settle(t, refund.scheme, batchsettlement.BatchRefundPayload{
			Type: batchsettlement.PayloadTypeRefund, ChannelConfig: config,
			Voucher: &voucher.Voucher, CloseAuthorization: voucher.CloseAuthorization,
		})
		assert.True(t, again.Success)
		assert.Equal(t, "2000", again.Extra["paidToReceiver"])
		assert.Equal(t, uint64(2_500), ledgerPaid)
		assert.Len(t, refund.submits, 1)
	})

	t.Run("close accounting", func(t *testing.T) {
		for _, intent := range []CloseIntent{CloseIntentSeal, CloseIntentRefund} {
			t.Run(string(intent), func(t *testing.T) {
				channel := live(nil)
				voucher := sealPayload(t, 3_000)
				var payload any = voucher
				outwardAmount := "2500"
				if intent == CloseIntentRefund {
					channel.Status = uint8(generated.ChannelStatus_Open)
					channel.ClosureStartedAt = 0
					outwardAmount = "7000"
					payload = batchsettlement.BatchRefundPayload{
						Type: batchsettlement.PayloadTypeRefund, ChannelConfig: config,
						Voucher: &voucher.Voucher, CloseAuthorization: voucher.CloseAuthorization,
					}
				}
				key := fmt.Sprintf("batch:%s:%s:%s:3000", intent, network, channelID)
				// Recovery retains the receiver binding and a valid authorization, but
				// must not fetch the account or submit again after the result is saved.
				restarted := func(t *testing.T, cfg Config) *sealFixture {
					t.Helper()
					fixture := facilitator(t, channel, true, cfg)
					fixture.scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
						return nil, errors.New("channel account is gone")
					}
					return fixture
				}

				t.Run("records merchant payout and skips recorded replay", func(t *testing.T) {
					store := NewInMemoryPendingSettlementStore()
					calls := 0
					cfg := Config{PendingSettlementStore: store, OnDistributionConfirmed: func(ctx context.Context, response *x402.SettleResponse, got types.PaymentRequirements) error {
						calls++
						assert.Equal(t, "2500", response.Amount)
						assert.Equal(t, requirements, got)
						assert.Equal(t, signature, response.Transaction)
						_, saved, err := store.Get(ctx, key+":result")
						require.NoError(t, err)
						assert.True(t, saved, "save the amount-bearing result before accounting")
						response.Amount = "callback mutation"
						return nil
					}}
					fixture := facilitator(t, channel, true, cfg)
					response := settle(t, fixture.scheme, payload)
					require.True(t, response.Success)
					assert.Equal(t, outwardAmount, response.Amount)
					assert.Equal(t, "2500", response.Extra["paidToReceiver"])
					assert.Equal(t, 1, calls)
					_, recorded, err := store.Get(context.Background(), key+":recorded")
					require.NoError(t, err)
					assert.True(t, recorded)
					replay := restarted(t, cfg)
					response = settle(t, replay.scheme, payload)
					assert.True(t, response.Success)
					assert.Equal(t, outwardAmount, response.Amount)
					assert.Equal(t, 1, calls)
					assert.Len(t, fixture.submits, 1)
					assert.Empty(t, replay.submits)
				})

				t.Run("rejects saved-result replay after close authorization expires", func(t *testing.T) {
					store := NewInMemoryPendingSettlementStore()
					fixture := facilitator(t, channel, true, Config{PendingSettlementStore: store})
					require.True(t, settle(t, fixture.scheme, payload).Success)
					saved, exists, err := store.Get(context.Background(), key+":close")
					require.NoError(t, err)
					require.True(t, exists)

					calls := 0
					replay := restarted(t, Config{PendingSettlementStore: store, OnDistributionConfirmed: func(context.Context, *x402.SettleResponse, types.PaymentRequirements) error {
						calls++
						return nil
					}})
					replay.scheme.hooks.sealDependencies = func() SealDependencies {
						deps := replay.scheme.defaultSealDependencies()
						deps.NowSeconds = func() int64 { return voucher.CloseAuthorization.ValidBefore }
						return deps
					}
					response := settle(t, replay.scheme, payload)
					assert.False(t, response.Success)
					assert.Equal(t, batchsettlement.ErrCloseAuthorization, response.ErrorReason)
					assert.Contains(t, response.ErrorMessage, "outside its validity window")
					assert.Zero(t, calls, "a saved result must not bypass close authentication")
					after, exists, err := store.Get(context.Background(), key+":close")
					require.NoError(t, err)
					assert.True(t, exists)
					assert.Equal(t, saved, after)
					_, recorded, err := store.Get(context.Background(), key+":recorded")
					require.NoError(t, err)
					assert.False(t, recorded)
					assert.Len(t, fixture.submits, 1)
					assert.Empty(t, replay.submits)
				})

				for _, fault := range []string{"callback", "marker read", "marker write"} {
					t.Run("recovers after "+fault, func(t *testing.T) {
						store := &closeAccountingFaultStore{PendingSettlementStore: NewInMemoryPendingSettlementStore(), marker: key + ":recorded", failGet: fault == "marker read", failSet: fault == "marker write"}
						calls := 0
						cfg := Config{PendingSettlementStore: store, OnDistributionConfirmed: func(_ context.Context, response *x402.SettleResponse, _ types.PaymentRequirements) error {
							calls++
							assert.Equal(t, "2500", response.Amount)
							if fault == "callback" && calls == 1 {
								return errors.New("accounting unavailable")
							}
							return nil
						}}
						fixture := facilitator(t, channel, true, cfg)
						response := settle(t, fixture.scheme, payload)
						require.False(t, response.Success)
						assert.Equal(t, x402.ErrSettlementPending, response.ErrorReason)
						assert.Equal(t, signature, response.Transaction)
						_, recorded, err := store.Get(context.Background(), key+":recorded")
						require.NoError(t, err)
						assert.False(t, recorded)
						replay := restarted(t, cfg)
						if fault == "callback" || fault == "marker write" {
							replay.signer.confirmed = nil // transaction metadata may no longer be retained
						}
						response = settle(t, replay.scheme, payload)
						require.True(t, response.Success)
						assert.Equal(t, outwardAmount, response.Amount)
						wantCalls := 2
						if fault == "marker read" {
							wantCalls = 1
						}
						assert.Equal(t, wantCalls, calls)
						if fault == "callback" || fault == "marker write" {
							assert.Zero(t, replay.signer.confirmedCalls, "retry uses durably attributed payout")
						}
						assert.True(t, settle(t, replay.scheme, payload).Success)
						assert.Equal(t, wantCalls, calls)
						assert.Len(t, fixture.submits, 1)
						assert.Empty(t, replay.submits)
					})
				}

				t.Run("nil callback leaves result available for later accounting", func(t *testing.T) {
					store := NewInMemoryPendingSettlementStore()
					fixture := facilitator(t, channel, true, Config{PendingSettlementStore: store})
					assert.True(t, settle(t, fixture.scheme, payload).Success)
					_, recorded, err := store.Get(context.Background(), key+":recorded")
					require.NoError(t, err)
					assert.False(t, recorded)
					calls := 0
					replay := restarted(t, Config{PendingSettlementStore: store, OnDistributionConfirmed: func(context.Context, *x402.SettleResponse, types.PaymentRequirements) error { calls++; return nil }})
					assert.True(t, settle(t, replay.scheme, payload).Success)
					assert.Equal(t, 1, calls)
					assert.Empty(t, replay.submits)
				})

				for _, recorded := range []bool{false, true} {
					t.Run(fmt.Sprintf("legacy result recorded=%t", recorded), func(t *testing.T) {
						store := NewInMemoryPendingSettlementStore()
						fixture := facilitator(t, channel, true, Config{PendingSettlementStore: store})
						legacy := settle(t, fixture.scheme, payload)
						require.True(t, legacy.Success)
						delete(legacy.Extra, "paidToReceiver")
						encoded, err := json.Marshal(legacy)
						require.NoError(t, err)
						require.NoError(t, store.Set(context.Background(), key+":result", string(encoded)))
						if recorded {
							require.NoError(t, store.Set(context.Background(), key+":recorded", "1"))
						}
						// No callback must remain compatible even for an old refund.
						assert.True(t, settle(t, restarted(t, Config{PendingSettlementStore: store}).scheme, payload).Success)
						calls := 0
						replay := restarted(t, Config{PendingSettlementStore: store, OnDistributionConfirmed: func(_ context.Context, response *x402.SettleResponse, _ types.PaymentRequirements) error {
							calls++
							assert.Equal(t, "2500", response.Amount)
							return nil
						}})
						response := settle(t, replay.scheme, payload)
						assert.True(t, response.Success)
						wantCalls := 1
						if recorded {
							wantCalls = 0
						}
						assert.Equal(t, wantCalls, calls)
						assert.Equal(t, signature, response.Transaction)
						assert.Empty(t, replay.submits)
					})
				}

				t.Run("reattributes unrecorded legacy payout fields", func(t *testing.T) {
					store := NewInMemoryPendingSettlementStore()
					fixture := facilitator(t, channel, true, Config{PendingSettlementStore: store})
					old := settle(t, fixture.scheme, payload)
					require.True(t, old.Success)
					old.Extra["paidToReceiver"] = "9999"
					if intent == CloseIntentSeal {
						old.Amount = "9999"
					}
					encoded, err := json.Marshal(old)
					require.NoError(t, err)
					require.NoError(t, store.Set(context.Background(), key+":result", string(encoded)))
					calls := 0
					replay := restarted(t, Config{PendingSettlementStore: store, OnDistributionConfirmed: func(_ context.Context, response *x402.SettleResponse, _ types.PaymentRequirements) error {
						calls++
						assert.Equal(t, "2500", response.Amount)
						return nil
					}})
					response := settle(t, replay.scheme, payload)
					assert.True(t, response.Success)
					assert.Equal(t, outwardAmount, response.Amount)
					assert.Equal(t, "2500", response.Extra["paidToReceiver"])
					assert.Equal(t, 1, calls)
					assert.Empty(t, replay.submits)
				})

				t.Run("refreshes a replay loaded before accounting completes", func(t *testing.T) {
					inner := NewInMemoryPendingSettlementStore()
					seed := facilitator(t, channel, true, Config{PendingSettlementStore: inner})
					old := settle(t, seed.scheme, payload)
					require.True(t, old.Success)
					old.Extra["paidToReceiver"] = "9999"
					if intent == CloseIntentSeal {
						old.Amount = "9999"
					}
					encoded, err := json.Marshal(old)
					require.NoError(t, err)
					require.NoError(t, inner.Set(context.Background(), key+":result", string(encoded)))
					store := &closeResultReadBarrierStore{PendingSettlementStore: inner, key: key + ":result", loaded: make(chan struct{}), release: make(chan struct{}, 1)}
					defer close(store.release)
					var calls atomic.Int32
					cfg := Config{PendingSettlementStore: store, OnDistributionConfirmed: func(context.Context, *x402.SettleResponse, types.PaymentRequirements) error { calls.Add(1); return nil }}
					delayed, owner := restarted(t, cfg), restarted(t, cfg)
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					type outcome struct {
						response *x402.SettleResponse
						err      error
					}
					done := make(chan outcome, 1)
					payment := types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: asMap(t, payload)}
					go func() {
						response, err := delayed.scheme.Settle(ctx, payment, requirements, nil)
						done <- outcome{response, err}
					}()
					select {
					case <-store.loaded:
					case <-ctx.Done():
						t.Fatal("replay never loaded the old result")
					}
					completed := settle(t, owner.scheme, payload)
					require.True(t, completed.Success)
					require.Equal(t, "2500", completed.Extra["paidToReceiver"])
					store.release <- struct{}{}
					select {
					case result := <-done:
						require.NoError(t, result.err)
						require.True(t, result.response.Success)
						assert.Equal(t, completed, result.response, "already-recorded replay must return the authoritative result")
					case <-ctx.Done():
						t.Fatal("delayed replay did not finish")
					}
					assert.Equal(t, int32(1), calls.Load())
					assert.Empty(t, delayed.submits)
					assert.Empty(t, owner.submits)
				})

				t.Run("late preliminary write preserves the attributed result", func(t *testing.T) {
					store := &closeInitialWriteBarrierStore{PendingSettlementStore: NewInMemoryPendingSettlementStore(), key: key, reached: make(chan struct{}), release: make(chan struct{}, 1)}
					defer close(store.release)
					var calls atomic.Int32
					cfg := Config{PendingSettlementStore: store, OnDistributionConfirmed: func(context.Context, *x402.SettleResponse, types.PaymentRequirements) error { calls.Add(1); return nil }}
					owner, late := facilitator(t, channel, true, cfg), facilitator(t, channel, true, cfg)
					ownerReady, allowOwner := make(chan struct{}), make(chan struct{}, 1)
					defer close(allowOwner)
					submit := owner.scheme.hooks.submitRedemption
					owner.scheme.hooks.submitRedemption = func(ctx context.Context, fee, net string, instructions []solana.Instruction, key, payer string) (durableResult, error) {
						close(ownerReady)
						select {
						case <-allowOwner:
						case <-ctx.Done():
							return durableResult{}, ctx.Err()
						}
						return submit(ctx, fee, net, instructions, key, payer)
					}
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					payment := types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: asMap(t, payload)}
					type outcome struct {
						response *x402.SettleResponse
						err      error
					}
					ownerDone, lateDone := make(chan outcome, 1), make(chan outcome, 1)
					go func() {
						response, err := owner.scheme.Settle(ctx, payment, requirements, nil)
						ownerDone <- outcome{response, err}
					}()
					select {
					case <-ownerReady:
					case <-ctx.Done():
						t.Fatal("owner never captured the channel snapshot")
					}
					// Both callers pass the empty-result lookup before either completes.
					// Submission/recovery hooks return the same broadcast signature.
					go func() {
						response, err := late.scheme.Settle(context.WithValue(ctx, store, true), payment, requirements, nil)
						lateDone <- outcome{response, err}
					}()
					select {
					case <-store.reached:
					case <-ctx.Done():
						t.Fatal("late caller never reached its preliminary write")
					}
					allowOwner <- struct{}{}
					select {
					case result := <-ownerDone:
						require.NoError(t, result.err)
						require.True(t, result.response.Success)
						require.Equal(t, "2500", result.response.Extra["paidToReceiver"])
					case <-ctx.Done():
						t.Fatal("owner did not finish accounting")
					}
					store.release <- struct{}{}
					select {
					case result := <-lateDone:
						require.NoError(t, result.err)
						require.True(t, result.response.Success)
						assert.Equal(t, outwardAmount, result.response.Amount)
						assert.Equal(t, "2500", result.response.Extra["paidToReceiver"])
					case <-ctx.Done():
						t.Fatal("late caller did not finish")
					}
					encoded, exists, err := store.Get(ctx, key+":result")
					require.NoError(t, err)
					require.True(t, exists)
					var saved x402.SettleResponse
					require.NoError(t, json.Unmarshal([]byte(encoded), &saved))
					assert.Equal(t, "2500", saved.Extra["paidToReceiver"])
					assert.Equal(t, int32(1), calls.Load())
					assert.Len(t, owner.submits, 1)
					assert.Len(t, late.submits, 1)
				})

				for _, fault := range []string{"metadata unavailable", "metadata error", "missing recipient balance", "ambiguous payout", "reader absent", "dependency absent", "payout write", "result write", "malformed payout"} {
					t.Run("pending attribution after "+fault, func(t *testing.T) {
						store := &closeAccountingFaultStore{PendingSettlementStore: NewInMemoryPendingSettlementStore()}
						if fault == "payout write" {
							store.writeKey = key + ":payout"
						}
						if fault == "result write" {
							store.writeKey = key + ":result"
						}
						if fault == "malformed payout" {
							require.NoError(t, store.Set(context.Background(), key+":payout", "invalid"))
						}
						calls := 0
						cfg := Config{PendingSettlementStore: store, OnDistributionConfirmed: func(_ context.Context, response *x402.SettleResponse, _ types.PaymentRequirements) error {
							calls++
							assert.Equal(t, "2500", response.Amount)
							return nil
						}}
						fixture := facilitator(t, channel, true, cfg)
						switch fault {
						case "metadata unavailable":
							fixture.signer.confirmed = nil
						case "metadata error":
							fixture.signer.confirmed = func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
								return fixture.transaction, errors.New("metadata read failed")
							}
						case "missing recipient balance":
							fixture.transaction.Meta.PreTokenBalances = []svm.FacilitatorTokenBalance{}
							fixture.transaction.Meta.PostTokenBalances = []svm.FacilitatorTokenBalance{}
						case "reader absent":
							fixture.scheme.raw = newScriptedSigner(t, 1)
						case "dependency absent", "ambiguous payout":
							fixture.scheme.hooks.sealDependencies = func() SealDependencies {
								deps := fixture.scheme.defaultSealDependencies()
								deps.NowSeconds = func() int64 { return sealNow }
								deps.ReadDistributionAmount = nil
								if fault == "ambiguous payout" {
									deps.ReadDistributionAmount = func(context.Context, string, string, []PreparedDistribution, types.PaymentRequirements) (uint64, error) {
										return 0, &PayoutAttributionAmbiguousError{}
									}
								}
								return deps
							}
						}
						response := settle(t, fixture.scheme, payload)
						require.False(t, response.Success)
						assert.Equal(t, x402.ErrSettlementPending, response.ErrorReason)
						assert.Equal(t, signature, response.Transaction)
						assert.Zero(t, calls)
						_, saved, err := store.Get(context.Background(), key+":close")
						require.NoError(t, err)
						assert.True(t, saved, "preserve preliminary close before attempting attribution")
						_, recorded, err := store.Get(context.Background(), key+":recorded")
						require.NoError(t, err)
						assert.False(t, recorded)
						if fault == "malformed payout" {
							assert.Zero(t, fixture.signer.confirmedCalls, "invalid cache cannot fall back to a snapshot or RPC")
							require.NoError(t, store.Delete(context.Background(), key+":payout"))
						}
						replay := restarted(t, cfg)
						if fault == "result write" {
							replay.signer.confirmed = nil
						}
						response = settle(t, replay.scheme, payload)
						require.True(t, response.Success)
						assert.Equal(t, outwardAmount, response.Amount)
						assert.Equal(t, "2500", response.Extra["paidToReceiver"])
						assert.Equal(t, 1, calls)
						if fault == "result write" {
							assert.Zero(t, replay.signer.confirmedCalls)
						}
						assert.Len(t, fixture.submits, 1)
						assert.Empty(t, replay.submits)
					})
				}

				for _, ownerFails := range []bool{false, true} {
					t.Run(fmt.Sprintf("same-store accounting coalesces owner failure=%t", ownerFails), func(t *testing.T) {
						store := NewInMemoryPendingSettlementStore()
						fixture := facilitator(t, channel, true, Config{PendingSettlementStore: store})
						require.True(t, settle(t, fixture.scheme, payload).Success)
						entered, release := make(chan struct{}), make(chan struct{}, 1)
						defer close(release)
						var calls atomic.Int32
						cfg := Config{PendingSettlementStore: store, OnDistributionConfirmed: func(ctx context.Context, _ *x402.SettleResponse, _ types.PaymentRequirements) error {
							if calls.Add(1) == 1 {
								close(entered)
								select {
								case <-release:
								case <-ctx.Done():
									return ctx.Err()
								}
								if ownerFails {
									return errors.New("accounting unavailable")
								}
							}
							return nil
						}}
						owner, waiter := restarted(t, cfg), restarted(t, cfg)
						ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
						defer cancel()
						payment := types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: asMap(t, payload)}
						type outcome struct {
							response *x402.SettleResponse
							err      error
						}
						done := make(chan outcome, 1)
						go func() {
							response, err := owner.scheme.Settle(ctx, payment, requirements, nil)
							done <- outcome{response, err}
						}()
						select {
						case <-entered:
						case <-ctx.Done():
							t.Fatal("owner never entered accounting")
						}
						waitCtx, stopWait := context.WithCancel(ctx)
						stopWait()
						response, err := waiter.scheme.Settle(waitCtx, payment, requirements, nil)
						require.NoError(t, err)
						assert.False(t, response.Success)
						assert.Equal(t, x402.ErrSettlementPending, response.ErrorReason)
						assert.Equal(t, signature, response.Transaction)
						assert.Contains(t, response.ErrorMessage, "context canceled")
						assert.Equal(t, int32(1), calls.Load(), "canceled waiter must not invoke or cancel owner")
						waiting := &closeAccountingWaitContext{Context: ctx, waiting: make(chan struct{})}
						waitDone := make(chan outcome, 1)
						go func() {
							response, err := waiter.scheme.Settle(waiting, payment, requirements, nil)
							waitDone <- outcome{response, err}
						}()
						// Done is evaluated when the second scheme joins the in-flight
						// accounting select, proving overlap without a timing delay.
						select {
						case <-waiting.waiting:
						case <-ctx.Done():
							t.Fatal("second scheme never waited for the owner")
						}
						assert.Equal(t, int32(1), calls.Load())
						release <- struct{}{}
						var ownerResponse *x402.SettleResponse
						select {
						case result := <-done:
							require.NoError(t, result.err)
							assert.Equal(t, !ownerFails, result.response.Success)
							ownerResponse = result.response
						case <-ctx.Done():
							t.Fatal("owner did not finish")
						}
						select {
						case result := <-waitDone:
							require.NoError(t, result.err)
							assert.Equal(t, !ownerFails, result.response.Success)
							assert.Equal(t, signature, result.response.Transaction)
							assert.Equal(t, ownerResponse.Amount, result.response.Amount)
							assert.Equal(t, ownerResponse.ErrorReason, result.response.ErrorReason)
							assert.Equal(t, ownerResponse.ErrorMessage, result.response.ErrorMessage)
						case <-ctx.Done():
							t.Fatal("waiting scheme did not receive the owner's outcome")
						}
						assert.True(t, settle(t, waiter.scheme, payload).Success)
						wantCalls := int32(1)
						if ownerFails {
							wantCalls = 2
						}
						assert.Equal(t, wantCalls, calls.Load(), "failed pass must permit a later retry")
						assert.Empty(t, owner.submits)
						assert.Empty(t, waiter.submits)
					})
				}

				t.Run("records a zero merchant payout", func(t *testing.T) {
					zeroChannel := *channel
					zeroChannel.Settlement = generated.SettlementWatermarks{Settled: 3_000, PayoutWatermark: 3_000}
					calls := 0
					fixture := facilitator(t, &zeroChannel, true, Config{OnDistributionConfirmed: func(_ context.Context, response *x402.SettleResponse, _ types.PaymentRequirements) error {
						calls++
						assert.Equal(t, "0", response.Amount)
						return nil
					}})
					response := settle(t, fixture.scheme, payload)
					assert.True(t, response.Success)
					assert.Equal(t, "0", response.Extra["paidToReceiver"])
					if intent == CloseIntentRefund {
						assert.Equal(t, "7000", response.Amount)
					} else {
						assert.Equal(t, "0", response.Amount)
					}
					assert.Equal(t, 1, calls)
				})
			})
		}
	})

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

func uintString(value uint64) string {
	return new(big.Int).SetUint64(value).String()
}
