package server

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	batchclient "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/client"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	lifecycleMint     = svm.USDCDevnetAddress
	lifecycleReceiver = svm.USDCMainnetAddress
)

type lifecycleFixture struct {
	payer              *batchclient.PrivateKeySigner
	feePayer           *batchclient.PrivateKeySigner
	receiverAuthorizer *batchclient.PrivateKeySigner
	channelID          string
	channelConfig      batchsettlement.BatchChannelConfig
	depositPayload     batchsettlement.BatchDepositPayload
	depositMap         map[string]any
}

func newLifecycleFixture(t *testing.T) *lifecycleFixture {
	t.Helper()
	payer := newLifecycleSigner(t)
	feePayer := newLifecycleSigner(t)
	receiverAuthorizer := newLifecycleSigner(t)
	salt := uint64(0)
	built, err := batchclient.BuildDepositPayload(context.Background(), batchclient.BuildDepositArgs{
		Blockhash:          solana.MustHashFromBase58(lifecycleReceiver),
		DepositAmount:      10_000,
		FeePayer:           feePayer.Address().String(),
		FirstCharge:        1_000,
		Mint:               lifecycleMint,
		OpenSlot:           123,
		Payer:              payer,
		Receiver:           lifecycleReceiver,
		ReceiverAuthorizer: receiverAuthorizer.Address().String(),
		Salt:               &salt,
		TokenProgram:       svm.TokenProgramAddress,
		WithdrawDelay:      900,
	})
	require.NoError(t, err)
	depositMap, err := toWireMap(built.Payload)
	require.NoError(t, err)
	return &lifecycleFixture{
		payer:              payer,
		feePayer:           feePayer,
		receiverAuthorizer: receiverAuthorizer,
		channelID:          built.ChannelID,
		channelConfig:      built.Payload.ChannelConfig,
		depositPayload:     built.Payload,
		depositMap:         depositMap,
	}
}

func newLifecycleSigner(t *testing.T) *batchclient.PrivateKeySigner {
	t.Helper()
	key, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	signer, err := batchclient.NewPrivateKeySigner(key.String())
	require.NoError(t, err)
	return signer
}

func toWireMap(value any) (map[string]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func cloneWireMap(src map[string]any) map[string]any {
	encoded, err := json.Marshal(src)
	if err != nil {
		panic(err)
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil {
		panic(err)
	}
	return out
}

func (f *lifecycleFixture) requirements(overrides ...func(*types.PaymentRequirements)) types.PaymentRequirements {
	req := types.PaymentRequirements{
		Amount:            "1000",
		Asset:             lifecycleMint,
		MaxTimeoutSeconds: 300,
		Network:           svm.SolanaDevnetCAIP2,
		PayTo:             lifecycleReceiver,
		Scheme:            batchsettlement.Scheme,
		Extra: map[string]any{
			batchsettlement.ExtraFeePayer:           f.feePayer.Address().String(),
			batchsettlement.ExtraReceiverAuthorizer: f.receiverAuthorizer.Address().String(),
			batchsettlement.ExtraTokenProgram:       svm.TokenProgramAddress,
			batchsettlement.ExtraWithdrawDelay:      900,
		},
	}
	for _, override := range overrides {
		override(&req)
	}
	return req
}

func (f *lifecycleFixture) state(overrides ...func(*ChannelState)) ChannelState {
	salt, err := paymentchannels.ParseU64(f.channelConfig.Salt, "salt")
	if err != nil {
		panic(err)
	}
	st := ChannelState{
		ChannelConfig:   f.channelConfig,
		ChannelID:       f.channelID,
		Deposit:         10_000,
		FeePayer:        f.feePayer.Address().String(),
		Mint:            lifecycleMint,
		OnchainSyncedAt: time.Now().UnixMilli(),
		OpenSlot:        123,
		Payer:           f.payer.Address().String(),
		PayerAuthorizer: f.payer.Address().String(),
		Receiver:        lifecycleReceiver,
		Salt:            salt,
		Status:          ChannelStatusOpen,
		TokenProgram:    svm.TokenProgramAddress,
		WithdrawDelay:   900,
	}
	for _, override := range overrides {
		override(&st)
	}
	return st
}

func (f *lifecycleFixture) payment(payload map[string]any) types.PaymentPayload {
	return types.PaymentPayload{
		Accepted:    f.requirements(),
		Payload:     payload,
		X402Version: 2,
	}
}

func (f *lifecycleFixture) verifyCtx(payment types.PaymentPayload, req types.PaymentRequirements) x402.VerifyContext {
	return x402.VerifyContext{
		Ctx:                context.Background(),
		DeclaredExtensions: map[string]any{},
		Payload:            payment,
		Requirements:       req,
	}
}

func (f *lifecycleFixture) depositParsed(t *testing.T) batchsettlement.ParsedBatchPayload {
	t.Helper()
	parsed, err := batchsettlement.ParseBatchPayload(f.depositMap)
	require.NoError(t, err)
	return parsed
}

func (f *lifecycleFixture) voucherMap() map[string]any {
	return map[string]any{
		"channelConfig": mustWire(f.channelConfig),
		"type":          batchsettlement.PayloadTypeVoucher,
		"voucher":       mustWire(*f.depositPayload.Voucher),
	}
}

func mustWire(value any) map[string]any {
	out, err := toWireMap(value)
	if err != nil {
		panic(err)
	}
	return out
}

func ptrString(value string) *string { return &value }
func ptrU64(value uint64) *uint64    { return &value }

type errGetStore struct{}

func (errGetStore) Get(string) (*ChannelState, error) {
	return nil, errors.New("validation failed")
}
func (errGetStore) Put(ChannelState) error { return nil }
func (errGetStore) Update(string, func(*ChannelState) (ChannelState, error)) (ChannelState, error) {
	return ChannelState{}, errors.New("validation failed")
}

type recordingFacilitator struct {
	seen []string
}

func (f *recordingFacilitator) Verify(context.Context, []byte, []byte) (*x402.VerifyResponse, error) {
	return nil, nil
}

func (f *recordingFacilitator) Settle(_ context.Context, payloadBytes, _ []byte) (*x402.SettleResponse, error) {
	var payment types.PaymentPayload
	if err := json.Unmarshal(payloadBytes, &payment); err != nil {
		return nil, err
	}
	typ, _ := payment.Payload["type"].(string)
	f.seen = append(f.seen, typ)
	return &x402.SettleResponse{
		Success:     true,
		Transaction: "seal-signature",
		Network:     svm.SolanaDevnetCAIP2,
	}, nil
}

func (f *recordingFacilitator) GetSupported(context.Context) (x402.SupportedResponse, error) {
	return x402.SupportedResponse{}, nil
}

func TestBatchServerLifecycleBoundaries(t *testing.T) {
	f := newLifecycleFixture(t)

	t.Run("rejects unknown payload discriminators and malformed claim entries", func(t *testing.T) {
		require.False(t, batchsettlement.IsBatchPayload(map[string]any{
			"channelConfig": mustWire(f.channelConfig),
			"type":          "unknown",
		}))
		require.False(t, batchsettlement.IsBatchFacilitatorPayload(map[string]any{
			"claims": []any{nil},
			"type":   "claim",
		}))
		require.False(t, batchsettlement.IsBatchFacilitatorPayload(map[string]any{
			"claims": []any{map[string]any{"channelId": 1, "voucher": map[string]any{}}},
			"type":   "claim",
		}))
	})

	t.Run("validates every immutable payload binding", func(t *testing.T) {
		server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer})
		channelID, err := server.validatePayload(f.depositMap, f.requirements())
		require.NoError(t, err)
		require.Equal(t, f.channelID, channelID)

		type invalidCase struct {
			payload map[string]any
			req     types.PaymentRequirements
			reason  string
		}
		baseExtra := f.requirements().Extra
		invalid := []invalidCase{
			{
				payload: f.depositMap,
				req:     f.requirements(func(r *types.PaymentRequirements) { r.Extra = nil }),
				reason:  batchsettlement.ErrPaymentFlow,
			},
			{
				payload: f.depositMap,
				req: f.requirements(func(r *types.PaymentRequirements) {
					r.Extra = cloneWireMap(baseExtra)
					r.Extra[batchsettlement.ExtraPaymentFlow] = "upfront"
				}),
				reason: batchsettlement.ErrPaymentFlow,
			},
			{
				payload: f.depositMap,
				req: f.requirements(func(r *types.PaymentRequirements) {
					r.Extra = cloneWireMap(baseExtra)
					delete(r.Extra, batchsettlement.ExtraFeePayer)
				}),
				reason: batchsettlement.ErrFeePayerMismatch,
			},
			{
				payload: func() map[string]any {
					p := cloneWireMap(f.depositMap)
					cfg := cloneWireMap(p["channelConfig"].(map[string]any))
					cfg["payer"] = f.feePayer.Address().String()
					p["channelConfig"] = cfg
					return p
				}(),
				req:    f.requirements(),
				reason: batchsettlement.ErrFeePayerMismatch,
			},
			{
				payload: func() map[string]any {
					p := cloneWireMap(f.depositMap)
					cfg := cloneWireMap(p["channelConfig"].(map[string]any))
					cfg["payerAuthorizer"] = f.feePayer.Address().String()
					p["channelConfig"] = cfg
					return p
				}(),
				req:    f.requirements(),
				reason: batchsettlement.ErrFeePayerMismatch,
			},
			{
				payload: func() map[string]any {
					p := cloneWireMap(f.depositMap)
					cfg := cloneWireMap(p["channelConfig"].(map[string]any))
					cfg["receiver"] = f.payer.Address().String()
					p["channelConfig"] = cfg
					return p
				}(),
				req:    f.requirements(),
				reason: batchsettlement.ErrChannelState,
			},
			{
				payload: func() map[string]any {
					p := cloneWireMap(f.depositMap)
					cfg := cloneWireMap(p["channelConfig"].(map[string]any))
					cfg["token"] = lifecycleReceiver
					p["channelConfig"] = cfg
					return p
				}(),
				req:    f.requirements(),
				reason: batchsettlement.ErrChannelState,
			},
			{
				payload: func() map[string]any {
					p := cloneWireMap(f.depositMap)
					cfg := cloneWireMap(p["channelConfig"].(map[string]any))
					cfg["withdrawDelay"] = float64(901)
					p["channelConfig"] = cfg
					return p
				}(),
				req:    f.requirements(),
				reason: batchsettlement.ErrWithdrawDelayMismatch,
			},
			{
				payload: func() map[string]any {
					p := cloneWireMap(f.depositMap)
					cfg := cloneWireMap(p["channelConfig"].(map[string]any))
					cfg["receiverAuthorizer"] = f.payer.Address().String()
					p["channelConfig"] = cfg
					return p
				}(),
				req:    f.requirements(),
				reason: batchsettlement.ErrReceiverAuthorizerMismatch,
			},
			{
				payload: f.depositMap,
				req: f.requirements(func(r *types.PaymentRequirements) {
					r.Extra = cloneWireMap(baseExtra)
					r.Extra[batchsettlement.ExtraReceiverAuthorizer] = f.payer.Address().String()
				}),
				reason: batchsettlement.ErrReceiverAuthorizerMismatch,
			},
			{
				payload: f.depositMap,
				req: f.requirements(func(r *types.PaymentRequirements) {
					r.Extra = cloneWireMap(baseExtra)
					r.Extra[batchsettlement.ExtraTokenProgram] = f.payer.Address().String()
				}),
				reason: batchsettlement.ErrTokenProgram,
			},
			{
				payload: func() map[string]any {
					p := cloneWireMap(f.depositMap)
					voucher := cloneWireMap(p["voucher"].(map[string]any))
					voucher["channelId"] = f.payer.Address().String()
					p["voucher"] = voucher
					return p
				}(),
				req:    f.requirements(),
				reason: batchsettlement.ErrChannelIDMismatch,
			},
			{
				payload: func() map[string]any {
					p := cloneWireMap(f.depositMap)
					voucher := cloneWireMap(p["voucher"].(map[string]any))
					voucher["expiresAt"] = float64(1)
					p["voucher"] = voucher
					return p
				}(),
				req:    f.requirements(),
				reason: batchsettlement.ErrVoucherExpiry,
			},
			{
				payload: func() map[string]any {
					p := cloneWireMap(f.depositMap)
					voucher := cloneWireMap(p["voucher"].(map[string]any))
					voucher["maxClaimableAmount"] = "1001"
					p["voucher"] = voucher
					return p
				}(),
				req:    f.requirements(),
				reason: batchsettlement.ErrVoucherSignature,
			},
		}
		for _, tc := range invalid {
			_, err := server.validatePayload(tc.payload, tc.req)
			require.ErrorContains(t, err, tc.reason)
		}
	})

	t.Run("accepts and rejects verified snapshot boundaries", func(t *testing.T) {
		require.True(t, applySnapshot(f.channelID, VerifiedChannelState{
			ChannelID:           ptrString(f.channelID),
			Balance:             ptrU64(10_000),
			TotalClaimed:        1_000,
			WithdrawRequestedAt: 0,
		}))
		require.False(t, applySnapshot(f.channelID, VerifiedChannelState{
			ChannelID:           ptrString(f.payer.Address().String()),
			TotalClaimed:        0,
			WithdrawRequestedAt: 0,
		}))
		require.False(t, applySnapshot(f.channelID, VerifiedChannelState{
			TotalClaimed:        0,
			WithdrawRequestedAt: 1,
		}))
		require.False(t, applySnapshot(f.channelID, VerifiedChannelState{
			Balance:             ptrU64(1),
			TotalClaimed:        2,
			WithdrawRequestedAt: 0,
		}))
		require.True(t, applySnapshot(f.channelID, VerifiedChannelState{
			TotalClaimed:        2,
			WithdrawRequestedAt: 0,
		}))
	})

	t.Run("creates provisional/recovered records and merges snapshots monotonically", func(t *testing.T) {
		store := NewMemoryChannelStore()
		server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer, Store: store})
		parsed := f.depositParsed(t)
		recovered, err := recoveredState(parsed, f.requirements(), f.channelID, VerifiedChannelState{
			TotalClaimed:        2_000,
			WithdrawRequestedAt: 0,
		})
		require.NoError(t, err)
		require.Equal(t, uint64(0), recovered.Deposit)
		require.Equal(t, uint64(2_000), recovered.Settled)
		require.Equal(t, uint64(2_000), recovered.SignedMaxClaimable)

		provisional, err := provisionalState(parsed, f.requirements(), f.channelID)
		require.NoError(t, err)
		require.Equal(t, uint64(10_000), provisional.Deposit)
		require.Equal(t, uint64(0), provisional.Settled)

		_, err = provisionalState(batchsettlement.ParsedBatchPayload{
			Type:          batchsettlement.PayloadTypeRefund,
			ChannelConfig: f.channelConfig,
			Voucher:       f.depositPayload.Voucher,
		}, f.requirements(), f.channelID)
		require.ErrorContains(t, err, batchsettlement.ErrChannelState)

		require.NoError(t, store.Put(f.state(func(st *ChannelState) {
			st.ChargedCumulativeAmount = 3_000
			st.Deposit = 10_000
			st.Settled = 2_000
		})))
		require.NoError(t, server.persistSnapshot(f.channelID, parsed, f.requirements(), VerifiedChannelState{
			Balance:             ptrU64(12_000),
			TotalClaimed:        4_000,
			WithdrawRequestedAt: 20,
		}))
		stored, err := store.Get(f.channelID)
		require.NoError(t, err)
		require.Equal(t, uint64(4_000), stored.ChargedCumulativeAmount)
		require.Equal(t, int64(20), stored.CloseRequestedAt)
		require.Equal(t, uint64(12_000), stored.Deposit)
		require.Equal(t, uint64(4_000), stored.Settled)
		require.Equal(t, uint64(4_000), stored.SignedMaxClaimable)
		require.Equal(t, ChannelStatusClosing, stored.Status)

		require.NoError(t, server.persistSnapshot(f.channelID, parsed, f.requirements(), VerifiedChannelState{
			Balance:             ptrU64(1),
			TotalClaimed:        1,
			WithdrawRequestedAt: 0,
		}))
		stored, err = store.Get(f.channelID)
		require.NoError(t, err)
		require.Equal(t, uint64(12_000), stored.Deposit)
		require.Equal(t, uint64(4_000), stored.Settled)
	})

	t.Run("rejects a stored channel with different immutable configuration", func(t *testing.T) {
		server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer})
		st := f.state()
		require.NoError(t, server.assertStoredConfig(&st, f.channelConfig, f.requirements()))
		bad := f.channelConfig
		bad.Salt = "1"
		require.ErrorContains(t, server.assertStoredConfig(&st, bad, f.requirements()), batchsettlement.ErrChannelState)
	})

	t.Run("covers hook no-op and missing-reservation paths", func(t *testing.T) {
		server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer})
		payment := f.payment(f.depositMap)
		other := f.payment(map[string]any{"type": "other"})
		before, err := server.BeforeVerifyHook()(f.verifyCtx(other, f.requirements()))
		require.NoError(t, err)
		require.Nil(t, before)

		after, err := server.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: f.verifyCtx(payment, f.requirements()),
			Result:        &x402.VerifyResponse{IsValid: false, Payer: f.payer.Address().String()},
		})
		require.NoError(t, err)
		require.Nil(t, after)

		settleBefore, err := server.BeforeSettleHook()(x402.SettleContext{
			Ctx:                context.Background(),
			DeclaredExtensions: map[string]any{},
			Payload:            payment,
			Phase:              x402.SettlePhaseBeforeHandler,
			Requirements:       f.requirements(),
		})
		require.NoError(t, err)
		require.NotNil(t, settleBefore)
		require.True(t, settleBefore.Abort)
		require.Equal(t, ChannelBusy, settleBefore.Reason)

		require.NoError(t, server.AfterSettleHook()(x402.SettleResultContext{
			SettleContext: x402.SettleContext{
				Ctx:                context.Background(),
				DeclaredExtensions: map[string]any{},
				Payload:            payment,
				Phase:              x402.SettlePhaseAfterHandler,
				Requirements:       f.requirements(),
			},
			Result: &x402.SettleResponse{
				Network:     svm.SolanaDevnetCAIP2,
				Success:     false,
				Transaction: "",
			},
		}))
	})

	t.Run("only enriches a validated cumulative mismatch with stored proof", func(t *testing.T) {
		store := NewMemoryChannelStore()
		server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer, Store: store})
		payment := f.payment(f.depositMap)
		enrich := func(overrides func(*x402.PaymentRequiredContext)) []types.PaymentRequirements {
			reqs := []types.PaymentRequirements{f.requirements()}
			ctx := x402.PaymentRequiredContext{
				Error:          batchsettlement.ErrCumulativeAmountMismatch,
				PaymentPayload: &payment,
				Requirements:   reqs,
			}
			if overrides != nil {
				overrides(&ctx)
			}
			server.EnrichPaymentRequiredResponse(ctx)
			return ctx.Requirements
		}

		reqs := enrich(func(ctx *x402.PaymentRequiredContext) { ctx.Error = "other" })
		require.Nil(t, reqs[0].Extra[batchsettlement.ExtraChannelState])
		reqs = enrich(func(ctx *x402.PaymentRequiredContext) { ctx.PaymentPayload = nil })
		require.Nil(t, reqs[0].Extra[batchsettlement.ExtraChannelState])
		reqs = enrich(func(ctx *x402.PaymentRequiredContext) {
			bad := f.payment(map[string]any{"nope": true})
			ctx.PaymentPayload = &bad
		})
		require.Nil(t, reqs[0].Extra[batchsettlement.ExtraChannelState])
		reqs = enrich(nil)
		require.Nil(t, reqs[0].Extra[batchsettlement.ExtraChannelState])

		require.NoError(t, store.Put(f.state()))
		reqs = enrich(func(ctx *x402.PaymentRequiredContext) {
			ctx.Requirements = []types.PaymentRequirements{f.requirements(func(r *types.PaymentRequirements) {
				r.Scheme = "exact"
			})}
		})
		require.Nil(t, reqs[0].Extra[batchsettlement.ExtraChannelState])

		reqs = enrich(nil)
		channelState, ok := reqs[0].Extra[batchsettlement.ExtraChannelState].(map[string]any)
		require.True(t, ok)
		require.Equal(t, "0", channelState["chargedCumulativeAmount"])
		require.Equal(t, f.channelID, channelState["channelId"])
		_, hasVoucher := reqs[0].Extra[batchsettlement.ExtraVoucherState]
		require.False(t, hasVoucher)

		require.NoError(t, store.Put(f.state(func(st *ChannelState) {
			st.HighestVoucherExpiresAt = 0
			st.HighestVoucherSignature = f.depositPayload.Voucher.Signature
			st.SignedMaxClaimable = 1_000
		})))
		reqs = enrich(nil)
		voucherState, ok := reqs[0].Extra[batchsettlement.ExtraVoucherState].(map[string]any)
		require.True(t, ok)
		require.Equal(t, "1000", voucherState["signedMaxClaimable"])

		require.NoError(t, store.Put(f.state(func(st *ChannelState) {
			st.CloseRequestedAt = 20
			st.HighestVoucherExpiresAt = 0
			st.HighestVoucherSignature = f.depositPayload.Voucher.Signature
			st.SignedMaxClaimable = 1_000
		})))
		reqs = enrich(nil)
		channelState, ok = reqs[0].Extra[batchsettlement.ExtraChannelState].(map[string]any)
		require.True(t, ok)
		require.Equal(t, int64(20), channelState["withdrawRequestedAt"])
		voucherState, ok = reqs[0].Extra[batchsettlement.ExtraVoucherState].(map[string]any)
		require.True(t, ok)
		require.Equal(t, int64(0), voucherState["expiresAt"])
	})

	t.Run("handles unknown channels and rejects unusable facilitator snapshots", func(t *testing.T) {
		store := NewMemoryChannelStore()
		server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer, Store: store})
		voucherPayload := f.voucherMap()
		payment := f.payment(voucherPayload)
		verifyContext := f.verifyCtx(payment, f.requirements())
		before, err := server.BeforeVerifyHook()(verifyContext)
		require.NoError(t, err)
		require.Nil(t, before)
		after, err := server.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: verifyContext,
			Result: &x402.VerifyResponse{
				Extra: map[string]any{
					"balance":             "1",
					"channelId":           f.channelID,
					"totalClaimed":        "2",
					"withdrawRequestedAt": 0,
				},
				IsValid: true,
				Payer:   f.payer.Address().String(),
			},
		})
		require.NoError(t, err)
		require.NotNil(t, after)
		require.True(t, after.Abort)
		require.Equal(t, batchsettlement.ErrChannelState, after.Reason)

		second := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer, Store: NewMemoryChannelStore()})
		payment2 := f.payment(cloneWireMap(voucherPayload))
		context2 := f.verifyCtx(payment2, f.requirements())
		_, err = second.BeforeVerifyHook()(context2)
		require.NoError(t, err)
		after, err = second.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: context2,
			Result: &x402.VerifyResponse{
				Extra: map[string]any{
					"balance":             "10000",
					"channelId":           f.channelID,
					"totalClaimed":        "500",
					"withdrawRequestedAt": 0,
				},
				IsValid: true,
				Payer:   f.payer.Address().String(),
			},
		})
		require.NoError(t, err)
		require.NotNil(t, after)
		require.True(t, after.Abort)
		require.Equal(t, batchsettlement.ErrCumulativeAmountMismatch, after.Reason)
	})

	t.Run("rejects an exact replay before the resource handler", func(t *testing.T) {
		replayState := f.state(func(st *ChannelState) {
			st.ChargedCumulativeAmount = 1_000
			st.HighestVoucherSignature = f.depositPayload.Voucher.Signature
			st.SignedMaxClaimable = 1_000
		})
		store := NewMemoryChannelStore()
		require.NoError(t, store.Put(replayState))
		server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer, Store: store})
		payment := f.payment(f.voucherMap())
		before, err := server.BeforeVerifyHook()(f.verifyCtx(payment, f.requirements()))
		require.NoError(t, err)
		require.NotNil(t, before)
		require.True(t, before.Abort)
		require.Equal(t, ChannelBusy, before.Reason)
	})

	t.Run("uses local voucher verification only while the onchain snapshot is fresh", func(t *testing.T) {
		freshStore := NewMemoryChannelStore()
		require.NoError(t, freshStore.Put(f.state()))
		payment := f.payment(f.voucherMap())
		freshContext := f.verifyCtx(payment, f.requirements())
		ttl := int64(1_000)
		before, err := NewBatchSvmScheme(&Config{
			ReceiverAuthorizer: f.receiverAuthorizer,
			OnchainStateTtlMs:  &ttl,
			Store:              freshStore,
		}).BeforeVerifyHook()(freshContext)
		require.NoError(t, err)
		require.NotNil(t, before)
		require.True(t, before.Skip)

		staleStore := NewMemoryChannelStore()
		require.NoError(t, staleStore.Put(f.state(func(st *ChannelState) { st.OnchainSyncedAt = 0 })))
		staleServer := NewBatchSvmScheme(&Config{
			ReceiverAuthorizer: f.receiverAuthorizer,
			OnchainStateTtlMs:  &ttl,
			Store:              staleStore,
		})
		stalePayment := f.payment(cloneWireMap(payment.Payload))
		staleContext := f.verifyCtx(stalePayment, f.requirements())
		before, err = staleServer.BeforeVerifyHook()(staleContext)
		require.NoError(t, err)
		require.Nil(t, before)
		after, err := staleServer.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: staleContext,
			Result:        &x402.VerifyResponse{IsValid: true, Payer: f.payer.Address().String()},
		})
		require.NoError(t, err)
		require.NotNil(t, after)
		require.True(t, after.Abort)
		require.Equal(t, batchsettlement.ErrChannelState, after.Reason)

		beforeRefresh := time.Now().UnixMilli()
		after, err = staleServer.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: staleContext,
			Result: &x402.VerifyResponse{
				Extra: map[string]any{
					"balance":             "10000",
					"channelId":           f.channelID,
					"totalClaimed":        "0",
					"withdrawRequestedAt": 0,
				},
				IsValid: true,
				Payer:   f.payer.Address().String(),
			},
		})
		require.NoError(t, err)
		require.Nil(t, after)
		stored, err := staleStore.Get(f.channelID)
		require.NoError(t, err)
		require.GreaterOrEqual(t, stored.OnchainSyncedAt, beforeRefresh)
	})

	t.Run("rejects busy, closing, and mismatched stored channel reservations", func(t *testing.T) {
		cases := []ChannelState{
			f.state(func(st *ChannelState) {
				st.Reservations = map[string]ChannelReservation{
					"busy": {Ceiling: 1, ExpiresAt: time.Now().UnixMilli() + 10_000, Kind: reservationKindClient},
				}
			}),
			f.state(func(st *ChannelState) { st.Status = ChannelStatusClosing }),
			f.state(func(st *ChannelState) {
				cfg := f.channelConfig
				cfg.Salt = "1"
				st.ChannelConfig = cfg
			}),
		}
		for _, stored := range cases {
			store := NewMemoryChannelStore()
			require.NoError(t, store.Put(stored))
			server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer, Store: store})
			payment := f.payment(cloneWireMap(f.depositMap))
			ctx := f.verifyCtx(payment, f.requirements())
			before, err := server.BeforeVerifyHook()(ctx)
			require.NoError(t, err)
			if stored.ChannelConfig.Salt != f.channelConfig.Salt {
				require.NotNil(t, before)
				require.True(t, before.Abort)
				require.Equal(t, batchsettlement.ErrChannelState, before.Reason)
				continue
			}
			require.Nil(t, before)
			after, err := server.AfterVerifyHook()(x402.VerifyResultContext{
				VerifyContext: ctx,
				Result:        &x402.VerifyResponse{IsValid: true, Payer: f.payer.Address().String()},
			})
			require.NoError(t, err)
			require.NotNil(t, after)
			require.True(t, after.Abort)
		}
	})

	t.Run("covers price parser and requirement configuration branches", func(t *testing.T) {
		server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer})
		parsed, err := server.ParsePrice(x402.AssetAmount{Amount: "1", Asset: lifecycleMint}, svm.SolanaDevnetCAIP2)
		require.NoError(t, err)
		require.Equal(t, x402.AssetAmount{Amount: "1", Asset: lifecycleMint, Extra: map[string]any{}}, parsed)

		_, err = server.ParsePrice(x402.AssetAmount{Amount: "1", Asset: ""}, svm.SolanaDevnetCAIP2)
		require.ErrorContains(t, err, "asset address")

		parsed, err = server.ParsePrice(1, svm.SolanaDevnetCAIP2)
		require.NoError(t, err)
		require.Equal(t, "1000000", parsed.Amount)

		parsed, err = server.ParsePrice("1 USD", svm.SolanaDevnetCAIP2)
		require.NoError(t, err)
		require.Equal(t, lifecycleMint, parsed.Asset)

		_, err = server.ParsePrice("not money", svm.SolanaDevnetCAIP2)
		require.ErrorContains(t, err, "invalid money format")

		custom := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer}).
			RegisterMoneyParser(func(string, x402.Network) (*x402.AssetAmount, error) { return nil, nil }).
			RegisterMoneyParser(func(string, x402.Network) (*x402.AssetAmount, error) {
				return &x402.AssetAmount{Amount: "7", Asset: lifecycleMint}, nil
			})
		parsed, err = custom.ParsePrice("2", svm.SolanaDevnetCAIP2)
		require.NoError(t, err)
		require.Equal(t, x402.AssetAmount{Amount: "7", Asset: lifecycleMint}, parsed)

		enhanced, err := server.EnhancePaymentRequirements(
			context.Background(),
			f.requirements(),
			types.SupportedKind{Network: svm.SolanaDevnetCAIP2, Scheme: batchsettlement.Scheme, X402Version: 2},
			nil,
		)
		require.NoError(t, err)
		require.Equal(t, f.receiverAuthorizer.Address().String(), enhanced.Extra[batchsettlement.ExtraReceiverAuthorizer])
		require.Equal(t, 900, enhanced.Extra[batchsettlement.ExtraWithdrawDelay])

		delay := 2_592_001
		_, err = NewBatchSvmScheme(&Config{
			ReceiverAuthorizer: f.receiverAuthorizer,
			WithdrawDelay:      &delay,
		}).EnhancePaymentRequirements(
			context.Background(),
			f.requirements(),
			types.SupportedKind{Network: svm.SolanaDevnetCAIP2, Scheme: batchsettlement.Scheme, X402Version: 2},
			nil,
		)
		require.ErrorContains(t, err, batchsettlement.ErrWithdrawDelayOutOfRange)
	})

	t.Run("normalizes malformed verify snapshots without trusting their fields", func(t *testing.T) {
		snapshots := []any{
			nil,
			map[string]any(nil),
			map[string]any{"totalClaimed": "bad", "withdrawRequestedAt": 0},
			map[string]any{"balance": "bad", "totalClaimed": "0", "withdrawRequestedAt": 1.5},
			map[string]any{"totalClaimed": "0", "withdrawRequestedAt": "bad"},
		}
		for _, channelState := range snapshots {
			store := NewMemoryChannelStore()
			server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer, Store: store})
			payment := f.payment(cloneWireMap(f.depositMap))
			ctx := f.verifyCtx(payment, f.requirements())
			_, err := server.BeforeVerifyHook()(ctx)
			require.NoError(t, err)
			extra := map[string]any{}
			if channelState != nil {
				if stateMap, ok := channelState.(map[string]any); ok && stateMap != nil {
					extra = stateMap
				}
			}
			var resultExtra map[string]any
			if channelState != nil {
				resultExtra = extra
			}
			result, err := server.AfterVerifyHook()(x402.VerifyResultContext{
				VerifyContext: ctx,
				Result: &x402.VerifyResponse{
					Extra:   resultExtra,
					IsValid: true,
					Payer:   f.payer.Address().String(),
				},
			})
			require.NoError(t, err)
			stateMap, isMap := channelState.(map[string]any)
			snapshotWithoutBalance := isMap && stateMap != nil &&
				func() bool {
					total, ok := stateMap["totalClaimed"].(string)
					if !ok || !batchsettlement.IsDigits(total) {
						return false
					}
					balance, ok := stateMap["balance"].(string)
					return !ok || !batchsettlement.IsDigits(balance)
				}()
			if snapshotWithoutBalance {
				require.NotNil(t, result)
				require.True(t, result.Abort)
				require.Equal(t, batchsettlement.ErrCumulativeExceedsDeposit, result.Reason)
			} else {
				require.Nil(t, result)
			}
			stored, err := store.Get(f.channelID)
			require.NoError(t, err)
			require.NotNil(t, stored)
		}
	})

	t.Run("normalizes settlement snapshots and never lowers a confirmed deposit", func(t *testing.T) {
		responses := []any{
			nil,
			map[string]any(nil),
			map[string]any{"balance": "bad", "totalClaimed": 1, "withdrawRequestedAt": "bad"},
			map[string]any{"balance": "1", "totalClaimed": "0", "withdrawRequestedAt": 0},
			map[string]any{"balance": "12000", "totalClaimed": "0", "withdrawRequestedAt": 0},
		}
		for _, channelState := range responses {
			store := NewMemoryChannelStore()
			server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer, Store: store})
			payment := f.payment(cloneWireMap(f.depositMap))
			ctx := f.verifyCtx(payment, f.requirements())
			before, err := server.BeforeVerifyHook()(ctx)
			require.NoError(t, err)
			require.Nil(t, before)
			_, err = server.AfterVerifyHook()(x402.VerifyResultContext{
				VerifyContext: ctx,
				Result:        &x402.VerifyResponse{IsValid: true, Payer: f.payer.Address().String()},
			})
			require.NoError(t, err)
			var extra map[string]any
			if channelState != nil {
				if stateMap, ok := channelState.(map[string]any); ok && stateMap != nil {
					extra = map[string]any{"channelState": stateMap}
				} else {
					extra = map[string]any{"channelState": nil}
				}
			}
			require.NoError(t, server.AfterSettleHook()(x402.SettleResultContext{
				SettleContext: x402.SettleContext{
					Ctx:          context.Background(),
					Payload:      payment,
					Phase:        x402.SettlePhaseAfterHandler,
					Requirements: f.requirements(),
				},
				Result: &x402.SettleResponse{
					Extra:       extra,
					Network:     svm.SolanaDevnetCAIP2,
					Success:     true,
					Transaction: "signature",
				},
			}))
			stored, err := store.Get(f.channelID)
			require.NoError(t, err)
			want := uint64(10_000)
			if stateMap, ok := channelState.(map[string]any); ok && stateMap != nil && stateMap["balance"] == "12000" {
				want = 12_000
			}
			require.Equal(t, want, stored.Deposit)
		}
	})

	t.Run("commits voucher reservations before settlement and detects replacement", func(t *testing.T) {
		store := NewMemoryChannelStore()
		require.NoError(t, store.Put(f.state()))
		server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer, Store: store})
		payment := f.payment(f.voucherMap())
		ctx := f.verifyCtx(payment, f.requirements())
		_, err := server.BeforeVerifyHook()(ctx)
		require.NoError(t, err)
		_, err = server.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: ctx,
			Result:        &x402.VerifyResponse{IsValid: true, Payer: f.payer.Address().String()},
		})
		require.NoError(t, err)
		beforeSettle, err := server.BeforeSettleHook()(x402.SettleContext{
			Ctx:          context.Background(),
			Payload:      payment,
			Phase:        x402.SettlePhaseBeforeHandler,
			Requirements: f.requirements(),
		})
		require.NoError(t, err)
		require.NotNil(t, beforeSettle)
		require.True(t, beforeSettle.Skip)
		require.NotNil(t, beforeSettle.SkipResult)
		require.True(t, beforeSettle.SkipResult.Success)
		require.Equal(t, f.channelID+":1000", beforeSettle.SkipResult.Extra["commitmentId"])
		stored, err := store.Get(f.channelID)
		require.NoError(t, err)
		require.Equal(t, uint64(1_000), stored.ChargedCumulativeAmount)

		changedStore := NewMemoryChannelStore()
		require.NoError(t, changedStore.Put(f.state()))
		changed := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer, Store: changedStore})
		payment2 := f.payment(cloneWireMap(payment.Payload))
		ctx2 := f.verifyCtx(payment2, f.requirements())
		_, err = changed.BeforeVerifyHook()(ctx2)
		require.NoError(t, err)
		_, err = changed.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: ctx2,
			Result:        &x402.VerifyResponse{IsValid: true, Payer: f.payer.Address().String()},
		})
		require.NoError(t, err)
		_, err = changedStore.Update(f.channelID, func(current *ChannelState) (ChannelState, error) {
			next := *current
			next.Reservations = map[string]ChannelReservation{
				"replacement": {Ceiling: 1, ExpiresAt: time.Now().UnixMilli() + 10_000, Kind: reservationKindClient},
			}
			return next, nil
		})
		require.NoError(t, err)
		beforeSettle, err = changed.BeforeSettleHook()(x402.SettleContext{
			Ctx:          context.Background(),
			Payload:      payment2,
			Phase:        x402.SettlePhaseBeforeHandler,
			Requirements: f.requirements(),
		})
		require.NoError(t, err)
		require.NotNil(t, beforeSettle)
		require.True(t, beforeSettle.Abort)
		require.Equal(t, ChannelBusy, beforeSettle.Reason)
	})

	t.Run("covers corrective validation and hook state edge cases", func(t *testing.T) {
		server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer})
		invalidPayload := cloneWireMap(f.depositMap)
		voucher := cloneWireMap(invalidPayload["voucher"].(map[string]any))
		voucher["maxClaimableAmount"] = "1001"
		invalidPayload["voucher"] = voucher
		invalidPayment := f.payment(invalidPayload)
		reqs := []types.PaymentRequirements{f.requirements()}
		server.EnrichPaymentRequiredResponse(x402.PaymentRequiredContext{
			Error:          batchsettlement.ErrCumulativeAmountMismatch,
			PaymentPayload: &invalidPayment,
			Requirements:   reqs,
		})
		require.Nil(t, reqs[0].Extra[batchsettlement.ExtraChannelState])

		thrown := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer, Store: errGetStore{}})
		before, err := thrown.BeforeVerifyHook()(f.verifyCtx(f.payment(f.depositMap), f.requirements()))
		require.NoError(t, err)
		require.NotNil(t, before)
		require.True(t, before.Abort)
		require.Equal(t, "validation failed", before.Message)
		require.Equal(t, "transaction_failed", before.Reason)

		noRequest := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer})
		payment := f.payment(f.depositMap)
		after, err := noRequest.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: f.verifyCtx(payment, f.requirements()),
			Result:        &x402.VerifyResponse{IsValid: true, Payer: f.payer.Address().String()},
		})
		require.NoError(t, err)
		require.NotNil(t, after)
		require.True(t, after.Abort)
		require.Equal(t, batchsettlement.ErrChannelState, after.Reason)
		require.NoError(t, noRequest.AfterSettleHook()(x402.SettleResultContext{
			SettleContext: x402.SettleContext{
				Ctx:          context.Background(),
				Payload:      payment,
				Phase:        x402.SettlePhaseAfterHandler,
				Requirements: f.requirements(),
			},
			Result: &x402.SettleResponse{
				Network:     svm.SolanaDevnetCAIP2,
				Success:     true,
				Transaction: "sig",
			},
		}))
		_, err = noRequest.OnSettleFailureHook()(x402.SettleFailureContext{
			SettleContext: x402.SettleContext{
				Ctx:                context.Background(),
				DeclaredExtensions: map[string]any{},
				Payload:            payment,
				Phase:              x402.SettlePhaseAfterHandler,
				Requirements:       f.requirements(),
			},
			Error: errors.New("handler"),
		})
		require.NoError(t, err)
	})

	t.Run("reserves refunds but never runs them through pre-handler settlement", func(t *testing.T) {
		store := NewMemoryChannelStore()
		require.NoError(t, store.Put(f.state(func(st *ChannelState) {
			st.ChargedCumulativeAmount = 1_000
			st.HighestVoucherSignature = f.depositPayload.Voucher.Signature
			st.SignedMaxClaimable = 1_000
		})))
		server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer, Store: store})
		refund, err := batchclient.BuildRefundPayload(context.Background(), batchclient.BuildRefundArgs{
			ChannelConfig: f.channelConfig,
			ChannelID:     f.channelID,
			FeePayer:      f.feePayer.Address().String(),
			Payer:         f.payer,
			Voucher:       f.depositPayload.Voucher,
		})
		require.NoError(t, err)
		refundMap, err := toWireMap(refund)
		require.NoError(t, err)
		payment := f.payment(refundMap)
		ctx := f.verifyCtx(payment, f.requirements())
		before, err := server.BeforeVerifyHook()(ctx)
		require.NoError(t, err)
		require.Nil(t, before)
		after, err := server.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: ctx,
			Result:        &x402.VerifyResponse{IsValid: true, Payer: f.payer.Address().String()},
		})
		require.NoError(t, err)
		require.NotNil(t, after)
		require.True(t, after.SkipHandler)
		require.NotNil(t, after.Response)
		body, ok := after.Response.Body.(map[string]any)
		require.True(t, ok)
		require.Equal(t, f.channelID, body["channelId"])
		require.Equal(t, "Refund initiated", body["message"])
		beforeSettle, err := server.BeforeSettleHook()(x402.SettleContext{
			Ctx:          context.Background(),
			Payload:      payment,
			Phase:        x402.SettlePhaseBeforeHandler,
			Requirements: f.requirements(),
		})
		require.NoError(t, err)
		require.Nil(t, beforeSettle)

		enriched, err := server.EnrichSettlementPayload(x402.SettleContext{
			Ctx:          context.Background(),
			Payload:      payment,
			Requirements: f.requirements(),
		})
		require.NoError(t, err)
		require.Contains(t, enriched, "closeAuthorization")
		rawAuth, ok := enriched["closeAuthorization"].(map[string]any)
		require.True(t, ok)
		var closeAuth batchsettlement.CloseAuthorization
		encoded, err := json.Marshal(rawAuth)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(encoded, &closeAuth))
		require.True(t, batchsettlement.VerifyCloseAuthorization(
			closeAuth,
			batchsettlement.CloseAuthorizationBinding{
				ChannelID:          f.channelID,
				FeePayer:           f.feePayer.Address().String(),
				MaxClaimableAmount: batchsettlement.BigU64(1_000),
				Network:            svm.SolanaDevnetCAIP2,
				VoucherExpiresAt:   f.depositPayload.Voucher.ExpiresAt,
			},
			f.receiverAuthorizer.Address().String(),
			300,
			time.Now().Unix(),
		))
	})

	t.Run("closes a cooperative refund at once and seals a fallback refund on the next pass", func(t *testing.T) {
		refund := func(t *testing.T, withdrawRequestedAt int64) (*BatchSvmScheme, *MemoryChannelStore) {
			t.Helper()
			store := NewMemoryChannelStore()
			require.NoError(t, store.Put(f.state(func(st *ChannelState) {
				st.ChargedCumulativeAmount = 1_000
				st.HighestVoucherSignature = f.depositPayload.Voucher.Signature
				st.SignedMaxClaimable = 1_000
			})))
			server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer, Store: store})
			payload, err := batchclient.BuildRefundPayload(context.Background(), batchclient.BuildRefundArgs{
				ChannelConfig: f.channelConfig,
				ChannelID:     f.channelID,
				FeePayer:      f.feePayer.Address().String(),
				Payer:         f.payer,
				Voucher:       f.depositPayload.Voucher,
			})
			require.NoError(t, err)
			payloadMap, err := toWireMap(payload)
			require.NoError(t, err)
			payment := f.payment(payloadMap)
			ctx := f.verifyCtx(payment, f.requirements())
			_, err = server.BeforeVerifyHook()(ctx)
			require.NoError(t, err)
			_, err = server.AfterVerifyHook()(x402.VerifyResultContext{
				VerifyContext: ctx,
				Result:        &x402.VerifyResponse{IsValid: true, Payer: f.payer.Address().String()},
			})
			require.NoError(t, err)
			totalClaimed := "0"
			if withdrawRequestedAt == 0 {
				totalClaimed = "1000"
			}
			require.NoError(t, server.AfterSettleHook()(x402.SettleResultContext{
				SettleContext: x402.SettleContext{
					Ctx:          context.Background(),
					Payload:      payment,
					Requirements: f.requirements(),
				},
				Result: &x402.SettleResponse{
					Extra: map[string]any{
						"channelState": map[string]any{
							"balance":             "10000",
							"channelId":           f.channelID,
							"totalClaimed":        totalClaimed,
							"withdrawRequestedAt": withdrawRequestedAt,
						},
					},
					Network:     svm.SolanaDevnetCAIP2,
					Success:     true,
					Transaction: "close-signature",
				},
			}))
			return server, store
		}

		_, cooperativeStore := refund(t, 0)
		cooperative, err := cooperativeStore.Get(f.channelID)
		require.NoError(t, err)
		require.Equal(t, uint64(1_000), cooperative.PayoutWatermark)
		require.Equal(t, uint64(1_000), cooperative.Settled)
		require.Equal(t, ChannelStatusDistributed, cooperative.Status)

		closeRequestedAt := time.Now().Unix()
		fallbackServer, fallbackStore := refund(t, closeRequestedAt)
		fallback, err := fallbackStore.Get(f.channelID)
		require.NoError(t, err)
		require.Equal(t, closeRequestedAt, fallback.CloseRequestedAt)
		require.Equal(t, uint64(0), fallback.Settled)
		require.Equal(t, ChannelStatusClosing, fallback.Status)

		facilitator := &recordingFacilitator{}
		manager, err := fallbackServer.CreateChannelManager(
			facilitator,
			f.requirements(),
			BatchChannelManagerConfig{
				ReadPayoutWatermark: func(context.Context, string) (uint64, bool, error) {
					return 1_000, true, nil
				},
			},
		)
		require.NoError(t, err)
		result, err := manager.Redeem(context.Background())
		require.NoError(t, err)
		require.Equal(t, []string{f.channelID}, result.Sealed)
		require.Equal(t, []string{"seal"}, facilitator.seen)
		sealed, err := fallbackStore.Get(f.channelID)
		require.NoError(t, err)
		require.Equal(t, uint64(1_000), sealed.Settled)
		require.Equal(t, ChannelStatusDistributed, sealed.Status)
	})

	t.Run("marks a channel closing when the facilitator reports channel_closing", func(t *testing.T) {
		var closing []string
		store := NewMemoryChannelStore()
		require.NoError(t, store.Put(f.state(func(st *ChannelState) { st.OnchainSyncedAt = 0 })))
		server := NewBatchSvmScheme(&Config{
			OnChannelClosing:   func(id string) { closing = append(closing, id) },
			ReceiverAuthorizer: f.receiverAuthorizer,
			Store:              store,
		})
		payment := f.payment(f.voucherMap())
		ctx := f.verifyCtx(payment, f.requirements())
		before, err := server.BeforeVerifyHook()(ctx)
		require.NoError(t, err)
		require.Nil(t, before)
		_, err = server.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: ctx,
			Result: &x402.VerifyResponse{
				InvalidReason: batchsettlement.ErrChannelClosing,
				IsValid:       false,
			},
		})
		require.NoError(t, err)
		stored, err := store.Get(f.channelID)
		require.NoError(t, err)
		require.Equal(t, ChannelStatusClosing, stored.Status)
		require.Equal(t, []string{f.channelID}, closing)
	})

	t.Run("refuses a refund voucher that is not the charged cumulative amount", func(t *testing.T) {
		store := NewMemoryChannelStore()
		require.NoError(t, store.Put(f.state(func(st *ChannelState) { st.ChargedCumulativeAmount = 2_000 })))
		server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer, Store: store})
		refund, err := batchclient.BuildRefundPayload(context.Background(), batchclient.BuildRefundArgs{
			ChannelConfig: f.channelConfig,
			ChannelID:     f.channelID,
			FeePayer:      f.feePayer.Address().String(),
			Payer:         f.payer,
			Voucher:       f.depositPayload.Voucher,
		})
		require.NoError(t, err)
		refundMap, err := toWireMap(refund)
		require.NoError(t, err)
		payment := f.payment(refundMap)
		before, err := server.BeforeVerifyHook()(f.verifyCtx(payment, f.requirements()))
		require.NoError(t, err)
		require.NotNil(t, before)
		require.True(t, before.Abort)
		require.Equal(t, batchsettlement.ErrCumulativeAmountMismatch, before.Reason)
	})

	t.Run("refuses a first deposit whose open binds a different receiver authorizer", func(t *testing.T) {
		salt := uint64(0)
		attacker, err := batchclient.BuildDepositPayload(context.Background(), batchclient.BuildDepositArgs{
			Blockhash:          solana.MustHashFromBase58(lifecycleReceiver),
			DepositAmount:      10_000,
			FeePayer:           f.feePayer.Address().String(),
			FirstCharge:        1_000,
			Mint:               lifecycleMint,
			OpenSlot:           123,
			Payer:              f.payer,
			Receiver:           lifecycleReceiver,
			ReceiverAuthorizer: f.payer.Address().String(),
			Salt:               &salt,
			TokenProgram:       svm.TokenProgramAddress,
			WithdrawDelay:      900,
		})
		require.NoError(t, err)
		payload, err := toWireMap(attacker.Payload)
		require.NoError(t, err)
		cfg := cloneWireMap(payload["channelConfig"].(map[string]any))
		cfg["receiverAuthorizer"] = f.receiverAuthorizer.Address().String()
		payload["channelConfig"] = cfg
		server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer})
		before, err := server.BeforeVerifyHook()(f.verifyCtx(f.payment(payload), f.requirements()))
		require.NoError(t, err)
		require.NotNil(t, before)
		require.True(t, before.Abort)
		require.Contains(t, before.Reason, batchsettlement.ErrReceiverAuthorizerMismatch)
	})

	t.Run("rejects an unknown voucher when no verified snapshot creates state", func(t *testing.T) {
		server := NewBatchSvmScheme(&Config{ReceiverAuthorizer: f.receiverAuthorizer})
		payment := f.payment(f.voucherMap())
		ctx := f.verifyCtx(payment, f.requirements())
		_, err := server.BeforeVerifyHook()(ctx)
		require.NoError(t, err)
		after, err := server.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: ctx,
			Result:        &x402.VerifyResponse{IsValid: true, Payer: f.payer.Address().String()},
		})
		require.NoError(t, err)
		require.NotNil(t, after)
		require.True(t, after.Abort)
		require.Equal(t, batchsettlement.ErrChannelState, after.Reason)
	})
}
