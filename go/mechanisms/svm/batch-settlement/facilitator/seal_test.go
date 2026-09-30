package facilitator

import (
	"context"
	"math/big"
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
	const signature = "signature"
	type sealFixture struct {
		scheme  *BatchSvmScheme
		storage *activityRecordingStorage
		submits []submitCall
	}
	facilitator := func(t *testing.T, channel *generated.Channel, bound bool) *sealFixture {
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
		scheme := NewBatchSvmScheme(context.Background(), newScriptedSigner(t, 1), &Config{ChannelStorage: storage})
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
