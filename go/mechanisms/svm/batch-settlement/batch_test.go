package batchsettlement_test

import (
	"context"
	"encoding/json"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	batchclient "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/client"
	batchfacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/facilitator"
	batchserver "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/server"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestBatchSettlementSVM(t *testing.T) {
	ctx := context.Background()
	payer := newSigner(t)
	feePayer := newSigner(t)
	authorizer := newSigner(t)
	built := mustDeposit(t, ctx, payer, feePayer, authorizer, 10_000, 1_000)
	req := func(amount string) types.PaymentRequirements {
		if amount == "" {
			amount = "1000"
		}
		return types.PaymentRequirements{
			Scheme:            batchsettlement.Scheme,
			Network:           svm.SolanaDevnetCAIP2,
			Asset:             svm.USDCDevnetAddress,
			Amount:            amount,
			PayTo:             svm.USDCMainnetAddress,
			MaxTimeoutSeconds: 300,
			Extra: map[string]any{
				batchsettlement.ExtraFeePayer:           feePayer.Address().String(),
				batchsettlement.ExtraReceiverAuthorizer: authorizer.Address().String(),
				batchsettlement.ExtraTokenProgram:       solana.TokenProgramID.String(),
				batchsettlement.ExtraWithdrawDelay:      900,
			},
		}
	}
	kind := types.SupportedKind{
		X402Version: 2,
		Scheme:      batchsettlement.Scheme,
		Network:     svm.SolanaDevnetCAIP2,
		Extra:       map[string]any{batchsettlement.ExtraFeePayer: feePayer.Address().String()},
	}

	t.Run("parses stablecoin prices", func(t *testing.T) {
		server := batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer})
		mainnet, err := server.ParsePrice("$0.001", svm.SolanaMainnetCAIP2)
		require.NoError(t, err)
		require.Equal(t, "1000", mainnet.Amount)
		require.Equal(t, svm.USDCMainnetAddress, mainnet.Asset)
		devnet, err := server.ParsePrice("1.00", svm.SolanaDevnetCAIP2)
		require.NoError(t, err)
		require.Equal(t, "1000000", devnet.Amount)
		require.Equal(t, svm.USDCDevnetAddress, devnet.Asset)
	})

	t.Run("publishes the authorization/channel requirements", func(t *testing.T) {
		delay := 1200
		server := batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer, WithdrawDelay: &delay})
		enhanced, err := server.EnhancePaymentRequirements(ctx, req(""), kind, nil)
		require.NoError(t, err)
		require.Equal(t, "channel", server.DefaultAssetTransferMethod())
		flows := server.PaymentFlows()
		require.Equal(t, x402.PaymentFlowAuthorization, flows[server.DefaultAssetTransferMethod()].Default)
		require.Equal(t, feePayer.Address().String(), enhanced.Extra[batchsettlement.ExtraFeePayer])
		require.Equal(t, "10000", enhanced.Extra[batchsettlement.ExtraMinDeposit])
		require.Equal(t, solana.TokenProgramID.String(), enhanced.Extra[batchsettlement.ExtraTokenProgram])
		require.Equal(t, 1200, enhanced.Extra[batchsettlement.ExtraWithdrawDelay])
		_, hasFlow := enhanced.Extra[batchsettlement.ExtraPaymentFlow]
		require.False(t, hasFlow)
	})

	t.Run("publishes route minDeposit overrides and optionally enforces them", func(t *testing.T) {
		route := req("")
		route.Extra = cloneExtra(route.Extra)
		route.Extra[batchsettlement.ExtraMinDeposit] = "$0.02"
		hinted, err := batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer}).EnhancePaymentRequirements(ctx, route, kind, nil)
		require.NoError(t, err)
		require.Equal(t, "20000", hinted.Extra[batchsettlement.ExtraMinDeposit])

		atomic := req("")
		atomic.Extra = cloneExtra(atomic.Extra)
		atomic.Extra[batchsettlement.ExtraMinDeposit] = "500"
		hint, err := batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer}).ResolveMinDepositHint(atomic)
		require.NoError(t, err)
		require.Equal(t, "1000", hint)

		zero := req("")
		zero.Extra = cloneExtra(zero.Extra)
		zero.Extra[batchsettlement.ExtraMinDeposit] = "0"
		_, err = batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer}).ResolveMinDepositHint(zero)
		require.ErrorContains(t, err, "positive")

		wrong := req("")
		wrong.Extra = cloneExtra(wrong.Extra)
		wrong.Extra[batchsettlement.ExtraMinDeposit] = "1 USDT"
		_, err = batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer}).ResolveMinDepositHint(wrong)
		require.ErrorContains(t, err, "currency must match USDC")

		custom := req("")
		custom.Asset = payer.Address().String()
		custom.Extra = cloneExtra(custom.Extra)
		custom.Extra[batchsettlement.ExtraMinDeposit] = "$1"
		_, err = batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer}).ResolveMinDepositHint(custom)
		require.ErrorContains(t, err, "only supported for default assets")

		payment := depositPayment(t, hinted, built)
		plain := batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer})
		result, err := plain.BeforeVerifyHook()(verifyContext(payment, hinted))
		require.NoError(t, err)
		require.Nil(t, result)
		enforced := batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer, EnforceMinDeposit: true})
		result, err = enforced.BeforeVerifyHook()(verifyContext(payment, hinted))
		require.NoError(t, err)
		require.NotNil(t, result)
		require.True(t, result.Abort)
		require.Equal(t, batchsettlement.ErrDepositBelowMinDeposit, result.Reason)
	})

	t.Run("publishes the configured operator voucher signer", func(t *testing.T) {
		operator := newSigner(t)
		server := batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer, Operator: operator})
		enhanced, err := server.EnhancePaymentRequirements(ctx, req(""), kind, nil)
		require.NoError(t, err)
		require.Equal(t, operator.Address().String(), enhanced.Extra[batchsettlement.ExtraOperator])
		require.Equal(t, batchsettlement.VoucherSignerServer, enhanced.Extra[batchsettlement.ExtraVoucherSigner])
	})

	t.Run("lets a route stay client-signed next to a configured operator", func(t *testing.T) {
		operator := newSigner(t)
		server := batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer, Operator: operator})
		clientRoute := req("")
		clientRoute.Extra = cloneExtra(clientRoute.Extra)
		clientRoute.Extra[batchsettlement.ExtraOperator] = "stale"
		clientRoute.Extra[batchsettlement.ExtraVoucherSigner] = batchsettlement.VoucherSignerClient
		clientSigned, err := server.EnhancePaymentRequirements(ctx, clientRoute, kind, nil)
		require.NoError(t, err)
		require.Equal(t, batchsettlement.VoucherSignerClient, clientSigned.Extra[batchsettlement.ExtraVoucherSigner])
		_, hasOperator := clientSigned.Extra[batchsettlement.ExtraOperator]
		require.False(t, hasOperator)
		require.Equal(t, "10000", clientSigned.Extra[batchsettlement.ExtraMinDeposit])

		serverSigned, err := server.EnhancePaymentRequirements(ctx, req(""), kind, nil)
		require.NoError(t, err)
		require.Equal(t, "3000", serverSigned.Extra[batchsettlement.ExtraMinDeposit])
		require.Equal(t, operator.Address().String(), serverSigned.Extra[batchsettlement.ExtraOperator])
		require.Equal(t, batchsettlement.VoucherSignerServer, serverSigned.Extra[batchsettlement.ExtraVoucherSigner])

		plain, err := batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer}).EnhancePaymentRequirements(ctx, req(""), kind, nil)
		require.NoError(t, err)
		require.Equal(t, "10000", plain.Extra[batchsettlement.ExtraMinDeposit])

		serverMode := req("")
		serverMode.Extra = cloneExtra(serverMode.Extra)
		serverMode.Extra[batchsettlement.ExtraVoucherSigner] = batchsettlement.VoucherSignerServer
		_, err = batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer}).EnhancePaymentRequirements(ctx, serverMode, kind, nil)
		require.ErrorContains(t, err, "requires an operator signer")

		other := req("")
		other.Extra = cloneExtra(other.Extra)
		other.Extra[batchsettlement.ExtraVoucherSigner] = "other"
		_, err = server.EnhancePaymentRequirements(ctx, other, kind, nil)
		require.ErrorContains(t, err, `"client" or "server"`)
	})

	t.Run("broadcasts the deposit and commits its voucher only in the post-handler settle", func(t *testing.T) {
		store := batchserver.NewMemoryChannelStore()
		server := batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer, Store: store})
		payment := depositPayment(t, req(""), built)
		requirements := req("")
		before, err := server.BeforeVerifyHook()(verifyContext(payment, requirements))
		require.NoError(t, err)
		require.Nil(t, before)
		_, err = server.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: verifyContext(payment, requirements),
			Result:        &x402.VerifyResponse{IsValid: true, Payer: payer.Address().String()},
		})
		require.NoError(t, err)
		reserved, err := store.Get(built.ChannelID)
		require.NoError(t, err)
		require.NotNil(t, reserved)
		require.Equal(t, uint64(0), reserved.ChargedCumulativeAmount)
		require.Len(t, reserved.Reservations, 1)
		for _, reservation := range reserved.Reservations {
			require.Equal(t, uint64(1000), reservation.Ceiling)
		}

		forwarded, err := server.BeforeSettleHook()(x402.SettleContext{
			Ctx:          ctx,
			Payload:      payment,
			Requirements: requirements,
			Phase:        x402.SettlePhaseAfterHandler,
		})
		require.NoError(t, err)
		require.Nil(t, forwarded)
		require.NoError(t, server.AfterSettleHook()(x402.SettleResultContext{
			SettleContext: x402.SettleContext{
				Ctx:          ctx,
				Payload:      payment,
				Requirements: requirements,
				Phase:        x402.SettlePhaseAfterHandler,
			},
			Result: &x402.SettleResponse{
				Success:     true,
				Transaction: "open-signature",
				Network:     svm.SolanaDevnetCAIP2,
				Extra:       map[string]any{"channelState": map[string]any{"totalClaimed": "0", "withdrawRequestedAt": 0}},
			},
		}))
		saved, err := store.Get(built.ChannelID)
		require.NoError(t, err)
		require.Equal(t, uint64(1000), saved.ChargedCumulativeAmount)
		require.Equal(t, "open-signature", saved.OpenSignature)
		require.Empty(t, saved.Reservations)
		require.Equal(t, uint64(1000), saved.SignedMaxClaimable)
	})

	t.Run("releases a reservation without charging when the handler fails", func(t *testing.T) {
		store := batchserver.NewMemoryChannelStore()
		server := batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer, Store: store})
		payment := depositPayment(t, req(""), built)
		requirements := req("")
		before, err := server.BeforeVerifyHook()(verifyContext(payment, requirements))
		require.NoError(t, err)
		require.Nil(t, before)
		_, err = server.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: verifyContext(payment, requirements),
			Result:        &x402.VerifyResponse{IsValid: true, Payer: payer.Address().String()},
		})
		require.NoError(t, err)
		require.NoError(t, server.OnVerifiedPaymentCanceledHook()(x402.VerifiedPaymentCanceledContext{
			SettleContext: x402.SettleContext{Ctx: ctx, Payload: payment, Requirements: requirements},
			Reason:        x402.CancellationReasonHandlerThrew,
			SettledPhases: []x402.SettlePhase{x402.SettlePhaseBeforeHandler},
		}))
		saved, err := store.Get(built.ChannelID)
		require.NoError(t, err)
		require.Equal(t, uint64(0), saved.ChargedCumulativeAmount)
		require.Empty(t, saved.Reservations)
	})

	t.Run("builds settle and seal with canonical discriminators", func(t *testing.T) {
		voucher, err := batchclient.SignBatchVoucher(ctx, payer, built.ChannelID, 1000, 0)
		require.NoError(t, err)
		channel, err := solana.PublicKeyFromBase58(built.ChannelID)
		require.NoError(t, err)
		instructions, err := paymentchannels.BuildSettleInstructions(paymentchannels.SettleBuildArgs{
			ChannelID: channel,
			Voucher: paymentchannels.SettleVoucher{
				AuthorizedSigner: payer.Address(),
				SignatureBase58:  voucher.Signature,
				CumulativeAmount: 1000,
				ExpiresAt:        0,
			},
		})
		require.NoError(t, err)
		require.Len(t, instructions, 2)
		data, err := instructions[1].Data()
		require.NoError(t, err)
		require.Equal(t, byte(generated.SettleDiscriminator), data[0])
		sealData, err := paymentchannels.BuildSealInstruction(channel).Data()
		require.NoError(t, err)
		require.Equal(t, byte(generated.SealDiscriminator), sealData[0])
	})

	t.Run("advertises one managed fee payer without a paymentFlow override", func(t *testing.T) {
		facilitator := newFacilitator(t, context.Background(), feePayer, nil)
		extra := facilitator.GetExtra(svm.SolanaDevnetCAIP2)
		require.Equal(t, map[string]any{
			batchsettlement.ExtraFeePayer:    feePayer.Address().String(),
			batchsettlement.ExtraMaxIdleSecs: paymentchannels.DefaultMaxIdleSecs,
		}, extra)
		require.Equal(t, []string{feePayer.Address().String()}, facilitator.GetSigners(svm.SolanaDevnetCAIP2))
	})

	t.Run("advertises the configured idle window and omits a disabled one", func(t *testing.T) {
		idle := int64(3600)
		tuned := newFacilitator(t, context.Background(), feePayer, &idle)
		require.Equal(t, int64(3600), tuned.GetExtra(svm.SolanaDevnetCAIP2)[batchsettlement.ExtraMaxIdleSecs])
		disabledIdle := int64(0)
		disabled := newFacilitator(t, context.Background(), feePayer, &disabledIdle)
		require.Equal(t, map[string]any{
			batchsettlement.ExtraFeePayer: feePayer.Address().String(),
		}, disabled.GetExtra(svm.SolanaDevnetCAIP2))
		require.Panics(t, func() {
			negative := int64(-1)
			newFacilitator(t, context.Background(), feePayer, &negative)
		})
	})

	t.Run("copies the facilitator's idle window into the challenge", func(t *testing.T) {
		server := batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer, Store: batchserver.NewMemoryChannelStore()})
		base := req("")
		base.Extra = map[string]any{}
		base.PayTo = feePayer.Address().String()
		enhanced, err := server.EnhancePaymentRequirements(ctx, base, types.SupportedKind{
			X402Version: 2,
			Scheme:      batchsettlement.Scheme,
			Network:     svm.SolanaDevnetCAIP2,
			Extra: map[string]any{
				batchsettlement.ExtraFeePayer:    feePayer.Address().String(),
				batchsettlement.ExtraMaxIdleSecs: 604_800,
			},
		}, nil)
		require.NoError(t, err)
		require.Equal(t, feePayer.Address().String(), enhanced.Extra[batchsettlement.ExtraFeePayer])
		require.Equal(t, 604_800, enhanced.Extra[batchsettlement.ExtraMaxIdleSecs])
	})

	t.Run("rejects vouchers with a nonzero expiry", func(t *testing.T) {
		server := batchserver.NewBatchSvmScheme(&batchserver.Config{ReceiverAuthorizer: authorizer, Store: batchserver.NewMemoryChannelStore()})
		voucher, err := batchclient.SignBatchVoucher(ctx, payer, built.ChannelID, 1000, 86_400)
		require.NoError(t, err)
		body, err := payloadMap(batchsettlement.BatchVoucherPayload{
			Type:          batchsettlement.PayloadTypeVoucher,
			ChannelConfig: built.Payload.ChannelConfig,
			Voucher:       voucher,
		})
		require.NoError(t, err)
		payment := types.PaymentPayload{X402Version: 2, Accepted: req(""), Payload: body}
		result, err := server.BeforeVerifyHook()(verifyContext(payment, req("")))
		require.NoError(t, err)
		require.NotNil(t, result)
		require.True(t, result.Abort)
		require.Equal(t, batchsettlement.ErrVoucherExpiry, result.Reason)
	})

	t.Run("rejects legacy payload shapes before touching RPC", func(t *testing.T) {
		facilitator := newFacilitator(t, ctx, feePayer, nil)
		voucher, err := batchclient.SignBatchVoucher(ctx, payer, built.ChannelID, 1000, 0)
		require.NoError(t, err)
		body, err := payloadMap(voucher)
		require.NoError(t, err)
		body["type"] = "voucher"
		body["channelId"] = built.ChannelID
		result, err := facilitator.Verify(ctx, types.PaymentPayload{X402Version: 2, Accepted: req(""), Payload: body}, req(""), nil)
		require.NoError(t, err)
		require.False(t, result.IsValid)
		require.Equal(t, batchsettlement.ErrPayloadType, result.InvalidReason)
	})

	t.Run("rejects a refund that names an amount: only the full unused escrow returns", func(t *testing.T) {
		facilitator := newFacilitator(t, ctx, feePayer, nil)
		voucher, err := batchclient.SignBatchVoucher(ctx, payer, built.ChannelID, 1000, 0)
		require.NoError(t, err)
		body, err := payloadMap(batchsettlement.BatchRefundPayload{
			Type:          batchsettlement.PayloadTypeRefund,
			ChannelConfig: built.Payload.ChannelConfig,
			Voucher:       &voucher,
		})
		require.NoError(t, err)
		body["amount"] = "500"
		result, err := facilitator.Verify(ctx, types.PaymentPayload{X402Version: 2, Accepted: req(""), Payload: body}, req(""), nil)
		require.NoError(t, err)
		require.False(t, result.IsValid)
		require.Equal(t, batchsettlement.ErrCloseAmountUnsupported, result.InvalidReason)
	})

	t.Run("sums only undistributed settled amounts", func(t *testing.T) {
		total, err := batchfacilitator.CalculateDistributionAmount([]struct{ PayoutWatermark, Settled uint64 }{
			{PayoutWatermark: 1000, Settled: 3000},
			{PayoutWatermark: 500, Settled: 4000},
		})
		require.NoError(t, err)
		require.Equal(t, uint64(5500), total)
		_, err = batchfacilitator.CalculateDistributionAmount([]struct{ PayoutWatermark, Settled uint64 }{
			{PayoutWatermark: 2, Settled: 1},
		})
		require.ErrorContains(t, err, batchsettlement.ErrChannelState)
	})

	t.Run("request-close transaction keeps the sponsor signature slot empty", func(t *testing.T) {
		channel, err := solana.PublicKeyFromBase58(built.ChannelID)
		require.NoError(t, err)
		fee := feePayer.Address()
		hash := solana.MustHashFromBase58(svm.USDCMainnetAddress)
		tx, err := paymentchannels.BuildRequestCloseTransaction(paymentchannels.BuildRequestCloseArgs{
			Payer:     payer.Address(),
			ChannelID: channel,
			FeePayer:  fee,
			Blockhash: hash,
		})
		require.NoError(t, err)
		require.NoError(t, payer.SignTransaction(ctx, tx))
		payerIndex, err := tx.GetAccountIndex(payer.Address())
		require.NoError(t, err)
		feeIndex, err := tx.GetAccountIndex(fee)
		require.NoError(t, err)
		require.False(t, tx.Signatures[payerIndex].IsZero())
		require.True(t, tx.Signatures[feeIndex].IsZero())
	})
}

var signerKeys = map[string]solana.PrivateKey{}

func newSigner(t *testing.T) *batchclient.PrivateKeySigner {
	t.Helper()
	key, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	signer, err := batchclient.NewPrivateKeySigner(key.String())
	require.NoError(t, err)
	signerKeys[signer.Address().String()] = key
	return signer
}

func mustDeposit(t *testing.T, ctx context.Context, payer, feePayer, authorizer *batchclient.PrivateKeySigner, deposit, charge uint64) *batchclient.BuiltDeposit {
	t.Helper()
	salt := uint64(0)
	built, err := batchclient.BuildDepositPayload(ctx, batchclient.BuildDepositArgs{
		Payer:              payer,
		Receiver:           svm.USDCMainnetAddress,
		ReceiverAuthorizer: authorizer.Address().String(),
		Mint:               svm.USDCDevnetAddress,
		FeePayer:           feePayer.Address().String(),
		TokenProgram:       solana.TokenProgramID.String(),
		Blockhash:          solana.MustHashFromBase58(svm.USDCMainnetAddress),
		OpenSlot:           123_456_789,
		DepositAmount:      deposit,
		FirstCharge:        charge,
		WithdrawDelay:      900,
		Salt:               &salt,
	})
	require.NoError(t, err)
	return built
}

func depositPayment(t *testing.T, accepted types.PaymentRequirements, built *batchclient.BuiltDeposit) types.PaymentPayload {
	t.Helper()
	body, err := payloadMap(built.Payload)
	require.NoError(t, err)
	return types.PaymentPayload{X402Version: 2, Accepted: accepted, Payload: body}
}

func payloadMap(value any) (map[string]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var body map[string]any
	if err := json.Unmarshal(encoded, &body); err != nil {
		return nil, err
	}
	return body, nil
}

func verifyContext(payment types.PaymentPayload, requirements types.PaymentRequirements) x402.VerifyContext {
	return x402.VerifyContext{
		Ctx:                context.Background(),
		Payload:            payment,
		Requirements:       requirements,
		DeclaredExtensions: map[string]any{},
	}
}

func cloneExtra(extra map[string]any) map[string]any {
	cloned := map[string]any{}
	for key, value := range extra {
		cloned[key] = value
	}
	return cloned
}

type stubFacilitatorSigner struct {
	key solana.PrivateKey
}

func (s stubFacilitatorSigner) GetAddresses(context.Context, string) []solana.PublicKey {
	return []solana.PublicKey{s.key.PublicKey()}
}
func (s stubFacilitatorSigner) SignTransaction(context.Context, *solana.Transaction, solana.PublicKey, string) error {
	return nil
}
func (s stubFacilitatorSigner) SimulateTransaction(context.Context, *solana.Transaction, string, *svm.FacilitatorSimulateTransactionOptions) error {
	return nil
}
func (s stubFacilitatorSigner) SendTransaction(context.Context, *solana.Transaction, string) (solana.Signature, error) {
	return solana.Signature{}, nil
}
func (s stubFacilitatorSigner) ConfirmTransaction(context.Context, solana.Signature, string) error {
	return nil
}
func (s stubFacilitatorSigner) GetAccountInfo(context.Context, solana.PublicKey, string, *rpc.GetAccountInfoOpts) (*rpc.GetAccountInfoResult, error) {
	return &rpc.GetAccountInfoResult{}, nil
}
func (s stubFacilitatorSigner) GetLatestBlockhash(context.Context, string) (solana.Hash, uint64, error) {
	return solana.Hash{}, 0, nil
}
func (s stubFacilitatorSigner) GetSlot(context.Context, string, rpc.CommitmentType) (uint64, error) {
	return 0, nil
}

func newFacilitator(t *testing.T, ctx context.Context, feePayer *batchclient.PrivateKeySigner, idle *int64) *batchfacilitator.BatchSvmScheme {
	t.Helper()
	key, ok := signerKeys[feePayer.Address().String()]
	require.True(t, ok)
	return batchfacilitator.NewBatchSvmScheme(ctx, stubFacilitatorSigner{key: key}, &batchfacilitator.Config{
		MaxIdleSecs: idle,
	})
}
