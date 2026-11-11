package facilitator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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
	closeTx, err := solana.NewTransaction(
		[]solana.Instruction{solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.MemoProgramAddress), nil, []byte{1})},
		solana.MustHashFromBase58("11111111111111111111111111111111"),
		solana.TransactionPayer(feePayer.PublicKey()),
	)
	require.NoError(t, err)
	closeWire, err := svm.EncodeTransaction(closeTx)
	require.NoError(t, err)
	closeHash, err := svm.MessageHash(closeTx)
	require.NoError(t, err)
	refundKey := "batch:refund:" + network + ":" + channelID + ":" + closeHash
	stubPrepareRefund := func(scheme *BatchSvmScheme) {
		scheme.hooks.sealDependencies = func() SealDependencies {
			deps := scheme.defaultSealDependencies()
			deps.PrepareRefund = func(context.Context, batchsettlement.BatchRefundPayload, types.PaymentRequirements, RefundLimits, any) (PreparedRefund, error) {
				return PreparedRefund{ChannelID: channelID, RequestClose: closeWire, Terms: terms}, nil
			}
			return deps
		}
	}
	newScheme := func(t *testing.T, signer svm.FacilitatorSvmSigner, store x402.PendingSettlementStore, onDist OnDistributionConfirmed) *BatchSvmScheme {
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
	t.Run("answers a repeated claim from the channel watermark without broadcasting or writing a lifecycle record", func(t *testing.T) {
		payload := claimPayload(t, 1000)
		storage := newActivityRecordingStorage()
		signer := confirming(t, 0, nil)
		scheme := newScheme(t, signer, nil, nil)
		scheme.channelStorage = storage
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
		response, err := scheme.settleClaims(context.Background(), payload, requirements)
		require.NoError(t, err)
		require.True(t, response.Success)
		require.Empty(t, response.Transaction)
		require.Zero(t, storage.activityCalls.Load())
		require.Zero(t, submitCalls.Load())
		require.Empty(t, signer.confirmCalls())
		require.Empty(t, signer.sentTransactions())
	})

	t.Run("rejects a claim whose cumulative amount exceeds the deposit before broadcasting", func(t *testing.T) {
		payload := claimPayload(t, 20_000)
		scheme := newScheme(t, confirming(t, 0, nil), nil, nil)
		configure(scheme)
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(nil), nil
		}
		var submitCalls atomic.Int32
		scheme.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			submitCalls.Add(1)
			return durableResult{}, errors.New("should not submit")
		}
		_, err := scheme.settleClaims(context.Background(), payload, requirements)
		require.ErrorContains(t, err, batchsettlement.ErrCumulativeAmountMismatch)
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

	t.Run("keeps unknown transactions pending and never rebroadcasts", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
		signature := txSig
		key := "batch:claim:" + network + ":" + channelID + ":1000"
		require.NoError(t, store.Set(context.Background(), key, signature.String()))
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
		require.Empty(t, signer.sentTransactions())
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

		restarted := newScheme(t, confirming(t, 0, nil), store, nil)
		configure(restarted)
		var restartedSubmits atomic.Int32
		restarted.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(ch *generated.Channel) {
				ch.Settlement = generated.SettlementWatermarks{Settled: 1_000}
			}), nil
		}
		restarted.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			restartedSubmits.Add(1)
			return durableResult{}, errors.New("should not submit")
		}
		replay, err := restarted.settleClaims(context.Background(), payload, requirements)
		require.NoError(t, err)
		require.True(t, replay.Success)
		require.Empty(t, replay.Transaction)
		require.Zero(t, restartedSubmits.Load())
	})

	t.Run("coalesces distributions across managers sharing the same reference store", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
		key := "batch:distribute:" + network + ":" + channelID + ":0"
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
		for _, scheme := range []*BatchSvmScheme{first, second} {
			scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
				return channel(nil), nil
			}
		}
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
		store := x402.NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), "key", "successor"))
		scheme := newScheme(t, confirming(t, 0, nil), store, nil)
		configure(scheme)
		scheme.forgetPending(context.Background(), "key", tx)
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
		key := "batch:distribute:" + network + ":" + channelID + ":1700"
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
		var recorded atomic.Int32
		record := func(context.Context, *x402.SettleResponse, types.PaymentRequirements) error {
			recorded.Add(1)
			return nil
		}
		first := newScheme(t, firstSigner, store, record)
		configure(first)
		first.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(ch *generated.Channel) {
				ch.Settlement = generated.SettlementWatermarks{Settled: 1700}
			}), nil
		}
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

		require.Equal(t, int32(1), recorded.Load())

		restarted := newScheme(t, confirming(t, 0, nil), store, record)
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
		require.Equal(t, response, replay)
		require.Zero(t, restartedSubmits.Load())
		require.Equal(t, int32(1), recorded.Load(), "a replay must not deliver the payout to the hook again")

		hookless := newScheme(t, confirming(t, 0, nil), x402.NewInMemoryPendingSettlementStore(), nil)
		configure(hookless)
		hookless.hooks.readChannel = restarted.hooks.readChannel
		hookless.hooks.submitRedemption = restarted.hooks.submitRedemption
		answered, err := hookless.settleDistributions(context.Background(), payload, requirements)
		require.NoError(t, err)
		require.False(t, answered.Success)
		require.Equal(t, batchsettlement.ErrCumulativeAmountMismatch, answered.ErrorReason)
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
		key := "batch:distribute:" + network + ":" + channelID + ":0"
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
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(nil), nil
		}
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
		key := refundKey
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

		_, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		require.False(t, ok)

		signer := confirming(t, 0, nil)
		replayed := newScheme(t, signer, store, nil)
		configure(replayed)
		stubPrepareRefund(replayed)
		replayed.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(ch *generated.Channel) {
				ch.ClosureStartedAt = 20
				ch.Status = uint8(generated.ChannelStatus_Closing)
			}), nil
		}
		replay, err := replayed.settleRefund(context.Background(), payload, requirements, nil)
		require.NoError(t, err)
		require.True(t, replay.Success)
		require.Empty(t, signer.sentTransactions())
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
		require.NoError(t, store.Set(context.Background(), "batch:distribute:"+network+":"+channelID+":0", tx))
		require.NoError(t, store.Set(context.Background(), refundKey, tx))
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
		require.NoError(t, store.Set(context.Background(), "batch:distribute:"+network+":"+channelID+":0", tx))
		require.NoError(t, store.Set(context.Background(), refundKey, tx))
		scheme := newScheme(t, confirming(t, 0, nil), store, nil)
		configure(scheme)
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(nil), nil
		}
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

	t.Run("a concurrent duplicate loses the reservation and reconciles the holder's signature without sending", func(t *testing.T) {
		claim := claimPayload(t, 1000)
		signer := confirming(t, 5, nil)
		scheme := newScheme(t, signer, nil, nil)
		configure(scheme)
		var reads atomic.Int32
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			advanced := reads.Add(1) > 1
			return channel(func(ch *generated.Channel) {
				if advanced {
					ch.Settlement = generated.SettlementWatermarks{Settled: 1000}
				}
			}), nil
		}
		key := "batch:claim:" + network + ":" + channelID + ":1000"
		holder, reserved, err := scheme.duplicateStore.Reserve(context.Background(), key, tx, ReservationTTL)
		require.NoError(t, err)
		require.True(t, reserved)
		require.Empty(t, holder)

		response, err := scheme.settleClaims(context.Background(), claim, requirements)
		require.NoError(t, err)
		require.True(t, response.Success)
		require.Equal(t, tx, response.Transaction)
		require.Empty(t, signer.sentTransactions())
		require.Len(t, signer.confirmCalls(), 1)
	})

	t.Run("releases the reservation when the send fails definitively so a retry can broadcast", func(t *testing.T) {
		signer := confirming(t, 0, nil)
		scheme := newScheme(t, signer, nil, nil)
		const key = "batch:claim:test"
		_, err := scheme.broadcastUnchecked(context.Background(), key, network, "", func(onPrepared func(string, string) error) (string, error) {
			require.NoError(t, onPrepared(tx, "wire"))
			return "", errors.New("simulation rejected")
		})
		require.Error(t, err)
		holder, reserved, err := scheme.duplicateStore.Reserve(context.Background(), key, "retry-signature", ReservationTTL)
		require.NoError(t, err)
		require.True(t, reserved)
		require.Empty(t, holder)
	})

	t.Run("keeps the reservation when the confirmation outcome is unknown", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
		scheme := newScheme(t, confirming(t, 0, nil), store, nil)
		const key = "batch:claim:test"
		result, err := scheme.broadcastUnchecked(context.Background(), key, network, "", func(onPrepared func(string, string) error) (string, error) {
			require.NoError(t, onPrepared(tx, "wire"))
			return "", &paymentchannels.SettlementConfirmationTimeoutError{Signature: tx}
		})
		require.NoError(t, err)
		require.NotNil(t, result.Response)
		require.Equal(t, x402.ErrSettlementPending, result.Response.ErrorReason)
		holder, reserved, err := scheme.duplicateStore.Reserve(context.Background(), key, "other", ReservationTTL)
		require.NoError(t, err)
		require.False(t, reserved)
		require.Equal(t, tx, holder)
		got, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		require.True(t, ok)
		require.Equal(t, tx, got)
	})

	t.Run("fails terminally with the signature when the pending record cannot be stored and bounds postcondition polling", func(t *testing.T) {
		store := &failingPendingStore{
			getErr:    nil,
			setErr:    errors.New("write unavailable"),
			deleteErr: errors.New("delete unavailable"),
		}
		scheme := newScheme(t, confirming(t, 0, nil), store, nil)
		configure(scheme)
		result, err := scheme.broadcastUnchecked(context.Background(), "key", network, payer.PublicKey().String(), func(onPrepared func(string, string) error) (string, error) {
			require.NoError(t, onPrepared(tx, "wire"))
			return "", &paymentchannels.SettlementConfirmationTimeoutError{Signature: tx}
		})
		require.NoError(t, err)
		require.NotNil(t, result.Response)
		require.Equal(t, "transaction_failed", result.Response.ErrorReason)
		require.Equal(t, tx, result.Response.Transaction)
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

func TestStoredDistributionExtraShadowsEmbeddedField(t *testing.T) {
	raw := `{"success":true,"transaction":"sig","network":"solana:devnet","amount":"800","payer":"payer","errorReason":"","extensions":{"memo":"keep"},"extra":{"channels":["chan-a"]}}`
	var stored storedDistribution
	require.NoError(t, json.Unmarshal([]byte(raw), &stored))
	require.Equal(t, []string{"chan-a"}, stored.Extra.Channels)
	require.Nil(t, stored.SettleResponse.Extra)
	require.Equal(t, "keep", stored.Extensions["memo"])
	require.Equal(t, "payer", stored.Payer)
	require.Equal(t, "800", stored.Amount)

	response, err := decodeDistributionResult(raw)
	require.NoError(t, err)
	channels, ok := response.Extra["channels"].([]string)
	require.True(t, ok)
	require.Equal(t, []string{"chan-a"}, channels)
	require.Equal(t, "keep", response.Extensions["memo"])
	require.Equal(t, "payer", response.Payer)
	require.Equal(t, "800", response.Amount)

	reloaded, err := decodeDistributionResult(`{"success":false,"errorReason":"payout_attribution_ambiguous","transaction":"sig","network":"solana:devnet","extensions":{"memo":"keep"}}`)
	require.NoError(t, err)
	require.Nil(t, reloaded.Extra)
	require.Equal(t, "payout_attribution_ambiguous", reloaded.ErrorReason)
	require.Equal(t, "keep", reloaded.Extensions["memo"])
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

func TestAmbiguousPayoutAttribution(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	payer := mustKey(t)
	feePayer := mustKey(t)
	payTo := payer.PublicKey().String()
	channelID := svm.USDCMainnetAddress
	mint := solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress)
	tokenProgram := solana.MustPublicKeyFromBase58(svm.TokenProgramAddress)
	recipient, err := paymentchannels.FindATA(payer.PublicKey(), mint, tokenProgram)
	require.NoError(t, err)
	escrow, err := paymentchannels.FindATA(solana.MustPublicKeyFromBase58(channelID), mint, tokenProgram)
	require.NoError(t, err)
	token := func(index int, owner, amount string) svm.FacilitatorTokenBalance {
		return svm.FacilitatorTokenBalance{AccountIndex: index, Mint: svm.USDCDevnetAddress, Owner: owner, UITokenAmount: svm.FacilitatorTokenAmount{Amount: amount}}
	}
	signature := solana.Signature{7}
	const key = "batch:distribute:test"
	requirements := types.PaymentRequirements{
		Amount: "1000", Asset: svm.USDCDevnetAddress, Network: network, PayTo: payTo, Scheme: batchsettlement.Scheme,
	}
	prepared := []PreparedDistribution{{
		ChannelID: channelID,
		ChannelConfig: batchsettlement.BatchChannelConfig{
			Payer: payer.PublicKey().String(), Receiver: svm.USDCMainnetAddress, Token: svm.USDCDevnetAddress,
		},
		FeePayer: feePayer.PublicKey().String(),
		Terms:    BatchTerms{FeePayer: feePayer.PublicKey().String(), TokenProgram: svm.TokenProgramAddress},
	}}

	newScheme := func(t *testing.T, store x402.PendingSettlementStore, hook func(context.Context, *x402.SettleResponse, types.PaymentRequirements) error, post []svm.FacilitatorTokenBalance) *BatchSvmScheme {
		t.Helper()
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		signer := &capabilitySigner{
			scriptedSigner: inner,
			confirmed: func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
				return &svm.FacilitatorConfirmedTransaction{
					Slot:        100,
					AccountKeys: []string{recipient.String(), escrow.String()},
					Meta: &svm.FacilitatorConfirmedMeta{
						PreTokenBalances:  []svm.FacilitatorTokenBalance{token(0, payTo, "100"), token(1, channelID, "9800")},
						PostTokenBalances: post,
					},
				}, nil
			},
		}
		return NewBatchSvmScheme(context.Background(), signer, &Config{
			PendingSettlementStore:  store,
			OnDistributionConfirmed: hook,
		})
	}

	t.Run("answers with its own reason, stores it for the hook user and forgets the pending record", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), key, signature.String()))
		var recorded int
		scheme := newScheme(t, store, func(context.Context, *x402.SettleResponse, types.PaymentRequirements) error {
			recorded++
			return nil
		}, []svm.FacilitatorTokenBalance{token(0, payTo, "9900")})

		response, err := scheme.finishDistribution(context.Background(), key, signature.String(), prepared, requirements)
		require.NoError(t, err)
		require.NotNil(t, response)
		require.Equal(t, batchsettlement.ErrPayoutAttributionAmbiguous, response.ErrorReason)
		require.Equal(t, signature.String(), response.Transaction)
		require.Zero(t, recorded)
		_, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		require.False(t, ok)
		raw, ok, err := store.Get(context.Background(), resultKey(key))
		require.NoError(t, err)
		require.True(t, ok)
		var stored x402.SettleResponse
		require.NoError(t, json.Unmarshal([]byte(raw), &stored))
		require.Equal(t, batchsettlement.ErrPayoutAttributionAmbiguous, stored.ErrorReason)
	})

	t.Run("writes no result record without OnDistributionConfirmed", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), key, signature.String()))
		scheme := newScheme(t, store, nil, []svm.FacilitatorTokenBalance{token(0, payTo, "9900")})

		response, err := scheme.finishDistribution(context.Background(), key, signature.String(), prepared, requirements)
		require.NoError(t, err)
		require.NotNil(t, response)
		require.Equal(t, batchsettlement.ErrPayoutAttributionAmbiguous, response.ErrorReason)
		_, ok, err := store.Get(context.Background(), resultKey(key))
		require.NoError(t, err)
		require.False(t, ok)
	})
}

func TestConfirmationPolling(t *testing.T) {
	t.Run("searches transaction history on the first lookup only", func(t *testing.T) {
		var requests [][]any
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				ID     any    `json:"id"`
				Method string `json:"method"`
				Params []any  `json:"params"`
			}
			require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
			requests = append(requests, body.Params)
			value := any(nil)
			if len(requests) > 1 {
				value = map[string]any{"slot": 7, "confirmationStatus": "confirmed", "err": nil}
			}
			require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      body.ID,
				"result":  map[string]any{"context": map[string]any{"slot": 1}, "value": []any{value}},
			}))
		}))
		defer server.Close()
		signature := solana.Signature{9}
		err := paymentchannels.ConfirmSignature(context.Background(), rpc.New(server.URL), signature, 3*time.Second, true)
		require.NoError(t, err)
		require.Len(t, requests, 2)
		require.Equal(t, []any{[]any{signature.String()}, map[string]any{"searchTransactionHistory": true}}, requests[0])
		require.Equal(t, []any{[]any{signature.String()}}, requests[1])
	})
}
