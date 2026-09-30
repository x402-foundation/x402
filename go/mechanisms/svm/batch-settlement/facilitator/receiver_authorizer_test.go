package facilitator

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	batchclient "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/client"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	"github.com/x402-foundation/x402/go/v2/types"
)

const receiverAuthorizerOpenSlot uint64 = 123

type countingGetStore struct {
	inner *paymentchannels.InMemoryPaymentChannelStorage
	mu    sync.Mutex
	gets  int
}

func (s *countingGetStore) RecordOpen(ctx context.Context, record paymentchannels.PaymentChannelRecord) (paymentchannels.PaymentChannelOpenWrite, error) {
	return s.inner.RecordOpen(ctx, record)
}

func (s *countingGetStore) RevertOpen(ctx context.Context, write paymentchannels.PaymentChannelOpenWrite) error {
	return s.inner.RevertOpen(ctx, write)
}

func (s *countingGetStore) RecordActivity(ctx context.Context, records ...paymentchannels.PaymentChannelRecord) error {
	return s.inner.RecordActivity(ctx, records...)
}

func (s *countingGetStore) Get(ctx context.Context, network, channelID string) (*paymentchannels.PaymentChannelRecord, error) {
	s.mu.Lock()
	s.gets++
	s.mu.Unlock()
	return s.inner.Get(ctx, network, channelID)
}

func (s *countingGetStore) List(ctx context.Context, network string) ([]paymentchannels.PaymentChannelRecord, error) {
	return s.inner.List(ctx, network)
}

func (s *countingGetStore) Delete(ctx context.Context, network, channelID string) error {
	return s.inner.Delete(ctx, network, channelID)
}

func (s *countingGetStore) getCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gets
}

func (s *countingGetStore) resetGets() {
	s.mu.Lock()
	s.gets = 0
	s.mu.Unlock()
}

type failingRecordOpenStore struct {
	inner   *paymentchannels.InMemoryPaymentChannelStorage
	openErr error
}

func (s *failingRecordOpenStore) RecordOpen(ctx context.Context, record paymentchannels.PaymentChannelRecord) (paymentchannels.PaymentChannelOpenWrite, error) {
	if s.openErr != nil {
		return paymentchannels.PaymentChannelOpenWrite{}, s.openErr
	}
	return s.inner.RecordOpen(ctx, record)
}

func (s *failingRecordOpenStore) RevertOpen(ctx context.Context, write paymentchannels.PaymentChannelOpenWrite) error {
	return s.inner.RevertOpen(ctx, write)
}

func (s *failingRecordOpenStore) RecordActivity(ctx context.Context, records ...paymentchannels.PaymentChannelRecord) error {
	return s.inner.RecordActivity(ctx, records...)
}

func (s *failingRecordOpenStore) Get(ctx context.Context, network, channelID string) (*paymentchannels.PaymentChannelRecord, error) {
	return s.inner.Get(ctx, network, channelID)
}

func (s *failingRecordOpenStore) List(ctx context.Context, network string) ([]paymentchannels.PaymentChannelRecord, error) {
	return s.inner.List(ctx, network)
}

func (s *failingRecordOpenStore) Delete(ctx context.Context, network, channelID string) error {
	return s.inner.Delete(ctx, network, channelID)
}

func TestBatchSettlementReceiverAuthorizerBinding(t *testing.T) {
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

	openArgs := func(overrides func(*paymentchannels.BuildOpenArgs)) paymentchannels.BuildOpenArgs {
		binding := batchsettlement.EncodeReceiverBindingMemo(server.PublicKey().String())
		args := paymentchannels.BuildOpenArgs{
			AuthorizedSigner: payer.Address(),
			BindingMemo:      &binding,
			Blockhash:        solana.MustHashFromBase58(svm.USDCMainnetAddress),
			Deposit:          10_000,
			FeePayer:         feeKey.PublicKey(),
			GracePeriod:      900,
			Mint:             solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
			OpenSlot:         receiverAuthorizerOpenSlot,
			Payee:            feeKey.PublicKey(),
			Payer:            payer.Address(),
			Recipients:       []paymentchannels.Split{{Recipient: svm.USDCMainnetAddress, BPS: batchsettlement.FullSplitBPS}},
			Salt:             &salt,
			TokenProgram:     solana.MustPublicKeyFromBase58(svm.TokenProgramAddress),
		}
		if overrides != nil {
			overrides(&args)
		}
		return args
	}

	verifyOpen := func(t *testing.T, transaction string, expectedBindingMemo *string) (*paymentchannels.VerifyOpenResult, error) {
		t.Helper()
		return paymentchannels.VerifyOpenTransaction(transaction, paymentchannels.VerifyOpenExpected{
			AuthorizedSigner:    payer.Address(),
			ExpectedBindingMemo: expectedBindingMemo,
			FeePayer:            feeKey.PublicKey(),
			From:                payer.Address(),
			MaxCap:              10_000,
			Mint:                solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
			OpenSlot:            receiverAuthorizerOpenSlot,
			Payee:               feeKey.PublicKey(),
			Recipients:          []paymentchannels.Split{{Recipient: svm.USDCMainnetAddress, BPS: batchsettlement.FullSplitBPS}},
			TokenProgram:        solana.MustPublicKeyFromBase58(svm.TokenProgramAddress),
			WithdrawDelay:       900,
		})
	}

	signAndEncode := func(t *testing.T, built *paymentchannels.BuiltOpen) string {
		t.Helper()
		require.NoError(t, payer.SignTransaction(ctx, built.Transaction))
		wire, err := svm.EncodeTransaction(built.Transaction)
		require.NoError(t, err)
		return wire
	}

	liveChannel := func() *generated.Channel {
		hash, err := paymentchannels.GetChannelDistributionHash([]paymentchannels.Split{{
			Recipient: svm.USDCMainnetAddress, BPS: batchsettlement.FullSplitBPS,
		}})
		require.NoError(t, err)
		return &generated.Channel{
			Discriminator:    uint8(generated.AccountDiscriminator_Channel),
			Bump:             1,
			Version:          1,
			Status:           uint8(generated.ChannelStatus_Open),
			Salt:             0,
			Deposit:          10_000,
			Settlement:       generated.SettlementWatermarks{},
			ClosureStartedAt: 0,
			GracePeriod:      900,
			DistributionHash: hash,
			Payer:            payer.Address(),
			Payee:            feeKey.PublicKey(),
			AuthorizedSigner: payer.Address(),
			Mint:             solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
			RentPayer:        feeKey.PublicKey(),
			OpenSlot:         receiverAuthorizerOpenSlot,
		}
	}

	openedDeposit := func(t *testing.T) (channelID string, payment types.PaymentPayload, req types.PaymentRequirements) {
		t.Helper()
		built, err := batchclient.BuildDepositPayload(ctx, batchclient.BuildDepositArgs{
			Payer:              payer,
			Receiver:           svm.USDCMainnetAddress,
			ReceiverAuthorizer: payer.Address().String(),
			Mint:               svm.USDCDevnetAddress,
			FeePayer:           feeKey.PublicKey().String(),
			TokenProgram:       svm.TokenProgramAddress,
			Blockhash:          solana.MustHashFromBase58(svm.USDCMainnetAddress),
			OpenSlot:           receiverAuthorizerOpenSlot,
			DepositAmount:      10_000,
			FirstCharge:        1_000,
			WithdrawDelay:      900,
			Salt:               &salt,
		})
		require.NoError(t, err)
		req = requirements(payer.Address().String())
		return built.ChannelID, types.PaymentPayload{
			X402Version: 2,
			Accepted:    req,
			Payload:     asMap(t, built.Payload),
		}, req
	}

	type openFacilitator struct {
		scheme *BatchSvmScheme
		signer *tokenOwnerSigner
	}

	facilitatorFor := func(storage paymentchannels.PaymentChannelStorage, history ReceiverBindingHistoryReader) *openFacilitator {
		signer := newTokenOwnerSigner(feeKey)
		cfg := &Config{}
		if storage != nil {
			cfg.ChannelStorage = storage
		}
		if history != nil {
			cfg.ReceiverBindingHistoryReader = history
		}
		scheme := NewBatchSvmScheme(ctx, signer, cfg)
		fixture := &openFacilitator{scheme: scheme, signer: signer}
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return nil, nil
		}
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return liveChannel(), nil
		}
		return fixture
	}

	settle := func(t *testing.T, scheme *BatchSvmScheme, payment types.PaymentPayload, req types.PaymentRequirements) *x402.SettleResponse {
		t.Helper()
		response, err := scheme.Settle(ctx, payment, req, nil)
		require.NoError(t, err)
		return response
	}

	t.Run("keeps the first binding for a channel and refuses a different key", func(t *testing.T) {
		store := paymentchannels.NewInMemoryPaymentChannelStorage()
		first := paymentchannels.PaymentChannelRecord{
			ChannelID:          svm.USDCMainnetAddress,
			Network:            network,
			ReceiverAuthorizer: server.PublicKey().String(),
			LastActivityAt:     time.Now(),
		}
		_, err := store.RecordOpen(ctx, first)
		require.NoError(t, err)
		_, err = store.RecordOpen(ctx, first)
		require.NoError(t, err)
		conflict, err := store.RecordOpen(ctx, paymentchannels.PaymentChannelRecord{
			ChannelID:          svm.USDCMainnetAddress,
			Network:            network,
			ReceiverAuthorizer: payer.Address().String(),
			LastActivityAt:     time.Now(),
		})
		require.NoError(t, err)
		require.ErrorIs(t, paymentchannels.CheckOpenBindings(paymentchannels.PaymentChannelRecord{
			ChannelID: svm.USDCMainnetAddress, Network: network, ReceiverAuthorizer: payer.Address().String(),
		}, conflict.Record), paymentchannels.ErrReceiverAuthorizerConflict)
		got, err := store.Get(ctx, network, svm.USDCMainnetAddress)
		require.NoError(t, err)
		require.NotNil(t, got)
		require.Equal(t, server.PublicKey().String(), got.ReceiverAuthorizer)
		other, err := store.Get(ctx, "solana:other", svm.USDCMainnetAddress)
		require.NoError(t, err)
		require.Nil(t, other)
		require.NoError(t, store.Delete(ctx, network, svm.USDCMainnetAddress))
		got, err = store.Get(ctx, network, svm.USDCMainnetAddress)
		require.NoError(t, err)
		require.Nil(t, got)
	})

	t.Run("round-trips the binding memo and rejects anything else", func(t *testing.T) {
		memo := batchsettlement.EncodeReceiverBindingMemo(server.PublicKey().String())
		require.Equal(t, batchsettlement.ReceiverBindingMemoPrefix+server.PublicKey().String(), memo)
		parsed, ok := batchsettlement.ParseReceiverBindingMemo(memo)
		require.True(t, ok)
		require.Equal(t, server.PublicKey().String(), parsed)
		_, ok = batchsettlement.ParseReceiverBindingMemo(server.PublicKey().String())
		require.False(t, ok)
		_, ok = batchsettlement.ParseReceiverBindingMemo(batchsettlement.ReceiverBindingMemoPrefix + "not-a-key")
		require.False(t, ok)
		_, ok = batchsettlement.ParseReceiverBindingMemo(batchsettlement.ReceiverBindingMemoPrefix)
		require.False(t, ok)
	})

	t.Run("requires exactly one matching binding memo in the open", func(t *testing.T) {
		expected := batchsettlement.EncodeReceiverBindingMemo(server.PublicKey().String())
		invoice := "invoice-42"
		bound, err := paymentchannels.BuildOpenTransaction(openArgs(func(args *paymentchannels.BuildOpenArgs) {
			args.Memo = &invoice
		}))
		require.NoError(t, err)
		result, err := verifyOpen(t, signAndEncode(t, bound), &expected)
		require.NoError(t, err)
		require.Equal(t, bound.ChannelID, result.ChannelID)

		unbound, err := paymentchannels.BuildOpenTransaction(openArgs(func(args *paymentchannels.BuildOpenArgs) {
			args.BindingMemo = nil
		}))
		require.NoError(t, err)
		_, err = verifyOpen(t, signAndEncode(t, unbound), nil)
		require.NoError(t, err)

		_, err = verifyOpen(t, signAndEncode(t, unbound), &expected)
		require.Error(t, err)
		require.Contains(t, err.Error(), "found 0")

		duplicate, err := paymentchannels.BuildOpenTransaction(openArgs(func(args *paymentchannels.BuildOpenArgs) {
			args.Memo = &expected
		}))
		require.NoError(t, err)
		_, err = verifyOpen(t, signAndEncode(t, duplicate), &expected)
		require.Error(t, err)
		require.Contains(t, err.Error(), "found 2")

		payerBinding := batchsettlement.EncodeReceiverBindingMemo(payer.Address().String())
		other, err := paymentchannels.BuildOpenTransaction(openArgs(func(args *paymentchannels.BuildOpenArgs) {
			args.BindingMemo = &payerBinding
		}))
		require.NoError(t, err)
		_, err = verifyOpen(t, signAndEncode(t, other), &expected)
		require.Error(t, err)
		require.Contains(t, err.Error(), "found 0")

		both, err := paymentchannels.BuildOpenTransaction(openArgs(func(args *paymentchannels.BuildOpenArgs) {
			args.Memo = &payerBinding
		}))
		require.NoError(t, err)
		_, err = verifyOpen(t, signAndEncode(t, both), &expected)
		require.Error(t, err)
		require.Contains(t, err.Error(), "found 2")
	})

	t.Run("keeps a bound open within the packet limit and refuses an oversized one", func(t *testing.T) {
		invoice := "invoice-42"
		open, err := paymentchannels.BuildOpenTransaction(openArgs(func(args *paymentchannels.BuildOpenArgs) {
			args.Memo = &invoice
		}))
		require.NoError(t, err)
		raw, err := open.Transaction.MarshalBinary()
		require.NoError(t, err)
		require.LessOrEqual(t, len(raw), 1232)

		oversized := strings.Repeat("x", 1_000)
		_, err = paymentchannels.BuildOpenTransaction(openArgs(func(args *paymentchannels.BuildOpenArgs) {
			args.BindingMemo = &oversized
			args.Memo = &invoice
		}))
		require.Error(t, err)
		require.Contains(t, err.Error(), "1232-byte packet limit")
	})

	t.Run("refuses a channel the payer bound to its own key when the server's key is advertised", func(t *testing.T) {
		store := &countingGetStore{inner: paymentchannels.NewInMemoryPaymentChannelStorage()}
		signer := newTokenOwnerSigner(feeKey)
		scheme := NewBatchSvmScheme(ctx, signer, &Config{ChannelStorage: store})
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return nil, nil
		}
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return liveChannel(), nil
		}
		built, err := batchclient.BuildDepositPayload(ctx, batchclient.BuildDepositArgs{
			Payer:              payer,
			Receiver:           svm.USDCMainnetAddress,
			ReceiverAuthorizer: payer.Address().String(),
			Mint:               svm.USDCDevnetAddress,
			FeePayer:           feeKey.PublicKey().String(),
			TokenProgram:       svm.TokenProgramAddress,
			Blockhash:          solana.MustHashFromBase58(svm.USDCMainnetAddress),
			OpenSlot:           receiverAuthorizerOpenSlot,
			DepositAmount:      10_000,
			FirstCharge:        1_000,
			WithdrawDelay:      900,
			Salt:               &salt,
		})
		require.NoError(t, err)
		channelID := built.ChannelID
		payerReq := requirements(payer.Address().String())
		response := settle(t, scheme, types.PaymentPayload{
			X402Version: 2, Accepted: payerReq, Payload: asMap(t, built.Payload),
		}, payerReq)
		require.True(t, response.Success)
		require.NotEmpty(t, response.Transaction)
		bound, err := store.inner.Get(ctx, network, channelID)
		require.NoError(t, err)
		require.NotNil(t, bound)
		require.Equal(t, payer.Address().String(), bound.ReceiverAuthorizer)

		store.resetGets()
		serverReq := requirements(server.PublicKey().String())
		channelConfig := built.Payload.ChannelConfig
		channelConfig.ReceiverAuthorizer = server.PublicKey().String()

		verify, err := scheme.Verify(ctx, types.PaymentPayload{
			X402Version: 2,
			Accepted:    serverReq,
			Payload: asMap(t, map[string]any{
				"channelConfig": channelConfig,
				"type":          batchsettlement.PayloadTypeVoucher,
				"voucher":       built.Payload.Voucher,
			}),
		}, serverReq, nil)
		require.NoError(t, err)
		require.True(t, verify.IsValid)

		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return liveChannel(), nil
		}
		topUp := built.Payload
		topUp.ChannelConfig = channelConfig
		_, err = scheme.Verify(ctx, types.PaymentPayload{
			X402Version: 2, Accepted: serverReq, Payload: asMap(t, topUp),
		}, serverReq, nil)
		require.NoError(t, err)
		require.Equal(t, 0, store.getCount())

		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return nil, nil
		}
		verify, err = scheme.Verify(ctx, types.PaymentPayload{
			X402Version: 2,
			Accepted:    serverReq,
			Payload: asMap(t, map[string]any{
				"channelConfig": channelConfig,
				"type":          batchsettlement.PayloadTypeRefund,
				"voucher":       built.Payload.Voucher,
			}),
		}, serverReq, nil)
		require.NoError(t, err)
		require.False(t, verify.IsValid)
		require.Equal(t, batchsettlement.ErrReceiverAuthorizerMismatch, verify.InvalidReason)
	})

	t.Run("broadcasts an open only after channel storage accepts the write", func(t *testing.T) {
		channelID, payment, req := openedDeposit(t)

		down := &failingRecordOpenStore{inner: paymentchannels.NewInMemoryPaymentChannelStorage(), openErr: errors.New("store down")}
		failed := facilitatorFor(down, nil)
		response := settle(t, failed.scheme, payment, req)
		require.False(t, response.Success)
		require.Equal(t, "transaction_failed", response.ErrorReason)
		require.Empty(t, failed.signer.sentTransactions())

		stored := paymentchannels.NewInMemoryPaymentChannelStorage()
		opened := facilitatorFor(stored, nil)
		response = settle(t, opened.scheme, payment, req)
		require.True(t, response.Success)
		require.NotEmpty(t, response.Transaction)
		require.Len(t, opened.signer.sentTransactions(), 1)
		bound, err := stored.Get(ctx, network, channelID)
		require.NoError(t, err)
		require.NotNil(t, bound)
		require.Equal(t, payer.Address().String(), bound.ReceiverAuthorizer)
	})

	t.Run("does not broadcast when channel storage write fails even with history configured", func(t *testing.T) {
		_, payment, req := openedDeposit(t)
		store := &failingRecordOpenStore{inner: paymentchannels.NewInMemoryPaymentChannelStorage(), openErr: errors.New("store down")}
		history := &scriptHistory{
			signatures:  func(*string) []ReceiverBindingHistorySignature { return nil },
			transaction: func(string) string { return "" },
		}
		fixture := facilitatorFor(store, history)
		response := settle(t, fixture.scheme, payment, req)
		require.False(t, response.Success)
		require.Equal(t, "transaction_failed", response.ErrorReason)
		require.Empty(t, fixture.signer.sentTransactions())
	})

	t.Run("opens with default storage when only a history reader is configured", func(t *testing.T) {
		_, payment, req := openedDeposit(t)
		history := &scriptHistory{
			signatures:  func(*string) []ReceiverBindingHistorySignature { return nil },
			transaction: func(string) string { return "" },
		}
		fixture := facilitatorFor(nil, history)
		response := settle(t, fixture.scheme, payment, req)
		require.True(t, response.Success)
		require.NotEmpty(t, response.Transaction)
		require.Len(t, fixture.signer.sentTransactions(), 1)
	})
}
