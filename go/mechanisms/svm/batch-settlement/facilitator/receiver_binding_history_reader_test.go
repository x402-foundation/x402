package facilitator

import (
	"context"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

func TestReadReceiverBindingFromOpen(t *testing.T) {
	payer := mustKey(t)
	feePayer := mustKey(t)
	server := mustKey(t)
	network := string(svm.SolanaDevnetCAIP2)
	_ = network

	openWith := func(t *testing.T, binding *string, memo *string) (string, string) {
		t.Helper()
		salt := uint64(0)
		built, err := paymentchannels.BuildOpenTransaction(paymentchannels.BuildOpenArgs{
			Payer:            payer.PublicKey(),
			Payee:            feePayer.PublicKey(),
			Mint:             solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
			AuthorizedSigner: payer.PublicKey(),
			FeePayer:         feePayer.PublicKey(),
			TokenProgram:     solana.MustPublicKeyFromBase58(svm.TokenProgramAddress),
			Deposit:          10_000,
			Blockhash:        solana.Hash(solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress)),
			OpenSlot:         123,
			GracePeriod:      900,
			Recipients:       []paymentchannels.Split{{Recipient: svm.USDCMainnetAddress, BPS: batchsettlement.FullSplitBPS}},
			Salt:             &salt,
			Memo:             memo,
			BindingMemo:      binding,
		})
		require.NoError(t, err)
		wire, err := svm.EncodeTransaction(built.Transaction)
		require.NoError(t, err)
		return wire, built.ChannelID.String()
	}

	t.Run("reads the single binding memo on the channel's open", func(t *testing.T) {
		binding := batchsettlement.EncodeReceiverBindingMemo(server.PublicKey().String())
		wire, channelID := openWith(t, &binding, nil)
		got, ok := batchsettlement.ReadReceiverBindingFromOpen(wire, channelID)
		assert.True(t, ok)
		assert.Equal(t, server.PublicKey().String(), got)
		_, ok = batchsettlement.ReadReceiverBindingFromOpen(wire, payer.PublicKey().String())
		assert.False(t, ok)
		_, ok = batchsettlement.ReadReceiverBindingFromOpen("not-a-transaction", channelID)
		assert.False(t, ok)
	})

	t.Run("returns undefined when the open has no binding memo or more than one", func(t *testing.T) {
		wire, channelID := openWith(t, nil, nil)
		_, ok := batchsettlement.ReadReceiverBindingFromOpen(wire, channelID)
		assert.False(t, ok)
		payerMemo := batchsettlement.EncodeReceiverBindingMemo(payer.PublicKey().String())
		serverMemo := batchsettlement.EncodeReceiverBindingMemo(server.PublicKey().String())
		doubled, doubledID := openWith(t, &serverMemo, &payerMemo)
		_, ok = batchsettlement.ReadReceiverBindingFromOpen(doubled, doubledID)
		assert.False(t, ok)
	})
}

func TestBatchSettlementBindingSource(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	payer := mustKey(t)
	feePayer := mustKey(t)
	server := mustKey(t)

	openWire := func(t *testing.T) (string, string) {
		t.Helper()
		salt := uint64(0)
		binding := batchsettlement.EncodeReceiverBindingMemo(server.PublicKey().String())
		built, err := paymentchannels.BuildOpenTransaction(paymentchannels.BuildOpenArgs{
			Payer:            payer.PublicKey(),
			Payee:            feePayer.PublicKey(),
			Mint:             solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
			AuthorizedSigner: payer.PublicKey(),
			FeePayer:         feePayer.PublicKey(),
			TokenProgram:     solana.MustPublicKeyFromBase58(svm.TokenProgramAddress),
			Deposit:          10_000,
			Blockhash:        solana.Hash(solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress)),
			OpenSlot:         123,
			GracePeriod:      900,
			Recipients:       []paymentchannels.Split{{Recipient: svm.USDCMainnetAddress, BPS: batchsettlement.FullSplitBPS}},
			Salt:             &salt,
			BindingMemo:      &binding,
		})
		require.NoError(t, err)
		wire, err := svm.EncodeTransaction(built.Transaction)
		require.NoError(t, err)
		return wire, built.ChannelID.String()
	}

	t.Run("constructs with default channel storage and validates history reader shape", func(t *testing.T) {
		signer := newScriptedSigner(t, 1)
		scheme := NewBatchSvmScheme(context.Background(), signer, nil)
		require.NotNil(t, scheme.GetChannelStorage())
		historySigner := &historyCapableSigner{scriptedSigner: newScriptedSigner(t, 1)}
		withHistory := NewBatchSvmScheme(context.Background(), historySigner, &Config{
			ReceiverBindingHistoryReader: historySigner,
		})
		require.NotNil(t, withHistory.GetChannelStorage())
	})

	t.Run("resolves an open from history, skips a failed transaction, and writes the store back", func(t *testing.T) {
		wire, channelID := openWire(t)
		store := paymentchannels.NewInMemoryPaymentChannelStorage()
		var fetched []string
		history := &scriptHistory{
			signatures: func(before *string) []ReceiverBindingHistorySignature {
				if before == nil {
					page := make([]ReceiverBindingHistorySignature, 0, BindingHistoryPageLimit)
					for i := 0; i < BindingHistoryPageLimit-1; i++ {
						page = append(page, ReceiverBindingHistorySignature{Signature: "failed", Err: "failed"})
					}
					page = append(page, ReceiverBindingHistorySignature{Signature: "not-the-open"})
					return page
				}
				assert.Equal(t, "not-the-open", *before)
				return []ReceiverBindingHistorySignature{{Signature: "the-open"}}
			},
			transaction: func(signature string) string {
				fetched = append(fetched, signature)
				if signature == "not-the-open" {
					return missingBinding(t, payer, feePayer)
				}
				return wire
			},
		}
		got, err := ReadReceiverAuthorizer(context.Background(), store, history, network, channelID, nil)
		require.NoError(t, err)
		assert.Equal(t, server.PublicKey().String(), got.ReceiverAuthorizer)
		assert.Equal(t, []string{"the-open"}, fetched)
		stored, err := store.Get(context.Background(), network, channelID)
		require.NoError(t, err)
		require.NotNil(t, stored)
		assert.Equal(t, server.PublicKey().String(), stored.ReceiverAuthorizer)
	})

	t.Run("does not write a store row when the open has no single binding memo", func(t *testing.T) {
		missing := missingBinding(t, payer, feePayer)
		payerMemo := batchsettlement.EncodeReceiverBindingMemo(payer.PublicKey().String())
		serverMemo := batchsettlement.EncodeReceiverBindingMemo(server.PublicKey().String())
		doubled, doubledID := openMemo(t, payer, feePayer, &serverMemo, &payerMemo)
		missingWire, missingID := missing, ""
		_ = missingWire
		wire := missing
		store := paymentchannels.NewInMemoryPaymentChannelStorage()
		history := &scriptHistory{
			signatures: func(*string) []ReceiverBindingHistorySignature {
				return []ReceiverBindingHistorySignature{{Signature: "only"}}
			},
			transaction: func(string) string { return wire },
		}
		builtMissing := missingBindingChannel(t, payer, feePayer)
		got, err := ReadReceiverAuthorizer(context.Background(), store, history, network, builtMissing, nil)
		require.NoError(t, err)
		assert.Empty(t, got.ReceiverAuthorizer)
		wire = doubled
		got, err = ReadReceiverAuthorizer(context.Background(), store, history, network, doubledID, nil)
		require.NoError(t, err)
		assert.Empty(t, got.ReceiverAuthorizer)
		stored, err := store.Get(context.Background(), network, builtMissing)
		require.NoError(t, err)
		assert.Nil(t, stored)
		stored, err = store.Get(context.Background(), network, doubledID)
		require.NoError(t, err)
		assert.Nil(t, stored)
		_ = missingID
	})

	t.Run("returns a store hit without consulting history", func(t *testing.T) {
		store := paymentchannels.NewInMemoryPaymentChannelStorage()
		const channelID = "stored-channel"
		_, err := store.RecordOpen(context.Background(), paymentchannels.PaymentChannelRecord{
			Network: network, ChannelID: channelID, ReceiverAuthorizer: server.PublicKey().String(), LastActivityAt: time.Now(),
		})
		require.NoError(t, err)
		history := &scriptHistory{
			signatures: func(*string) []ReceiverBindingHistorySignature {
				t.Fatal("history should not run")
				return nil
			},
		}
		got, err := ReadReceiverAuthorizer(context.Background(), store, history, network, channelID, nil)
		require.NoError(t, err)
		assert.Equal(t, server.PublicKey().String(), got.ReceiverAuthorizer)
		assert.Zero(t, history.signatureCalls)
	})

	t.Run("maps a write-back conflict to RECEIVER_AUTHORIZER_MISMATCH and rethrows other bind errors", func(t *testing.T) {
		wire, channelID := openWire(t)
		history := &scriptHistory{
			signatures: func(*string) []ReceiverBindingHistorySignature {
				return []ReceiverBindingHistorySignature{{Signature: "open"}}
			},
			transaction: func(string) string { return wire },
		}
		_, err := ReadReceiverAuthorizer(context.Background(), &conflictStorage{inner: paymentchannels.NewInMemoryPaymentChannelStorage()}, history, network, channelID, nil)
		require.Error(t, err)
		assert.ErrorContains(t, err, batchsettlement.ErrReceiverAuthorizerMismatch)
		_, err = ReadReceiverAuthorizer(context.Background(), diskFullStorage{}, history, network, channelID, nil)
		require.Error(t, err)
		assert.ErrorContains(t, err, "disk full")
	})

	t.Run("validates delegated-auth configuration", func(t *testing.T) {
		got, err := AssertDelegatedReceiverAuth(nil)
		require.NoError(t, err)
		assert.Nil(t, got)
		delegated := &DelegatedReceiverAuth{
			ReceiverAuthorizer:    server.PublicKey().String(),
			ResolveCallerIdentity: func(context.Context, DelegatedSettleContext) (string, error) { return "caller", nil },
		}
		asserted, err := AssertDelegatedReceiverAuth(delegated)
		require.NoError(t, err)
		assert.Equal(t, delegated, asserted)

		badAddress := *delegated
		badAddress.ReceiverAuthorizer = "not-a-key"
		_, err = AssertDelegatedReceiverAuth(&badAddress)
		require.Error(t, err)
		assert.ErrorContains(t, err, "receiverAuthorizer address")

		badResolver := *delegated
		badResolver.ResolveCallerIdentity = nil
		_, err = AssertDelegatedReceiverAuth(&badResolver)
		require.Error(t, err)
		assert.ErrorContains(t, err, "resolveCallerIdentity")
	})

	t.Run("resolves delegated identity and recognizes the delegated authorizer key", func(t *testing.T) {
		var next func() (string, error)
		delegated := &DelegatedReceiverAuth{
			ReceiverAuthorizer: server.PublicKey().String(),
			ResolveCallerIdentity: func(context.Context, DelegatedSettleContext) (string, error) {
				return next()
			},
		}
		next = func() (string, error) { return "caller-a", nil }
		got, err := ResolveDelegatedIdentity(context.Background(), delegated, DelegatedSettleContext{
			Step: DelegatedStepDeposit, ChannelID: "ch", Network: network, Payer: payer.PublicKey().String(),
		})
		require.NoError(t, err)
		assert.Equal(t, "caller-a", got)

		next = func() (string, error) { return "", errString("auth down") }
		got, err = ResolveDelegatedIdentity(context.Background(), delegated, DelegatedSettleContext{
			Step: DelegatedStepSeal, ChannelID: "ch", Network: network, Payer: payer.PublicKey().String(),
		})
		require.NoError(t, err)
		assert.Empty(t, got)

		next = func() (string, error) { return "", nil }
		got, err = ResolveDelegatedIdentity(context.Background(), delegated, DelegatedSettleContext{
			Step: DelegatedStepRefund, ChannelID: "ch", Network: network, Payer: payer.PublicKey().String(),
		})
		require.NoError(t, err)
		assert.Empty(t, got)

		assert.True(t, IsDelegatedAuthorizer(delegated, server.PublicKey().String()))
		assert.False(t, IsDelegatedAuthorizer(delegated, payer.PublicKey().String()))
		assert.False(t, IsDelegatedAuthorizer(nil, server.PublicKey().String()))
	})
}

func missingBinding(t *testing.T, payer, feePayer solana.PrivateKey) string {
	t.Helper()
	wire, _ := openMemo(t, payer, feePayer, nil, nil)
	return wire
}

func missingBindingChannel(t *testing.T, payer, feePayer solana.PrivateKey) string {
	t.Helper()
	_, id := openMemo(t, payer, feePayer, nil, nil)
	return id
}

func openMemo(t *testing.T, payer, feePayer solana.PrivateKey, binding, memo *string) (string, string) {
	t.Helper()
	salt := uint64(0)
	built, err := paymentchannels.BuildOpenTransaction(paymentchannels.BuildOpenArgs{
		Payer:            payer.PublicKey(),
		Payee:            feePayer.PublicKey(),
		Mint:             solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
		AuthorizedSigner: payer.PublicKey(),
		FeePayer:         feePayer.PublicKey(),
		TokenProgram:     solana.MustPublicKeyFromBase58(svm.TokenProgramAddress),
		Deposit:          10_000,
		Blockhash:        solana.Hash(solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress)),
		OpenSlot:         123,
		GracePeriod:      900,
		Recipients:       []paymentchannels.Split{{Recipient: svm.USDCMainnetAddress, BPS: batchsettlement.FullSplitBPS}},
		Salt:             &salt,
		Memo:             memo,
		BindingMemo:      binding,
	})
	require.NoError(t, err)
	wire, err := svm.EncodeTransaction(built.Transaction)
	require.NoError(t, err)
	return wire, built.ChannelID.String()
}

type scriptHistory struct {
	signatures     func(*string) []ReceiverBindingHistorySignature
	transaction    func(string) string
	signatureCalls int
}

func (h *scriptHistory) GetSignaturesForAddress(_ context.Context, _, _ string, before *string, _ *int) ([]ReceiverBindingHistorySignature, error) {
	h.signatureCalls++
	return h.signatures(before), nil
}

func (h *scriptHistory) GetTransaction(_ context.Context, _, signature string) (string, error) {
	if h.transaction == nil {
		return "", nil
	}
	return h.transaction(signature), nil
}

type historyCapableSigner struct{ *scriptedSigner }

func (historyCapableSigner) GetSignaturesForAddress(context.Context, string, string, *string, *int) ([]ReceiverBindingHistorySignature, error) {
	return nil, nil
}

func (historyCapableSigner) GetTransaction(context.Context, string, string) (string, error) {
	return "", nil
}

type conflictStorage struct {
	inner *paymentchannels.InMemoryPaymentChannelStorage
}

func (c *conflictStorage) RecordOpen(ctx context.Context, record paymentchannels.PaymentChannelRecord) (paymentchannels.PaymentChannelOpenWrite, error) {
	_, err := c.inner.RecordOpen(ctx, paymentchannels.PaymentChannelRecord{
		Network: record.Network, ChannelID: record.ChannelID,
		ReceiverAuthorizer: "other-authorizer", LastActivityAt: time.Now(),
	})
	if err != nil {
		return paymentchannels.PaymentChannelOpenWrite{}, err
	}
	return c.inner.RecordOpen(ctx, record)
}

func (c *conflictStorage) RevertOpen(ctx context.Context, write paymentchannels.PaymentChannelOpenWrite) error {
	return c.inner.RevertOpen(ctx, write)
}

func (c *conflictStorage) RecordActivity(ctx context.Context, records ...paymentchannels.PaymentChannelRecord) error {
	return c.inner.RecordActivity(ctx, records...)
}

func (c *conflictStorage) Get(ctx context.Context, network, channelID string) (*paymentchannels.PaymentChannelRecord, error) {
	return c.inner.Get(ctx, network, channelID)
}

func (c *conflictStorage) List(ctx context.Context, network string) ([]paymentchannels.PaymentChannelRecord, error) {
	return c.inner.List(ctx, network)
}

func (c *conflictStorage) Delete(ctx context.Context, network, channelID string) error {
	return c.inner.Delete(ctx, network, channelID)
}

type diskFullStorage struct{}

func (diskFullStorage) RecordOpen(context.Context, paymentchannels.PaymentChannelRecord) (paymentchannels.PaymentChannelOpenWrite, error) {
	return paymentchannels.PaymentChannelOpenWrite{}, errString("disk full")
}

func (diskFullStorage) RevertOpen(context.Context, paymentchannels.PaymentChannelOpenWrite) error {
	return nil
}

func (diskFullStorage) RecordActivity(context.Context, ...paymentchannels.PaymentChannelRecord) error {
	return nil
}

func (diskFullStorage) Get(context.Context, string, string) (*paymentchannels.PaymentChannelRecord, error) {
	return nil, nil
}

func (diskFullStorage) List(context.Context, string) ([]paymentchannels.PaymentChannelRecord, error) {
	return nil, nil
}

func (diskFullStorage) Delete(context.Context, string, string) error { return nil }
