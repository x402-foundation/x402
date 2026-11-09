package facilitator

import (
	"bytes"
	"context"
	"errors"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestBatchSettlementOutcomeRecovery(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	mint := svm.USDCDevnetAddress
	receiver := svm.USDCMainnetAddress
	txSig := solana.Signature{7}
	tx := txSig.String()
	payer := mustKey(t)
	feePayer := mustKey(t)
	channelID := svm.USDCMainnetAddress
	channelConfig := batchsettlement.BatchChannelConfig{
		OpenSlot:           1,
		Payer:              payer.PublicKey().String(),
		PayerAuthorizer:    payer.PublicKey().String(),
		Receiver:           receiver,
		ReceiverAuthorizer: receiver,
		Salt:               "0",
		Token:              mint,
		WithdrawDelay:      900,
	}
	terms := BatchTerms{
		FeePayer:           feePayer.PublicKey().String(),
		ReceiverAuthorizer: receiver,
		TokenProgram:       svm.TokenProgramAddress,
		VoucherSigner:      batchsettlement.VoucherSignerClient,
		WithdrawDelay:      900,
	}
	requirements := types.PaymentRequirements{
		Amount: "1000",
		Asset:  mint,
		Extra: map[string]any{
			"feePayer":           feePayer.PublicKey().String(),
			"receiverAuthorizer": receiver,
			"tokenProgram":       svm.TokenProgramAddress,
			"withdrawDelay":      900,
		},
		MaxTimeoutSeconds: 300,
		Network:           network,
		PayTo:             receiver,
		Scheme:            batchsettlement.Scheme,
	}
	hash, err := paymentchannels.GetChannelDistributionHash([]paymentchannels.Split{{
		Recipient: receiver, BPS: batchsettlement.FullSplitBPS,
	}})
	require.NoError(t, err)

	channel := func(overrides func(*generated.Channel)) *generated.Channel {
		ch := &generated.Channel{
			Discriminator:    uint8(generated.AccountDiscriminator_Channel),
			Bump:             1,
			Version:          1,
			Status:           uint8(generated.ChannelStatus_Open),
			Salt:             0,
			Deposit:          10_000,
			Settlement:       generated.SettlementWatermarks{},
			GracePeriod:      900,
			DistributionHash: hash,
			Payer:            payer.PublicKey(),
			Payee:            feePayer.PublicKey(),
			AuthorizedSigner: payer.PublicKey(),
			Mint:             solana.MustPublicKeyFromBase58(mint),
			RentPayer:        feePayer.PublicKey(),
			OpenSlot:         1,
		}
		if overrides != nil {
			overrides(ch)
		}
		return ch
	}
	encodeChannel := func(t *testing.T, ch *generated.Channel) []byte {
		t.Helper()
		buf := new(bytes.Buffer)
		require.NoError(t, ch.MarshalWithEncoder(bin.NewBorshEncoder(buf)))
		return buf.Bytes()
	}
	payoutEvidence := func(t *testing.T, before, after string) *svm.FacilitatorConfirmedTransaction {
		t.Helper()
		tokenProgram := solana.MustPublicKeyFromBase58(svm.TokenProgramAddress)
		mintKey := solana.MustPublicKeyFromBase58(mint)
		recipient, err := paymentchannels.FindATA(solana.MustPublicKeyFromBase58(receiver), mintKey, tokenProgram)
		require.NoError(t, err)
		escrow, err := paymentchannels.FindATA(solana.MustPublicKeyFromBase58(channelID), mintKey, tokenProgram)
		require.NoError(t, err)
		token := func(index int, owner, amount string) svm.FacilitatorTokenBalance {
			return svm.FacilitatorTokenBalance{
				AccountIndex:  index,
				Mint:          mint,
				Owner:         owner,
				UITokenAmount: svm.FacilitatorTokenAmount{Amount: amount},
			}
		}
		return &svm.FacilitatorConfirmedTransaction{
			Slot:        100,
			AccountKeys: []string{recipient.String(), escrow.String()},
			Meta: &svm.FacilitatorConfirmedMeta{
				PreTokenBalances:  []svm.FacilitatorTokenBalance{token(0, receiver, before), token(1, channelID, "9800")},
				PostTokenBalances: []svm.FacilitatorTokenBalance{token(0, receiver, after), token(1, channelID, "9000")},
			},
		}
	}
	claimPayload := func(t *testing.T, amount uint64) batchsettlement.BatchClaimPayload {
		t.Helper()
		sig, err := paymentchannels.SignVoucher(context.Background(), ed25519Signer{payer}, solana.MustPublicKeyFromBase58(channelID), amount, 0)
		require.NoError(t, err)
		return batchsettlement.BatchClaimPayload{
			Type: batchsettlement.PayloadTypeClaim,
			Claims: []batchsettlement.BatchVoucherClaim{{
				ChannelID:     channelID,
				ChannelConfig: channelConfig,
				Voucher: batchsettlement.BatchVoucher{
					ChannelID:          channelID,
					ExpiresAt:          0,
					MaxClaimableAmount: strconv.FormatUint(amount, 10),
					Signature:          sig,
				},
			}},
		}
	}
	configure := func(scheme *BatchSvmScheme) {
		scheme.hooks.resolveTerms = func(context.Context, batchsettlement.BatchChannelConfig, types.PaymentRequirements, VoucherModeBinding) (BatchTerms, error) {
			return terms, nil
		}
		scheme.hooks.deriveChannelID = func(context.Context, batchsettlement.BatchChannelConfig, string) (string, error) {
			return channelID, nil
		}
		scheme.hooks.distributeInstruction = func(context.Context, string, *generated.Channel, BatchTerms, types.PaymentRequirements) (solana.Instruction, error) {
			return solana.NewInstruction(solana.MustPublicKeyFromBase58(receiver), nil, []byte{7}), nil
		}
	}
	stubPrepareRefund := func(scheme *BatchSvmScheme) {
		scheme.hooks.sealDependencies = func() SealDependencies {
			deps := scheme.defaultSealDependencies()
			deps.PrepareRefund = func(context.Context, batchsettlement.BatchRefundPayload, types.PaymentRequirements, RefundLimits, any) (PreparedRefund, error) {
				return PreparedRefund{ChannelID: channelID, RequestClose: "signed-close", Terms: terms}, nil
			}
			return deps
		}
	}
	newScheme := func(t *testing.T, signer svm.FacilitatorSvmSigner, store PendingSettlementStore, onDist OnDistributionConfirmed) *BatchSvmScheme {
		t.Helper()
		cfg := &Config{}
		if store != nil {
			cfg.PendingSettlementStore = store
		}
		if onDist != nil {
			cfg.OnDistributionConfirmed = onDist
		}
		return NewBatchSvmScheme(context.Background(), signer, cfg)
	}
	confirming := func(t *testing.T, slot uint64, confirmErr error) *confirmingSigner {
		t.Helper()
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		inner.confirmErr = confirmErr
		return &confirmingSigner{scriptedSigner: inner, slot: slot}
	}
	signedWire := func(t *testing.T) (string, solana.Signature) {
		t.Helper()
		instruction := solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.MemoProgramAddress), nil, []byte{1})
		built, err := solana.NewTransaction(
			[]solana.Instruction{instruction},
			solana.MustHashFromBase58("11111111111111111111111111111111"),
			solana.TransactionPayer(feePayer.PublicKey()),
		)
		require.NoError(t, err)
		_, err = built.Sign(func(key solana.PublicKey) *solana.PrivateKey {
			if key.Equals(feePayer.PublicKey()) {
				return &feePayer
			}
			return nil
		})
		require.NoError(t, err)
		wire, err := svm.EncodeTransaction(built)
		require.NoError(t, err)
		return wire, built.Signatures[0]
	}

	t.Run("recovers a completed claim after cleanup without recreating its lifecycle record", func(t *testing.T) {
		payload := claimPayload(t, 1000)
		store := x402.NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), "batch:claim:"+network+":"+channelID+":1000:completed", tx))
		for attempt := 0; attempt < 2; attempt++ {
			storage := newActivityRecordingStorage()
			signer := confirming(t, 0, nil)
			scheme := newScheme(t, signer, store, nil)
			scheme.channelStorage = storage
			configure(scheme)
			var readCalls, submitCalls atomic.Int32
			scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
				readCalls.Add(1)
				return nil, nil
			}
			scheme.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
				submitCalls.Add(1)
				return durableResult{}, errors.New("should not submit")
			}
			response, err := scheme.settleClaims(context.Background(), payload, requirements)
			require.NoError(t, err)
			require.True(t, response.Success)
			require.Equal(t, tx, response.Transaction)
			require.Zero(t, storage.activityCalls.Load())
			require.Zero(t, readCalls.Load())
			require.Empty(t, signer.accountCalls())
			require.Empty(t, signer.confirmCalls())
			require.Zero(t, submitCalls.Load())
			require.Empty(t, signer.sentTransactions())
		}
	})

	t.Run("recovers a restart between preparation and broadcast using identical bytes", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
		wire, signature := signedWire(t)
		key := "batch:claim:" + network + ":" + channelID + ":1000"
		require.NoError(t, store.Set(context.Background(), key, signature.String()))
		require.NoError(t, store.Set(context.Background(), "batch:transaction:"+network+":"+signature.String()+":wire", wire))
		signer := confirming(t, 123, nil)
		scheme := newScheme(t, signer, store, nil)
		configure(scheme)
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(ch *generated.Channel) {
				ch.Settlement = generated.SettlementWatermarks{Settled: 1000}
			}), nil
		}
		var submitCalls atomic.Int32
		scheme.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			submitCalls.Add(1)
			return durableResult{}, errors.New("should not submit")
		}
		payload := claimPayload(t, 1000)
		response, err := scheme.settleClaims(context.Background(), payload, requirements)
		require.NoError(t, err)
		require.True(t, response.Success)
		require.Equal(t, signature.String(), response.Transaction)
		sent := signer.sentTransactions()
		require.Len(t, sent, 1)
		encoded, err := svm.EncodeTransaction(sent[0])
		require.NoError(t, err)
		require.Equal(t, wire, encoded)
		require.Zero(t, submitCalls.Load())
	})

	t.Run("constrains post-confirmation reads to the transaction slot and retries a lagging RPC", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
		key := "batch:claim:" + network + ":" + channelID + ":1000"
		require.NoError(t, store.Set(context.Background(), key, tx))
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		var accountMu sync.Mutex
		var accountCalls []accountCall
		var accountAttempts atomic.Int32
		encoded := encodeChannel(t, channel(func(ch *generated.Channel) {
			ch.Settlement = generated.SettlementWatermarks{Settled: 1000}
		}))
		signer := &slotAccountSigner{
			confirmingSigner: &confirmingSigner{scriptedSigner: inner, slot: 321},
			getAccount: func(_ context.Context, account solana.PublicKey, _ string, opts *rpc.GetAccountInfoOpts) (*rpc.GetAccountInfoResult, error) {
				accountMu.Lock()
				accountCalls = append(accountCalls, accountCall{account: account, opts: opts})
				accountMu.Unlock()
				if accountAttempts.Add(1) == 1 {
					return nil, errors.New("Minimum context slot has not been reached")
				}
				return &rpc.GetAccountInfoResult{Value: &rpc.Account{Data: rpc.DataBytesOrJSONFromBytes(encoded)}}, nil
			},
		}
		scheme := newScheme(t, signer, store, nil)
		configure(scheme)
		scheme.hooks.waitForChannelRead = func(int) error { return nil }
		payload := claimPayload(t, 1000)
		response, err := scheme.settleClaims(context.Background(), payload, requirements)
		require.NoError(t, err)
		require.True(t, response.Success)
		require.Equal(t, tx, response.Transaction)
		accountMu.Lock()
		defer accountMu.Unlock()
		require.Len(t, accountCalls, 2)
		for _, call := range accountCalls {
			require.NotNil(t, call.opts)
			require.Equal(t, rpc.CommitmentConfirmed, call.opts.Commitment)
			require.NotNil(t, call.opts.MinContextSlot)
			require.Equal(t, uint64(321), *call.opts.MinContextSlot)
		}
	})

	t.Run("keeps unknown transactions pending and never builds replacement bytes", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
		wire, signature := signedWire(t)
		key := "batch:claim:" + network + ":" + channelID + ":1000"
		require.NoError(t, store.Set(context.Background(), key, signature.String()))
		require.NoError(t, store.Set(context.Background(), "batch:transaction:"+network+":"+signature.String()+":wire", wire))
		signer := confirming(t, 0, errors.New("history unavailable"))
		scheme := newScheme(t, signer, store, nil)
		configure(scheme)
		var submitCalls atomic.Int32
		scheme.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			submitCalls.Add(1)
			return durableResult{}, errors.New("should not submit")
		}
		payload := claimPayload(t, 1000)
		for i := 0; i < 2; i++ {
			response, err := scheme.settleClaims(context.Background(), payload, requirements)
			require.NoError(t, err)
			require.False(t, response.Success)
			require.Equal(t, signature.String(), response.Transaction)
			require.Equal(t, x402.ErrSettlementPending, response.ErrorReason)
		}
		got, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		require.True(t, ok)
		require.Equal(t, signature.String(), got)
		require.Zero(t, submitCalls.Load())
		wires := map[string]struct{}{}
		for _, sent := range signer.sentTransactions() {
			encoded, err := svm.EncodeTransaction(sent)
			require.NoError(t, err)
			wires[encoded] = struct{}{}
		}
		require.Equal(t, map[string]struct{}{wire: {}}, wires)
	})

	t.Run("retries a stale claim read after confirmation", func(t *testing.T) {
		scheme := newScheme(t, confirming(t, 0, nil), nil, nil)
		configure(scheme)
		var reads atomic.Int32
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			n := reads.Add(1)
			if n <= 2 {
				return channel(nil), nil
			}
			return channel(func(ch *generated.Channel) {
				ch.Settlement = generated.SettlementWatermarks{Settled: 1_000}
			}), nil
		}
		var submits atomic.Int32
		scheme.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			submits.Add(1)
			return durableResult{OK: true, Signature: tx}, nil
		}
		scheme.hooks.waitForChannelRead = func(int) error { return nil }
		payload := claimPayload(t, 1000)
		response, err := scheme.settleClaims(context.Background(), payload, requirements)
		require.NoError(t, err)
		require.True(t, response.Success)
		require.Equal(t, tx, response.Transaction)
		extra := asMap(t, response.Extra)
		accepts, ok := extra["accepts"].([]any)
		require.True(t, ok)
		require.Len(t, accepts, 1)
		accept := asMap(t, accepts[0])
		require.Equal(t, channelID, accept["channelId"])
		require.Equal(t, "1000", accept["totalClaimed"])
		require.Equal(t, int32(3), reads.Load())
		require.Equal(t, int32(1), submits.Load())
	})

	t.Run("recovers a lost claim response after restart and never credits an unrelated watermark", func(t *testing.T) {
		payload := claimPayload(t, 1000)
		key := "batch:claim:" + network + ":" + channelID + ":1000"
		store := x402.NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), key, tx))
		recoveringSigner := confirming(t, 1, nil)
		recovering := newScheme(t, recoveringSigner, store, nil)
		configure(recovering)
		recovering.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(ch *generated.Channel) {
				ch.Settlement = generated.SettlementWatermarks{Settled: 1_000}
			}), nil
		}
		var recoverySubmits atomic.Int32
		recovering.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			recoverySubmits.Add(1)
			return durableResult{}, errors.New("should not submit")
		}
		recovered, err := recovering.settleClaims(context.Background(), payload, requirements)
		require.NoError(t, err)
		require.True(t, recovered.Success)
		require.Equal(t, tx, recovered.Transaction)
		require.Len(t, recoveringSigner.confirmCalls(), 1)
		require.Zero(t, recoverySubmits.Load())
		_, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		require.False(t, ok)
		completed, ok, err := store.Get(context.Background(), key+CompletedBroadcastSuffix)
		require.NoError(t, err)
		require.True(t, ok)
		require.Equal(t, tx, completed)

		restarted := newScheme(t, confirming(t, 0, nil), store, nil)
		configure(restarted)
		var restartedReads, restartedSubmits atomic.Int32
		restarted.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			restartedReads.Add(1)
			return nil, nil
		}
		restarted.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			restartedSubmits.Add(1)
			return durableResult{}, errors.New("should not submit")
		}
		replay, err := restarted.settleClaims(context.Background(), payload, requirements)
		require.NoError(t, err)
		require.True(t, replay.Success)
		require.Equal(t, tx, replay.Transaction)
		require.Zero(t, restartedReads.Load())
		require.Zero(t, restartedSubmits.Load())

		unrelated := newScheme(t, confirming(t, 0, nil), nil, nil)
		configure(unrelated)
		unrelated.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(ch *generated.Channel) {
				ch.Settlement = generated.SettlementWatermarks{Settled: 2_000}
			}), nil
		}
		var unrelatedSubmits atomic.Int32
		unrelated.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			unrelatedSubmits.Add(1)
			return durableResult{}, errors.New("should not submit")
		}
		_, err = unrelated.settleClaims(context.Background(), payload, requirements)
		require.Error(t, err)
		require.ErrorContains(t, err, batchsettlement.ErrCumulativeAmountMismatch)
		require.Zero(t, unrelatedSubmits.Load())
	})

	t.Run("coalesces distributions across managers sharing the same reference store", func(t *testing.T) {
		store := NewInMemoryPendingSettlementStore()
		key := "batch:distribute:" + network + ":" + mint + ":" + receiver + ":" + channelID
		require.NoError(t, store.Set(context.Background(), key, tx))
		var confirmedCalls atomic.Int32
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		transport := &capabilitySigner{
			scriptedSigner: inner,
			confirmed: func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
				confirmedCalls.Add(1)
				return payoutEvidence(t, "200", "1000"), nil
			},
		}
		first := newScheme(t, transport, store, nil)
		second := newScheme(t, transport, store, nil)
		configure(first)
		configure(second)
		payload := batchsettlement.BatchSettlePayload{
			Type:     batchsettlement.PayloadTypeSettle,
			Channels: []batchsettlement.BatchSettleChannel{{ChannelID: channelID, ChannelConfig: channelConfig}},
		}
		var firstResp, secondResp *x402.SettleResponse
		var firstErr, secondErr error
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			firstResp, firstErr = first.settleDistributions(context.Background(), payload, requirements)
		}()
		go func() {
			defer wg.Done()
			secondResp, secondErr = second.settleDistributions(context.Background(), payload, requirements)
		}()
		wg.Wait()
		require.NoError(t, firstErr)
		require.NoError(t, secondErr)
		require.Equal(t, firstResp, secondResp)
		require.Equal(t, int32(1), confirmedCalls.Load())
	})

	t.Run("does not delete a successor transaction when an older completion finishes late", func(t *testing.T) {
		store := NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), "key", "successor"))
		scheme := newScheme(t, confirming(t, 0, nil), store, nil)
		configure(scheme)
		incomplete, err := scheme.completeOrPending(context.Background(), "key", tx, network, payer.PublicKey().String())
		require.NoError(t, err)
		require.Nil(t, incomplete)
		got, ok, err := store.Get(context.Background(), "key")
		require.NoError(t, err)
		require.True(t, ok)
		require.Equal(t, "successor", got)
	})

	t.Run("recovers the actual payout after a lost response and restart without changing the request", func(t *testing.T) {
		payload := batchsettlement.BatchSettlePayload{
			Type:     batchsettlement.PayloadTypeSettle,
			Channels: []batchsettlement.BatchSettleChannel{{ChannelID: channelID, ChannelConfig: channelConfig}},
		}
		key := "batch:distribute:" + network + ":" + mint + ":" + receiver + ":" + channelID
		store := x402.NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), key, tx))
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		firstSigner := &capabilitySigner{
			scriptedSigner: inner,
			confirmed: func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
				return payoutEvidence(t, "200", "1700"), nil
			},
		}
		first := newScheme(t, firstSigner, store, nil)
		configure(first)
		var firstSubmits atomic.Int32
		first.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			firstSubmits.Add(1)
			return durableResult{}, errors.New("should not submit")
		}
		response, err := first.settleDistributions(context.Background(), payload, requirements)
		require.NoError(t, err)
		require.Equal(t, &x402.SettleResponse{
			Amount:      "1500",
			Extra:       map[string]any{"channels": []string{channelID}},
			Network:     x402.Network(network),
			Payer:       "",
			Success:     true,
			Transaction: tx,
		}, response)
		require.Zero(t, firstSubmits.Load())
		_, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		require.False(t, ok)

		restarted := newScheme(t, confirming(t, 0, nil), store, nil)
		configure(restarted)
		var restartedSubmits atomic.Int32
		restarted.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(ch *generated.Channel) {
				ch.Settlement = generated.SettlementWatermarks{PayoutWatermark: 1700, Settled: 1700}
			}), nil
		}
		restarted.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			restartedSubmits.Add(1)
			return durableResult{}, errors.New("should not submit")
		}
		replay, err := restarted.settleDistributions(context.Background(), payload, requirements)
		require.NoError(t, err)
		require.Equal(t, asMap(t, response), asMap(t, replay))
		require.Zero(t, restartedSubmits.Load())

		restarted.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(ch *generated.Channel) {
				ch.Settlement = generated.SettlementWatermarks{PayoutWatermark: 1700, Settled: 2200}
			}), nil
		}
		restarted.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			restartedSubmits.Add(1)
			return durableResult{OK: true, Signature: "second-transaction"}, nil
		}
		innerCaps := newScriptedSigner(t, 1)
		innerCaps.keys[0] = feePayer
		restarted.raw = &capabilitySigner{
			scriptedSigner: innerCaps,
			confirmed: func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
				return payoutEvidence(t, "200", "1000"), nil
			},
		}
		restarted.signer = &recordingSigner{PaymentChannelFacilitatorSigner: restarted.raw, scheme: restarted}
		next, err := restarted.settleDistributions(context.Background(), payload, requirements)
		require.NoError(t, err)
		require.Equal(t, "second-transaction", next.Transaction)
		require.Equal(t, int32(1), restartedSubmits.Load())
	})

	t.Run("waits for transaction metadata instead of estimating payout from a stale snapshot", func(t *testing.T) {
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		var confirmedCalls atomic.Int32
		transport := &capabilitySigner{
			scriptedSigner: inner,
			confirmed: func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
				n := confirmedCalls.Add(1)
				switch n {
				case 1:
					return nil, nil
				case 2:
					return nil, errors.New("RPC catching up")
				default:
					return payoutEvidence(t, "200", "9000"), nil
				}
			},
		}
		scheme := newScheme(t, transport, nil, nil)
		configure(scheme)
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(ch *generated.Channel) {
				ch.Settlement = generated.SettlementWatermarks{PayoutWatermark: 200, Settled: 1000}
			}), nil
		}
		scheme.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			return durableResult{OK: true, Signature: tx}, nil
		}
		scheme.hooks.waitForChannelRead = func(int) error { return nil }
		payload := batchsettlement.BatchSettlePayload{
			Type:     batchsettlement.PayloadTypeSettle,
			Channels: []batchsettlement.BatchSettleChannel{{ChannelID: channelID, ChannelConfig: channelConfig}},
		}
		result, err := scheme.settleDistributions(context.Background(), payload, requirements)
		require.NoError(t, err)
		require.Equal(t, "8800", result.Amount)
		require.Equal(t, int32(3), confirmedCalls.Load())
	})

	t.Run("retains the distribution when recording its payout fails", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
		key := "batch:distribute:" + network + ":" + mint + ":" + receiver + ":" + channelID
		require.NoError(t, store.Set(context.Background(), key, tx))
		var recordCalls atomic.Int32
		record := func(context.Context, *x402.SettleResponse, types.PaymentRequirements) error {
			if recordCalls.Add(1) == 1 {
				return errors.New("ledger unavailable")
			}
			return nil
		}
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		signer := &capabilitySigner{
			scriptedSigner: inner,
			confirmed: func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
				return payoutEvidence(t, "200", "1000"), nil
			},
		}
		scheme := newScheme(t, signer, store, record)
		configure(scheme)
		payload := batchsettlement.BatchSettlePayload{
			Type:     batchsettlement.PayloadTypeSettle,
			Channels: []batchsettlement.BatchSettleChannel{{ChannelID: channelID, ChannelConfig: channelConfig}},
		}
		pending, err := scheme.settleDistributions(context.Background(), payload, requirements)
		require.NoError(t, err)
		require.False(t, pending.Success)
		require.Equal(t, x402.ErrSettlementPending, pending.ErrorReason)
		require.Equal(t, tx, pending.Transaction)
		got, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		require.True(t, ok)
		require.Equal(t, tx, got)

		okResp, err := scheme.settleDistributions(context.Background(), payload, requirements)
		require.NoError(t, err)
		require.True(t, okResp.Success)
		require.Equal(t, tx, okResp.Transaction)
		require.Equal(t, "800", okResp.Amount)
		_, ok, err = store.Get(context.Background(), key)
		require.NoError(t, err)
		require.False(t, ok)
	})

	t.Run("recovers request_close after stale reads and remains replayable after cleanup", func(t *testing.T) {
		payload := batchsettlement.BatchRefundPayload{
			Type:          batchsettlement.PayloadTypeRefund,
			ChannelConfig: channelConfig,
			Transaction:   "signed-close",
			Voucher: &batchsettlement.BatchVoucher{
				ChannelID: channelID, ExpiresAt: 0, MaxClaimableAmount: "1000", Signature: "signature",
			},
		}
		key := "batch:refund:" + network + ":" + channelID + ":signed-close"
		store := x402.NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), key, tx))
		recovering := newScheme(t, confirming(t, 0, nil), store, nil)
		configure(recovering)
		stubPrepareRefund(recovering)
		var recoveryReads atomic.Int32
		recovering.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			if recoveryReads.Add(1) == 1 {
				return channel(nil), nil
			}
			return channel(func(ch *generated.Channel) {
				ch.ClosureStartedAt = 20
				ch.Status = uint8(generated.ChannelStatus_Closing)
			}), nil
		}
		recovering.hooks.waitForChannelRead = func(int) error { return nil }
		response, err := recovering.settleRefund(context.Background(), payload, requirements, nil)
		require.NoError(t, err)
		require.True(t, response.Success)
		require.Equal(t, tx, response.Transaction)
		extra := asMap(t, response.Extra)
		state := asMap(t, extra["channelState"])
		require.EqualValues(t, 20, state["withdrawRequestedAt"])
		require.Equal(t, int32(2), recoveryReads.Load())

		completedReplay := newScheme(t, confirming(t, 0, nil), store, nil)
		configure(completedReplay)
		stubPrepareRefund(completedReplay)
		var completedReads atomic.Int32
		completedReplay.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			if completedReads.Add(1) == 1 {
				return channel(nil), nil
			}
			return channel(func(ch *generated.Channel) {
				ch.ClosureStartedAt = 20
				ch.Status = uint8(generated.ChannelStatus_Closing)
			}), nil
		}
		completedReplay.hooks.waitForChannelRead = func(int) error { return nil }
		replay, err := completedReplay.settleRefund(context.Background(), payload, requirements, nil)
		require.NoError(t, err)
		require.True(t, replay.Success)
		require.Equal(t, tx, replay.Transaction)
		require.Equal(t, int32(2), completedReads.Load())

		restarted := newScheme(t, confirming(t, 0, nil), store, nil)
		configure(restarted)
		stubPrepareRefund(restarted)
		restarted.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return nil, nil
		}
		restarted.hooks.waitForChannelRead = func(int) error { return nil }
		final, err := restarted.settleRefund(context.Background(), payload, requirements, nil)
		require.NoError(t, err)
		require.True(t, final.Success)
		require.Equal(t, tx, final.Transaction)
	})

	t.Run("retains exact transaction identity when recovered postconditions are still stale", func(t *testing.T) {
		claim := claimPayload(t, 1000)
		distribute := batchsettlement.BatchSettlePayload{
			Type:     batchsettlement.PayloadTypeSettle,
			Channels: []batchsettlement.BatchSettleChannel{{ChannelID: channelID, ChannelConfig: channelConfig}},
		}
		refund := batchsettlement.BatchRefundPayload{
			Type:          batchsettlement.PayloadTypeRefund,
			ChannelConfig: channelConfig,
			Transaction:   "signed-close",
			Voucher: &batchsettlement.BatchVoucher{
				ChannelID: channelID, ExpiresAt: 0, MaxClaimableAmount: "1000", Signature: "signature",
			},
		}
		store := x402.NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), "batch:claim:"+network+":"+channelID+":1000", tx))
		require.NoError(t, store.Set(context.Background(), "batch:distribute:"+network+":"+mint+":"+receiver+":"+channelID, tx))
		require.NoError(t, store.Set(context.Background(), "batch:refund:"+network+":"+channelID+":signed-close", tx))
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		transport := &capabilitySigner{
			scriptedSigner: inner,
			confirmed: func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
				return nil, nil
			},
		}
		scheme := newScheme(t, transport, store, nil)
		configure(scheme)
		scheme.hooks.waitForChannelRead = func(int) error { return nil }
		scheme.hooks.reconcileBroadcast = func(context.Context, string, string, string, string) (durableResult, error) {
			return durableResult{OK: true, Signature: tx}, nil
		}
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(nil), nil
		}
		stubPrepareRefund(scheme)

		claimResp, err := scheme.settleClaims(context.Background(), claim, requirements)
		require.NoError(t, err)
		require.Equal(t, x402.ErrSettlementPending, claimResp.ErrorReason)
		require.Equal(t, tx, claimResp.Transaction)

		distResp, err := scheme.settleDistributions(context.Background(), distribute, requirements)
		require.NoError(t, err)
		require.Equal(t, x402.ErrSettlementPending, distResp.ErrorReason)
		require.Equal(t, tx, distResp.Transaction)

		refundResp, err := scheme.settleRefund(context.Background(), refund, requirements, nil)
		require.NoError(t, err)
		require.Equal(t, x402.ErrSettlementPending, refundResp.ErrorReason)
		require.Equal(t, tx, refundResp.Transaction)
	})

	t.Run("propagates terminal reconciliation responses for every recovered operation", func(t *testing.T) {
		claim := claimPayload(t, 1000)
		distribute := batchsettlement.BatchSettlePayload{
			Type:     batchsettlement.PayloadTypeSettle,
			Channels: []batchsettlement.BatchSettleChannel{{ChannelID: channelID, ChannelConfig: channelConfig}},
		}
		refund := batchsettlement.BatchRefundPayload{
			Type:          batchsettlement.PayloadTypeRefund,
			ChannelConfig: channelConfig,
			Transaction:   "signed-close",
			Voucher: &batchsettlement.BatchVoucher{
				ChannelID: channelID, ExpiresAt: 0, MaxClaimableAmount: "1000", Signature: "signature",
			},
		}
		store := x402.NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), "batch:claim:"+network+":"+channelID+":1000", tx))
		require.NoError(t, store.Set(context.Background(), "batch:distribute:"+network+":"+mint+":"+receiver+":"+channelID, tx))
		require.NoError(t, store.Set(context.Background(), "batch:refund:"+network+":"+channelID+":signed-close", tx))
		scheme := newScheme(t, confirming(t, 0, nil), store, nil)
		configure(scheme)
		failure := &x402.SettleResponse{
			ErrorReason: "transaction_failed",
			Network:     x402.Network(network),
			Success:     false,
			Transaction: tx,
		}
		scheme.hooks.reconcileBroadcast = func(context.Context, string, string, string, string) (durableResult, error) {
			return durableResult{OK: false, Response: failure}, nil
		}
		stubPrepareRefund(scheme)

		claimResp, err := scheme.settleClaims(context.Background(), claim, requirements)
		require.NoError(t, err)
		require.Equal(t, failure, claimResp)
		distResp, err := scheme.settleDistributions(context.Background(), distribute, requirements)
		require.NoError(t, err)
		require.Equal(t, failure, distResp)
		refundResp, err := scheme.settleRefund(context.Background(), refund, requirements, nil)
		require.NoError(t, err)
		require.Equal(t, failure, refundResp)
	})

	t.Run("handles a concurrent completion race without rebuilding or rebroadcasting", func(t *testing.T) {
		claim := claimPayload(t, 1000)
		distribute := batchsettlement.BatchSettlePayload{
			Type:     batchsettlement.PayloadTypeSettle,
			Channels: []batchsettlement.BatchSettleChannel{{ChannelID: channelID, ChannelConfig: channelConfig}},
		}
		refund := batchsettlement.BatchRefundPayload{
			Type:          batchsettlement.PayloadTypeRefund,
			ChannelConfig: channelConfig,
			Transaction:   "signed-close",
			Voucher: &batchsettlement.BatchVoucher{
				ChannelID: channelID, ExpiresAt: 0, MaxClaimableAmount: "1000", Signature: "signature",
			},
		}
		store := NewInMemoryPendingSettlementStore()
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		transport := &capabilitySigner{
			scriptedSigner: inner,
			confirmed: func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
				return payoutEvidence(t, "200", "1000"), nil
			},
		}
		scheme := newScheme(t, transport, store, nil)
		configure(scheme)
		var fetchCalls atomic.Int32
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			switch fetchCalls.Add(1) {
			case 1:
				return channel(nil), nil
			case 2:
				return channel(func(ch *generated.Channel) {
					ch.Settlement = generated.SettlementWatermarks{Settled: 1_000}
				}), nil
			default:
				return channel(nil), nil
			}
		}
		scheme.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			return durableResult{OK: true, Replayed: true, Signature: tx}, nil
		}
		stubPrepareRefund(scheme)
		require.NoError(t, store.Set(context.Background(), "batch:refund:"+network+":"+channelID+":signed-close"+CompletedBroadcastSuffix, tx))
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return nil, nil
		}
		scheme.hooks.waitForChannelRead = func(int) error { return nil }

		claimResp, err := scheme.settleClaims(context.Background(), claim, requirements)
		require.NoError(t, err)
		require.Equal(t, tx, claimResp.Transaction)

		distResp, err := scheme.settleDistributions(context.Background(), distribute, requirements)
		require.NoError(t, err)
		require.Equal(t, "800", distResp.Amount)
		require.Equal(t, tx, distResp.Transaction)

		refundResp, err := scheme.settleRefund(context.Background(), refund, requirements, nil)
		require.NoError(t, err)
		require.Equal(t, tx, refundResp.Transaction)
	})

	t.Run("returns pending when completion storage fails and bounds postcondition polling", func(t *testing.T) {
		store := &failingPendingStore{
			getErr:    nil,
			setErr:    errors.New("write unavailable"),
			deleteErr: errors.New("delete unavailable"),
		}
		scheme := newScheme(t, confirming(t, 0, nil), store, nil)
		configure(scheme)
		pending, err := scheme.completeOrPending(context.Background(), "key", tx, network, payer.PublicKey().String())
		require.NoError(t, err)
		require.Equal(t, x402.ErrSettlementPending, pending.ErrorReason)
		require.Equal(t, tx, pending.Transaction)
		scheme.forgetPending(context.Background(), "key", tx)

		var waits atomic.Int32
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(nil), nil
		}
		scheme.hooks.waitForChannelRead = func(int) error {
			waits.Add(1)
			return nil
		}
		_, matched, err := scheme.fetchChannelUntil(context.Background(), network, channelID, func(*generated.Channel) bool { return false })
		require.NoError(t, err)
		require.False(t, matched)
		_, matched, err = scheme.fetchChannelsUntil(context.Background(), network, []string{channelID}, func([]*generated.Channel) bool { return false })
		require.NoError(t, err)
		require.False(t, matched)
		require.Equal(t, int32(8), waits.Load())
	})
}

type slotAccountSigner struct {
	*confirmingSigner
	getAccount func(context.Context, solana.PublicKey, string, *rpc.GetAccountInfoOpts) (*rpc.GetAccountInfoResult, error)
}

func (s *slotAccountSigner) GetAccountInfo(ctx context.Context, account solana.PublicKey, network string, opts *rpc.GetAccountInfoOpts) (*rpc.GetAccountInfoResult, error) {
	return s.getAccount(ctx, account, network, opts)
}

type failingPendingStore struct {
	getErr    error
	setErr    error
	deleteErr error
}

func (s *failingPendingStore) Get(context.Context, string) (string, bool, error) {
	return "", false, s.getErr
}

func (s *failingPendingStore) Set(context.Context, string, string) error {
	return s.setErr
}

func (s *failingPendingStore) Delete(context.Context, string) error {
	return s.deleteErr
}
