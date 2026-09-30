package facilitator

import (
	"context"
	"errors"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	batchclient "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/client"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	delegatedNow    int64 = 1_800_000_000
	delegatedCaller       = "service-a"
	delegatedSig          = svm.USDCDevnetAddress
)

// tokenOwnerSigner returns mint/ATA accounts owned by the SPL token program.
type tokenOwnerSigner struct {
	*scriptedSigner
}

func newTokenOwnerSigner(keys ...solana.PrivateKey) *tokenOwnerSigner {
	return &tokenOwnerSigner{scriptedSigner: &scriptedSigner{
		keys:      keys,
		blockhash: solana.MustHashFromBase58("11111111111111111111111111111111"),
	}}
}

func (s *tokenOwnerSigner) GetAccountInfo(
	ctx context.Context,
	account solana.PublicKey,
	network string,
	opts *rpc.GetAccountInfoOpts,
) (*rpc.GetAccountInfoResult, error) {
	_, _ = s.scriptedSigner.GetAccountInfo(ctx, account, network, opts)
	return &rpc.GetAccountInfoResult{
		Value: &rpc.Account{Owner: solana.MustPublicKeyFromBase58(svm.TokenProgramAddress)},
	}, nil
}

// SignTransaction co-signs only the fee payer so open simulation can leave the payer slot empty.
func (s *tokenOwnerSigner) SignTransaction(_ context.Context, tx *solana.Transaction, feePayer solana.PublicKey, _ string) error {
	for i := range s.keys {
		if !s.keys[i].PublicKey().Equals(feePayer) {
			continue
		}
		_, err := tx.PartialSign(func(key solana.PublicKey) *solana.PrivateKey {
			if key.Equals(feePayer) {
				return &s.keys[i]
			}
			return nil
		})
		return err
	}
	return errors.New("no signer for fee payer " + feePayer.String())
}

func TestBatchSettlementDelegatedReceiverAuthorization(t *testing.T) {
	ctx := context.Background()
	network := string(svm.SolanaDevnetCAIP2)
	payerKey := mustKey(t)
	payer, err := batchclient.NewPrivateKeySigner(payerKey.String())
	require.NoError(t, err)
	feeKey := mustKey(t)
	server := mustKey(t)
	salt := uint64(0)

	requirements := func(receiverAuthorizer string) types.PaymentRequirements {
		return types.PaymentRequirements{
			Amount: "1000",
			Asset:  svm.USDCDevnetAddress,
			Extra: map[string]any{
				batchsettlement.ExtraFeePayer:           feeKey.PublicKey().String(),
				batchsettlement.ExtraReceiverAuthorizer: receiverAuthorizer,
				batchsettlement.ExtraTokenProgram:       svm.TokenProgramAddress,
				batchsettlement.ExtraWithdrawDelay:      900,
			},
			MaxTimeoutSeconds: 300,
			Network:           network,
			PayTo:             svm.USDCMainnetAddress,
			Scheme:            batchsettlement.Scheme,
		}
	}

	buildOpen := func(t *testing.T, openSlot uint64) *batchclient.BuiltDeposit {
		t.Helper()
		built, err := batchclient.BuildDepositPayload(ctx, batchclient.BuildDepositArgs{
			Payer:              payer,
			Receiver:           svm.USDCMainnetAddress,
			ReceiverAuthorizer: server.PublicKey().String(),
			Mint:               svm.USDCDevnetAddress,
			FeePayer:           feeKey.PublicKey().String(),
			TokenProgram:       svm.TokenProgramAddress,
			Blockhash:          solana.MustHashFromBase58(svm.USDCMainnetAddress),
			OpenSlot:           openSlot,
			DepositAmount:      10_000,
			FirstCharge:        1_000,
			WithdrawDelay:      900,
			Salt:               &salt,
		})
		require.NoError(t, err)
		return built
	}

	channelOf := func(config batchsettlement.BatchChannelConfig, status generated.ChannelStatus, closureStartedAt int64) *generated.Channel {
		hash, err := paymentchannels.GetChannelDistributionHash([]paymentchannels.Split{{
			Recipient: svm.USDCMainnetAddress, BPS: batchsettlement.FullSplitBPS,
		}})
		require.NoError(t, err)
		openSlot, err := paymentchannels.ParseU64(config.OpenSlot, "openSlot")
		require.NoError(t, err)
		channelSalt, err := paymentchannels.ParseU64(config.Salt, "salt")
		require.NoError(t, err)
		return &generated.Channel{
			Discriminator:    uint8(generated.AccountDiscriminator_Channel),
			Bump:             1,
			Version:          1,
			Status:           uint8(status),
			Salt:             channelSalt,
			Deposit:          10_000,
			Settlement:       generated.SettlementWatermarks{},
			ClosureStartedAt: closureStartedAt,
			GracePeriod:      900,
			DistributionHash: hash,
			Payer:            payer.Address(),
			Payee:            feeKey.PublicKey(),
			AuthorizedSigner: payer.Address(),
			Mint:             solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
			RentPayer:        feeKey.PublicKey(),
			OpenSlot:         openSlot,
		}
	}

	type delegatedFixture struct {
		storage paymentchannels.PaymentChannelStorage
		scheme  *BatchSvmScheme
		signer  *tokenOwnerSigner
	}

	delegatedScheme := func(identity string, delegate bool) *delegatedFixture {
		storage := paymentchannels.NewInMemoryPaymentChannelStorage()
		signer := newTokenOwnerSigner(feeKey)
		cfg := &Config{ChannelStorage: storage}
		if delegate {
			cfg.DelegatedReceiverAuth = &DelegatedReceiverAuth{
				ReceiverAuthorizer: server.PublicKey().String(),
				ResolveCallerIdentity: func(context.Context, DelegatedSettleContext) (string, error) {
					return identity, nil
				},
			}
		}
		scheme := NewBatchSvmScheme(ctx, signer, cfg)
		scheme.now = func() int64 { return delegatedNow }
		fixture := &delegatedFixture{storage: storage, scheme: scheme, signer: signer}
		return fixture
	}

	stubClose := func(fixture *delegatedFixture, channelID string, live *generated.Channel) {
		fixture.scheme.hooks.deriveChannelID = func(context.Context, batchsettlement.BatchChannelConfig, string) (string, error) {
			return channelID, nil
		}
		fixture.scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return live, nil
		}
		fixture.scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return nil, nil
		}
		fixture.scheme.hooks.distributeInstruction = func(context.Context, string, *generated.Channel, BatchTerms, types.PaymentRequirements) (solana.Instruction, error) {
			return solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress), nil, []byte{9}), nil
		}
		fixture.scheme.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			return durableResult{OK: true, Signature: delegatedSig}, nil
		}
		fixture.scheme.hooks.sealDependencies = func() SealDependencies {
			deps := fixture.scheme.defaultSealDependencies()
			deps.NowSeconds = func() int64 { return delegatedNow }
			return deps
		}
	}

	signedVoucher := func(t *testing.T, channelID string, cumulative uint64) batchsettlement.BatchVoucher {
		t.Helper()
		voucher, err := batchclient.SignBatchVoucher(ctx, payer, channelID, cumulative, batchsettlement.ClientVoucherExpiresAt)
		require.NoError(t, err)
		return voucher
	}

	settle := func(t *testing.T, scheme *BatchSvmScheme, payload any, req types.PaymentRequirements) *x402.SettleResponse {
		t.Helper()
		response, err := scheme.Settle(ctx, types.PaymentPayload{
			X402Version: 2,
			Accepted:    req,
			Payload:     asMap(t, payload),
		}, req, nil)
		require.NoError(t, err)
		return response
	}

	t.Run("advertises the delegated key and binds the caller on open", func(t *testing.T) {
		fixture := delegatedScheme(delegatedCaller, true)
		extra := fixture.scheme.getExtra(ctx, x402.Network(network))
		require.Equal(t, server.PublicKey().String(), extra[batchsettlement.ExtraReceiverAuthorizer])

		opened := buildOpen(t, 123)
		live := channelOf(opened.Payload.ChannelConfig, generated.ChannelStatus_Open, 0)
		fixture.scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return nil, nil
		}
		fixture.scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return live, nil
		}

		req := requirements(server.PublicKey().String())
		response := settle(t, fixture.scheme, opened.Payload, req)
		require.True(t, response.Success, "%+v", response)
		require.NotEmpty(t, response.Transaction)

		bound, err := fixture.storage.Get(ctx, network, opened.ChannelID)
		require.NoError(t, err)
		require.NotNil(t, bound)
		require.Equal(t, delegatedCaller, bound.CallerIdentity)
	})

	t.Run("rejects a delegated open with no caller identity", func(t *testing.T) {
		fixture := delegatedScheme("", true)
		opened := buildOpen(t, 124)
		fixture.scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return nil, nil
		}
		sendsBefore := len(fixture.signer.sentTransactions())

		req := requirements(server.PublicKey().String())
		response := settle(t, fixture.scheme, opened.Payload, req)
		require.False(t, response.Success)
		require.Equal(t, batchsettlement.ErrDelegatedUnauthenticated, response.ErrorReason)
		require.Equal(t, sendsBefore, len(fixture.signer.sentTransactions()))

		bound, err := fixture.storage.Get(ctx, network, opened.ChannelID)
		require.NoError(t, err)
		require.Nil(t, bound)
	})

	t.Run("seals and refunds a matching caller without closeAuthorization", func(t *testing.T) {
		opened := buildOpen(t, 125)
		fixture := delegatedScheme(delegatedCaller, true)
		_, err := fixture.storage.RecordOpen(ctx, paymentchannels.PaymentChannelRecord{
			ChannelID: opened.ChannelID, Network: network, ReceiverAuthorizer: server.PublicKey().String(),
			CallerIdentity: delegatedCaller, LastActivityAt: time.Now(),
		})
		require.NoError(t, err)
		live := channelOf(opened.Payload.ChannelConfig, generated.ChannelStatus_Closing, delegatedNow-60)
		stubClose(fixture, opened.ChannelID, live)

		voucher := signedVoucher(t, opened.ChannelID, 1_000)
		req := requirements(server.PublicKey().String())
		seal := batchsettlement.BatchSealPayload{
			Type:          batchsettlement.PayloadTypeSeal,
			ChannelConfig: opened.Payload.ChannelConfig,
			ChannelID:     opened.ChannelID,
			Voucher:       voucher,
		}
		response := settle(t, fixture.scheme, seal, req)
		require.True(t, response.Success)
		require.Equal(t, delegatedSig, response.Transaction)

		stubClose(fixture, opened.ChannelID, channelOf(opened.Payload.ChannelConfig, generated.ChannelStatus_Open, 0))
		refund := batchsettlement.BatchRefundPayload{
			Type:          batchsettlement.PayloadTypeRefund,
			ChannelConfig: opened.Payload.ChannelConfig,
			Voucher:       &voucher,
		}
		response = settle(t, fixture.scheme, refund, req)
		require.True(t, response.Success)
	})

	t.Run("rejects a delegated close whose caller does not match, and a facilitator that does not delegate", func(t *testing.T) {
		opened := buildOpen(t, 126)
		mismatched := delegatedScheme("someone-else", true)
		_, err := mismatched.storage.RecordOpen(ctx, paymentchannels.PaymentChannelRecord{
			ChannelID: opened.ChannelID, Network: network, ReceiverAuthorizer: server.PublicKey().String(),
			CallerIdentity: delegatedCaller, LastActivityAt: time.Now(),
		})
		require.NoError(t, err)
		stubClose(mismatched, opened.ChannelID, channelOf(opened.Payload.ChannelConfig, generated.ChannelStatus_Closing, delegatedNow-60))
		voucher := signedVoucher(t, opened.ChannelID, 1_000)
		seal := batchsettlement.BatchSealPayload{
			Type:          batchsettlement.PayloadTypeSeal,
			ChannelConfig: opened.Payload.ChannelConfig,
			ChannelID:     opened.ChannelID,
			Voucher:       voucher,
		}
		req := requirements(server.PublicKey().String())
		response := settle(t, mismatched.scheme, seal, req)
		require.False(t, response.Success)
		require.Equal(t, batchsettlement.ErrDelegatedUnauthenticated, response.ErrorReason)

		plain := delegatedScheme(delegatedCaller, false)
		_, err = plain.storage.RecordOpen(ctx, paymentchannels.PaymentChannelRecord{
			ChannelID: opened.ChannelID, Network: network, ReceiverAuthorizer: server.PublicKey().String(),
			LastActivityAt: time.Now(),
		})
		require.NoError(t, err)
		stubClose(plain, opened.ChannelID, channelOf(opened.Payload.ChannelConfig, generated.ChannelStatus_Closing, delegatedNow-60))
		response = settle(t, plain.scheme, seal, req)
		require.False(t, response.Success)
		require.Equal(t, batchsettlement.ErrCloseAuthorization, response.ErrorReason)
	})

	t.Run("channel storage keeps the first caller identity for a channel", func(t *testing.T) {
		store := paymentchannels.NewInMemoryPaymentChannelStorage()
		channelID := payer.Address().String()
		first := paymentchannels.PaymentChannelRecord{
			CallerIdentity: delegatedCaller,
			ChannelID:      channelID,
			Network:        network,
			LastActivityAt: time.Now(),
		}
		_, err := store.RecordOpen(ctx, first)
		require.NoError(t, err)
		_, err = store.RecordOpen(ctx, first)
		require.NoError(t, err)
		conflict, err := store.RecordOpen(ctx, paymentchannels.PaymentChannelRecord{
			CallerIdentity: "other",
			ChannelID:      channelID,
			Network:        network,
			LastActivityAt: time.Now(),
		})
		require.NoError(t, err)
		require.ErrorIs(t, paymentchannels.CheckOpenBindings(paymentchannels.PaymentChannelRecord{
			CallerIdentity: "other", ChannelID: channelID, Network: network,
		}, conflict.Record), paymentchannels.ErrCallerIdentityConflict)
		got, err := store.Get(ctx, network, channelID)
		require.NoError(t, err)
		require.NotNil(t, got)
		require.Equal(t, delegatedCaller, got.CallerIdentity)
		require.NoError(t, store.Delete(ctx, network, channelID))
		got, err = store.Get(ctx, network, channelID)
		require.NoError(t, err)
		require.Nil(t, got)
	})

	t.Run("drops the caller identity when rent cleanup deletes the channel", func(t *testing.T) {
		storage := paymentchannels.NewInMemoryPaymentChannelStorage()
		signer := newScriptedSigner(t, 1)
		scheme := NewBatchSvmScheme(ctx, signer, &Config{
			ChannelStorage: storage,
			DelegatedReceiverAuth: &DelegatedReceiverAuth{
				ReceiverAuthorizer: server.PublicKey().String(),
				ResolveCallerIdentity: func(context.Context, DelegatedSettleContext) (string, error) {
					return delegatedCaller, nil
				},
			},
		})
		channelID := payer.Address().String()
		_, err := scheme.GetChannelStorage().RecordOpen(ctx, paymentchannels.PaymentChannelRecord{
			ChannelID:      channelID,
			PayTo:          svm.USDCMainnetAddress,
			TokenProgram:   svm.TokenProgramAddress,
			LastActivityAt: time.Now().Add(-time.Duration(paymentchannels.OpenIndexGraceSecs+1) * time.Second),
			ExpiresAt:      4_102_444_800,
			Network:        network,
			CallerIdentity: delegatedCaller,
		})
		require.NoError(t, err)
		manager := scheme.CreateRentCleanupManager(x402.Network(network))
		require.NoError(t, manager.Cleanup(ctx, CleanupOptions{}))
		got, err := storage.Get(ctx, network, channelID)
		require.NoError(t, err)
		require.Nil(t, got)
	})
}
