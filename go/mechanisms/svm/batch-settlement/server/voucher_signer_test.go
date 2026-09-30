package server

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/mr-tron/base58"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	batchclient "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/client"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/types"
)

type emptyProofSigner struct {
	addr solana.PublicKey
}

func (s emptyProofSigner) Address() solana.PublicKey { return s.addr }

func (s emptyProofSigner) SignMessage(context.Context, []byte) ([]byte, error) {
	return []byte{}, nil
}

func (s emptyProofSigner) SignTransaction(context.Context, *solana.Transaction) error {
	return nil
}

func TestBatchServerVoucherSignerBoundaries(t *testing.T) {
	ctx := context.Background()
	payer := newVoucherSigner(t)
	operator := newVoucherSigner(t)
	feePayer := newVoucherSigner(t)
	receiverAuthorizer := newVoucherSigner(t)
	authExpires := time.Now().Unix() + 3_600
	built, err := batchclient.BuildDepositPayload(ctx, batchclient.BuildDepositArgs{
		Blockhash:              solana.MustHashFromBase58(svm.USDCMainnetAddress),
		DepositAmount:          10_000,
		FeePayer:               feePayer.Address().String(),
		FirstCharge:            1_000,
		Mint:                   svm.USDCDevnetAddress,
		OpenSlot:               123,
		Operator:               operator.Address().String(),
		Payer:                  payer,
		Receiver:               svm.USDCMainnetAddress,
		ReceiverAuthorizer:     receiverAuthorizer.Address().String(),
		TokenProgram:           solana.TokenProgramID.String(),
		VoucherSigner:          batchsettlement.VoucherSignerServer,
		WithdrawDelay:          900,
		AuthorizationExpiresAt: &authExpires,
	})
	require.NoError(t, err)
	serverDeposit := built.Payload
	require.NotNil(t, serverDeposit.Authorization)
	serverDepositMap := mustPayloadMap(t, serverDeposit)
	channelID := serverDeposit.Authorization.ChannelID

	requirements := func() types.PaymentRequirements {
		return types.PaymentRequirements{
			Amount: "1000",
			Asset:  svm.USDCDevnetAddress,
			Extra: map[string]any{
				batchsettlement.ExtraFeePayer:           feePayer.Address().String(),
				batchsettlement.ExtraOperator:           operator.Address().String(),
				batchsettlement.ExtraReceiverAuthorizer: receiverAuthorizer.Address().String(),
				batchsettlement.ExtraTokenProgram:       solana.TokenProgramID.String(),
				batchsettlement.ExtraVoucherSigner:      batchsettlement.VoucherSignerServer,
				batchsettlement.ExtraWithdrawDelay:      900,
			},
			MaxTimeoutSeconds: 300,
			Network:           svm.SolanaDevnetCAIP2,
			PayTo:             svm.USDCMainnetAddress,
			Scheme:            batchsettlement.Scheme,
		}
	}
	authorizationFor := func(t *testing.T, requestID string, authorizedAmount uint64) batchsettlement.BatchAuthorization {
		t.Helper()
		auth, err := batchsettlement.SignBatchAuthorization(
			ctx,
			payer,
			channelID,
			operator.Address().String(),
			requestID,
			authorizedAmount,
			time.Now().Unix()+3_600,
		)
		require.NoError(t, err)
		return auth
	}

	t.Run("covers malformed top-level wire guards", func(t *testing.T) {
		require.False(t, batchsettlement.IsBatchVoucher(nil))
		require.False(t, batchsettlement.IsBatchFacilitatorPayload(nil))
		cfg := cloneMap(t, mustPayloadMap(t, serverDeposit.ChannelConfig))
		cfg["receiverAuthorizer"] = 1
		require.False(t, batchsettlement.IsBatchChannelConfig(cfg))
	})

	t.Run("rejects malformed server and client wire combinations", func(t *testing.T) {
		require.True(t, batchsettlement.IsBatchPayload(serverDepositMap))
		clientBuilt, err := batchclient.BuildDepositPayload(ctx, batchclient.BuildDepositArgs{
			Blockhash:          solana.MustHashFromBase58(svm.USDCMainnetAddress),
			DepositAmount:      10_000,
			FeePayer:           feePayer.Address().String(),
			FirstCharge:        1_000,
			Mint:               svm.USDCDevnetAddress,
			OpenSlot:           123,
			Payer:              payer,
			Receiver:           svm.USDCMainnetAddress,
			ReceiverAuthorizer: receiverAuthorizer.Address().String(),
			TokenProgram:       solana.TokenProgramID.String(),
			WithdrawDelay:      900,
		})
		require.NoError(t, err)
		clientDepositMap := mustPayloadMap(t, clientBuilt.Payload)
		require.True(t, batchsettlement.IsBatchPayload(clientDepositMap))

		authMap := cloneMap(t, asMap(t, serverDepositMap["authorization"]))
		depositMap := cloneMap(t, asMap(t, serverDepositMap["deposit"]))
		clientVoucher := asMap(t, clientDepositMap["voucher"])
		clientConfig := asMap(t, clientDepositMap["channelConfig"])

		invalid := []map[string]any{
			withOverride(t, serverDepositMap, map[string]any{"deposit": nil}),
			withOverride(t, serverDepositMap, map[string]any{
				"deposit": withOverride(t, depositMap, map[string]any{"amount": 1}),
			}),
			withOverride(t, serverDepositMap, map[string]any{
				"deposit": withOverride(t, depositMap, map[string]any{"transaction": 1}),
			}),
			withOverride(t, serverDepositMap, map[string]any{"voucher": clientVoucher}),
			withOverride(t, serverDepositMap, map[string]any{"authorization": nil}),
			withOverride(t, serverDepositMap, map[string]any{
				"authorization": withOverride(t, authMap, map[string]any{"type": "other"}),
			}),
			withOverride(t, serverDepositMap, map[string]any{
				"authorization": withOverride(t, authMap, map[string]any{"channelId": 1}),
			}),
			withOverride(t, serverDepositMap, map[string]any{
				"authorization": withOverride(t, authMap, map[string]any{"payer": 1}),
			}),
			withOverride(t, serverDepositMap, map[string]any{
				"authorization": withOverride(t, authMap, map[string]any{"expiresAt": 0}),
			}),
			withOverride(t, serverDepositMap, map[string]any{
				"authorization": withOverride(t, authMap, map[string]any{"signature": 1}),
			}),
			withOverride(t, serverDepositMap, map[string]any{"requestId": ""}),
			withOverride(t, serverDepositMap, map[string]any{"maxClaimableAmount": 1}),
			withOverride(t, clientDepositMap, map[string]any{"authorization": authMap}),
			withOverride(t, clientDepositMap, map[string]any{"requestId": "key"}),
			withOverride(t, clientDepositMap, map[string]any{"maxClaimableAmount": "1000"}),
			{
				"channelConfig": serverDepositMap["channelConfig"],
				"type":          "voucher",
				"voucher":       clientVoucher,
			},
			{
				"authorization":      authMap,
				"channelConfig":      clientConfig,
				"requestId":          "key",
				"maxClaimableAmount": "1000",
				"type":               "authorization",
			},
			{
				"authorization":      nil,
				"channelConfig":      serverDepositMap["channelConfig"],
				"requestId":          "key",
				"maxClaimableAmount": "1000",
				"type":               "authorization",
			},
			{
				"authorization":      authMap,
				"channelConfig":      serverDepositMap["channelConfig"],
				"requestId":          "",
				"maxClaimableAmount": "1000",
				"type":               "authorization",
			},
			{
				"authorization":      authMap,
				"channelConfig":      serverDepositMap["channelConfig"],
				"requestId":          "key",
				"maxClaimableAmount": 1,
				"type":               "authorization",
			},
		}
		for _, payload := range invalid {
			require.False(t, batchsettlement.IsBatchPayload(payload))
		}

		unknownSigner := cloneMap(t, mustPayloadMap(t, serverDeposit.ChannelConfig))
		unknownSigner["voucherSigner"] = "unknown"
		require.False(t, batchsettlement.IsBatchChannelConfig(unknownSigner))
		clientSigner := cloneMap(t, mustPayloadMap(t, serverDeposit.ChannelConfig))
		clientSigner["voucherSigner"] = batchsettlement.VoucherSignerClient
		require.True(t, batchsettlement.IsBatchChannelConfig(clientSigner))
	})

	t.Run("prevents using the wrong credential API for either signer mode", func(t *testing.T) {
		serverTracker := batchclient.NewBatchChannelTracker(channelID, serverDeposit.ChannelConfig, payer, 0)
		_, err := serverTracker.PreviewVoucher(ctx, 1)
		require.Error(t, err)
		require.Regexp(t, "do not use client vouchers", err.Error())

		clientConfig := serverDeposit.ChannelConfig
		clientConfig.PayerAuthorizer = payer.Address().String()
		clientConfig.VoucherSigner = batchsettlement.VoucherSignerClient
		clientTracker := batchclient.NewBatchChannelTracker(channelID, clientConfig, payer, 0)
		_, err = clientTracker.Authorization(ctx, "request", 1, time.Now().Unix()+60)
		require.Error(t, err)
		require.Regexp(t, "do not use server authorization", err.Error())

		_, err = batchclient.BuildDepositPayload(ctx, batchclient.BuildDepositArgs{
			Blockhash:          solana.MustHashFromBase58(svm.USDCMainnetAddress),
			DepositAmount:      10_000,
			FeePayer:           feePayer.Address().String(),
			FirstCharge:        1_000,
			Mint:               svm.USDCDevnetAddress,
			OpenSlot:           123,
			Payer:              payer,
			Receiver:           svm.USDCMainnetAddress,
			ReceiverAuthorizer: receiverAuthorizer.Address().String(),
			TokenProgram:       solana.TokenProgramID.String(),
			VoucherSigner:      batchsettlement.VoucherSignerServer,
			WithdrawDelay:      900,
		})
		require.Error(t, err)
		require.Regexp(t, "operator is required", err.Error())
	})

	t.Run("enforces tracker and deposit-builder boundaries in both modes", func(t *testing.T) {
		clientConfig := serverDeposit.ChannelConfig
		clientConfig.PayerAuthorizer = payer.Address().String()
		clientConfig.VoucherSigner = batchsettlement.VoucherSignerClient
		tracker := batchclient.NewBatchChannelTracker(channelID, clientConfig, payer, 2)
		_, err := tracker.PreviewVoucher(ctx, 0)
		require.Error(t, err)
		require.Regexp(t, "positive", err.Error())
		err = tracker.Commit(1)
		require.Error(t, err)
		require.Regexp(t, "backwards", err.Error())

		_, err = batchclient.SignBatchVoucher(ctx, emptyProofSigner{addr: payer.Address()}, channelID, 3, 0)
		require.Error(t, err)
		require.Regexp(t, "did not return", err.Error())

		base := batchclient.BuildDepositArgs{
			Blockhash:          solana.MustHashFromBase58(svm.USDCMainnetAddress),
			DepositAmount:      10_000,
			FeePayer:           feePayer.Address().String(),
			FirstCharge:        1_000,
			Mint:               svm.USDCDevnetAddress,
			OpenSlot:           123,
			Payer:              payer,
			Receiver:           svm.USDCMainnetAddress,
			ReceiverAuthorizer: receiverAuthorizer.Address().String(),
			TokenProgram:       solana.TokenProgramID.String(),
			WithdrawDelay:      900,
		}
		zero := base
		zero.FirstCharge = 0
		_, err = batchclient.BuildDepositPayload(ctx, zero)
		require.Error(t, err)
		require.Regexp(t, "positive", err.Error())

		over := base
		over.FirstCharge = 10_001
		_, err = batchclient.BuildDepositPayload(ctx, over)
		require.Error(t, err)
		require.Regexp(t, "positive", err.Error())

		unsafeSlot := base
		unsafeSlot.OpenSlot = (1 << 53)
		_, err = batchclient.BuildDepositPayload(ctx, unsafeSlot)
		require.Error(t, err)
		require.Regexp(t, "safe integer", err.Error())

		sameAuthorizer := base
		sameAuthorizer.ReceiverAuthorizer = operator.Address().String()
		resolved, err := batchclient.BuildDepositPayload(ctx, sameAuthorizer)
		require.NoError(t, err)
		require.Equal(t, operator.Address().String(), resolved.Payload.ChannelConfig.ReceiverAuthorizer)
	})

	t.Run("rejects malformed keys and a signer that returns no proof", func(t *testing.T) {
		shortKey := base58.Encode(make([]byte, 31))
		_, err := batchsettlement.EncodeBatchAuthorizationMessage(
			shortKey,
			payer.Address().String(),
			operator.Address().String(),
			"request",
			1_000,
			time.Now().Unix()+60,
		)
		require.Error(t, err)
		require.Regexp(t, "decode to 32 bytes", err.Error())

		_, err = batchsettlement.EncodeBatchAuthorizationMessage(
			channelID,
			payer.Address().String(),
			operator.Address().String(),
			"",
			1_000,
			time.Now().Unix()+60,
		)
		require.Error(t, err)
		require.Regexp(t, "requestId", err.Error())

		_, err = batchsettlement.EncodeBatchAuthorizationMessage(
			channelID,
			payer.Address().String(),
			operator.Address().String(),
			"request",
			1_000,
			0,
		)
		require.Error(t, err)
		require.Regexp(t, "expiresAt", err.Error())

		_, err = batchsettlement.EncodeBatchAuthorizationMessage(
			channelID,
			"not-a-key",
			operator.Address().String(),
			"request",
			1_000,
			time.Now().Unix()+60,
		)
		require.Error(t, err)
		require.Regexp(t, "decode to 32 bytes", err.Error())

		_, err = batchsettlement.SignBatchAuthorization(
			ctx,
			emptyProofSigner{addr: payer.Address()},
			channelID,
			operator.Address().String(),
			"request",
			1_000,
			time.Now().Unix()+60,
		)
		require.Error(t, err)
		require.Regexp(t, "did not return", err.Error())
	})

	t.Run("binds authorization to both the channel and operator", func(t *testing.T) {
		authorization := *serverDeposit.Authorization
		now := time.Now().Unix()
		require.True(t, batchsettlement.VerifyBatchAuthorization(authorization, operator.Address().String(), now))
		require.False(t, batchsettlement.VerifyBatchAuthorization(authorization, feePayer.Address().String(), now))
		expired := authorization
		expired.ExpiresAt = 1
		require.False(t, batchsettlement.VerifyBatchAuthorization(expired, operator.Address().String(), now))
		wrongChannel := authorization
		wrongChannel.ChannelID = feePayer.Address().String()
		require.False(t, batchsettlement.VerifyBatchAuthorization(wrongChannel, operator.Address().String(), now))
	})

	t.Run("rejects every server-mode term and proof mismatch", func(t *testing.T) {
		api := NewBatchSvmScheme(&Config{ReceiverAuthorizer: receiverAuthorizer, Operator: operator})
		req := requirements()
		withExtra := func(extra map[string]any) types.PaymentRequirements {
			out := req
			out.Extra = cloneMap(t, req.Extra)
			for key, value := range extra {
				out.Extra[key] = value
			}
			return out
		}

		_, err := api.validatePayload(serverDepositMap, withExtra(map[string]any{
			batchsettlement.ExtraVoucherSigner: "other",
		}))
		require.Error(t, err)
		require.Equal(t, batchsettlement.ErrChannelState, err.Error())

		clientModeDeposit := cloneMap(t, serverDepositMap)
		clientModeConfig := cloneMap(t, asMap(t, serverDepositMap["channelConfig"]))
		clientModeConfig["voucherSigner"] = batchsettlement.VoucherSignerClient
		clientModeDeposit["channelConfig"] = clientModeConfig
		_, err = api.validatePayload(clientModeDeposit, req)
		require.Error(t, err)
		require.Equal(t, batchsettlement.ErrChannelState, err.Error())

		_, err = api.validatePayload(serverDepositMap, withExtra(map[string]any{
			batchsettlement.ExtraOperator: feePayer.Address().String(),
		}))
		require.Error(t, err)
		require.Equal(t, batchsettlement.ErrChannelState, err.Error())

		undefinedSigner := cloneMap(t, serverDepositMap)
		undefinedConfig := cloneMap(t, asMap(t, serverDepositMap["channelConfig"]))
		delete(undefinedConfig, "voucherSigner")
		undefinedSigner["channelConfig"] = undefinedConfig
		_, err = api.validatePayload(undefinedSigner, withExtra(map[string]any{
			batchsettlement.ExtraOperator:      operator.Address().String(),
			batchsettlement.ExtraVoucherSigner: batchsettlement.VoucherSignerClient,
		}))
		require.Error(t, err)
		require.Equal(t, batchsettlement.ErrChannelState, err.Error())

		depositParsed := batchsettlement.ParsedBatchPayload{
			Type:          batchsettlement.PayloadTypeDeposit,
			ChannelConfig: serverDeposit.ChannelConfig,
			Deposit:       &serverDeposit.Deposit,
		}
		err = api.validateRequestProof(depositParsed, channelID, batchsettlement.VoucherSignerServer, "1000")
		require.Error(t, err)
		require.Equal(t, batchsettlement.ErrVoucherSignature, err.Error())

		clientParsed := batchsettlement.ParsedBatchPayload{
			Type:          batchsettlement.PayloadTypeDeposit,
			ChannelConfig: serverDeposit.ChannelConfig,
			Deposit:       &serverDeposit.Deposit,
		}
		err = api.validateRequestProof(clientParsed, channelID, batchsettlement.VoucherSignerClient, "1000")
		require.Error(t, err)
		require.Equal(t, batchsettlement.ErrVoucherSignature, err.Error())

		authorizationCases := []batchsettlement.BatchAuthorization{
			func() batchsettlement.BatchAuthorization {
				auth := *serverDeposit.Authorization
				auth.ChannelID = feePayer.Address().String()
				return auth
			}(),
			func() batchsettlement.BatchAuthorization {
				auth := *serverDeposit.Authorization
				auth.Payer = feePayer.Address().String()
				return auth
			}(),
			func() batchsettlement.BatchAuthorization {
				auth := *serverDeposit.Authorization
				auth.RequestID = ""
				return auth
			}(),
			func() batchsettlement.BatchAuthorization {
				auth := *serverDeposit.Authorization
				auth.AuthorizedAmount = "999"
				return auth
			}(),
			func() batchsettlement.BatchAuthorization {
				auth := *serverDeposit.Authorization
				auth.Signature = "bad"
				return auth
			}(),
		}
		for _, auth := range authorizationCases {
			authCopy := auth
			parsed := batchsettlement.ParsedBatchPayload{
				Type:          batchsettlement.PayloadTypeDeposit,
				ChannelConfig: serverDeposit.ChannelConfig,
				Authorization: &authCopy,
				Deposit:       &serverDeposit.Deposit,
			}
			err := api.validateRequestProof(parsed, channelID, batchsettlement.VoucherSignerServer, "1000")
			require.Error(t, err)
			require.Equal(t, batchsettlement.ErrVoucherSignature, err.Error())
		}

		unsigned := NewBatchSvmScheme(&Config{ReceiverAuthorizer: receiverAuthorizer})
		_, err = unsigned.signOperatorVoucher(ctx, channelID, 1)
		require.Error(t, err)
		require.Equal(t, batchsettlement.ErrVoucherSignature, err.Error())
	})

	t.Run("opens and advances a server-signed channel through the server hook lifecycle", func(t *testing.T) {
		store := NewMemoryChannelStore()
		operationStore := NewMemoryBatchOperationStore()
		scheme := NewBatchSvmScheme(&Config{
			ReceiverAuthorizer: receiverAuthorizer,
			Operator:           operator,
			OperationStore:     operationStore,
			Store:              store,
		})
		depositBody := mustPayloadMap(t, serverDeposit)
		depositPayment := types.PaymentPayload{
			Accepted:    requirements(),
			Payload:     depositBody,
			X402Version: 2,
		}
		depositCtx := verifyContext(depositPayment, requirements())
		verified, err := scheme.BeforeVerifyHook()(depositCtx)
		require.NoError(t, err)
		require.Nil(t, verified)
		_, err = scheme.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: depositCtx,
			Result:        &x402.VerifyResponse{IsValid: true, Payer: payer.Address().String()},
		})
		require.NoError(t, err)
		require.NoError(t, scheme.AfterSettleHook()(x402.SettleResultContext{
			SettleContext: x402.SettleContext{
				Ctx:          ctx,
				Payload:      depositPayment,
				Requirements: requirements(),
				Phase:        x402.SettlePhaseAfterHandler,
			},
			Result: &x402.SettleResponse{
				Extra: map[string]any{
					"channelState": map[string]any{
						"balance":             "10000",
						"totalClaimed":        "0",
						"withdrawRequestedAt": 0,
					},
				},
				Network:     svm.SolanaDevnetCAIP2,
				Success:     true,
				Transaction: "open-signature",
			},
		}))
		opened, err := store.Get(channelID)
		require.NoError(t, err)
		require.Equal(t, uint64(1_000), opened.ChargedCumulativeAmount)
		require.Equal(t, uint64(1_000), opened.SignedMaxClaimable)

		authBody := mustPayloadMap(t, batchsettlement.BatchAuthorizationPayload{
			Type:          batchsettlement.PayloadTypeAuthorization,
			ChannelConfig: serverDeposit.ChannelConfig,
			Authorization: authorizationFor(t, "request-2", 1_000),
		})
		authorizationPayment := types.PaymentPayload{
			Accepted:    requirements(),
			Payload:     authBody,
			X402Version: 2,
		}
		authorizationCtx := verifyContext(authorizationPayment, requirements())
		authorizationVerified, err := scheme.BeforeVerifyHook()(authorizationCtx)
		require.NoError(t, err)
		require.NotNil(t, authorizationVerified)
		require.True(t, authorizationVerified.Skip)
		require.NotNil(t, authorizationVerified.SkipVerifyResult)
		require.True(t, authorizationVerified.SkipVerifyResult.IsValid)
		_, err = scheme.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: authorizationCtx,
			Result:        authorizationVerified.SkipVerifyResult,
		})
		require.NoError(t, err)
		chargeReq := requirements()
		chargeReq.Amount = "400"
		actualSettlement, err := scheme.BeforeSettleHook()(x402.SettleContext{
			Ctx:          ctx,
			Payload:      authorizationPayment,
			Requirements: chargeReq,
			Phase:        x402.SettlePhaseAfterHandler,
		})
		require.NoError(t, err)
		require.NotNil(t, actualSettlement)
		require.True(t, actualSettlement.Skip)
		require.NotNil(t, actualSettlement.SkipResult)
		require.True(t, actualSettlement.SkipResult.Success)
		require.Equal(t, "400", actualSettlement.SkipResult.Extra["chargedAmount"])
		require.Equal(t, channelID+":1400", actualSettlement.SkipResult.Extra["commitmentId"])
		receipt, ok := actualSettlement.SkipResult.Extra["voucher"].(map[string]any)
		require.True(t, ok)
		signature, _ := receipt["signature"].(string)
		require.NoError(t, paymentchannels.VerifyVoucherSignature(
			signature,
			operator.Address().String(),
			paymentchannels.EncodeVoucherMessage(solana.MustPublicKeyFromBase58(channelID), 1_400, 0),
		))
		advanced, err := store.Get(channelID)
		require.NoError(t, err)
		require.Equal(t, uint64(1_400), advanced.ChargedCumulativeAmount)
		require.Equal(t, uint64(1_400), advanced.SignedMaxClaimable)
		op, err := operationStore.Get(channelID, "request-2")
		require.NoError(t, err)
		require.Equal(t, uint64(400), op.Actual)
		require.Equal(t, uint64(1_400), op.Cumulative)
		require.Equal(t, operationCompleted, op.Status)

		zeroBody := mustPayloadMap(t, batchsettlement.BatchAuthorizationPayload{
			Type:          batchsettlement.PayloadTypeAuthorization,
			ChannelConfig: serverDeposit.ChannelConfig,
			Authorization: authorizationFor(t, "request-3", 1_000),
		})
		zeroPayment := types.PaymentPayload{
			Accepted:    requirements(),
			Payload:     zeroBody,
			X402Version: 2,
		}
		zeroCtx := verifyContext(zeroPayment, requirements())
		zeroVerified, err := scheme.BeforeVerifyHook()(zeroCtx)
		require.NoError(t, err)
		_, err = scheme.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: zeroCtx,
			Result:        zeroVerified.SkipVerifyResult,
		})
		require.NoError(t, err)
		zeroReq := requirements()
		zeroReq.Amount = "0"
		zeroSettled, err := scheme.BeforeSettleHook()(x402.SettleContext{
			Ctx:          ctx,
			Payload:      zeroPayment,
			Requirements: zeroReq,
			Phase:        x402.SettlePhaseAfterHandler,
		})
		require.NoError(t, err)
		require.NotNil(t, zeroSettled)
		require.True(t, zeroSettled.SkipResult.Success)
		require.Equal(t, channelID+":1400", zeroSettled.SkipResult.Extra["commitmentId"])
		unchanged, err := store.Get(channelID)
		require.NoError(t, err)
		require.Equal(t, uint64(1_400), unchanged.ChargedCumulativeAmount)
		op3, err := operationStore.Get(channelID, "request-3")
		require.NoError(t, err)
		require.Equal(t, uint64(0), op3.Actual)
		require.Equal(t, uint64(1_400), op3.Cumulative)
		require.Equal(t, operationCompleted, op3.Status)

		replayCtx := verifyContext(authorizationPayment, requirements())
		replayBefore, err := scheme.BeforeVerifyHook()(replayCtx)
		require.NoError(t, err)
		require.NotNil(t, replayBefore)
		require.True(t, replayBefore.Skip)
		replayVerified, err := scheme.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: replayCtx,
			Result:        &x402.VerifyResponse{IsValid: true, Payer: payer.Address().String()},
		})
		require.NoError(t, err)
		require.NotNil(t, replayVerified)
		require.True(t, replayVerified.Abort)
		require.Equal(t, ChannelBusy, replayVerified.Reason)
	})

	t.Run("reserves concurrent ceilings, completes out of order, and rejects reused ids", func(t *testing.T) {
		store := NewMemoryChannelStore()
		operationStore := NewMemoryBatchOperationStore()
		scheme := NewBatchSvmScheme(&Config{
			ReceiverAuthorizer: receiverAuthorizer,
			Operator:           operator,
			OperationStore:     operationStore,
			Store:              store,
		})
		openPayment := types.PaymentPayload{
			Accepted:    requirements(),
			Payload:     mustPayloadMap(t, serverDeposit),
			X402Version: 2,
		}
		openCtx := verifyContext(openPayment, requirements())
		openVerified, err := scheme.BeforeVerifyHook()(openCtx)
		require.NoError(t, err)
		require.Nil(t, openVerified)
		_, err = scheme.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: openCtx,
			Result:        &x402.VerifyResponse{IsValid: true, Payer: payer.Address().String()},
		})
		require.NoError(t, err)
		require.NoError(t, scheme.AfterSettleHook()(x402.SettleResultContext{
			SettleContext: x402.SettleContext{
				Ctx:          ctx,
				Payload:      openPayment,
				Requirements: requirements(),
				Phase:        x402.SettlePhaseAfterHandler,
			},
			Result: &x402.SettleResponse{
				Extra: map[string]any{
					"channelState": map[string]any{
						"balance":             "10000",
						"totalClaimed":        "0",
						"withdrawRequestedAt": 0,
					},
				},
				Network:     svm.SolanaDevnetCAIP2,
				Success:     true,
				Transaction: "open-signature",
			},
		}))

		ceiling := requirements()
		ceiling.Amount = "4000"
		payment := func(t *testing.T, requestID string, accepted types.PaymentRequirements) types.PaymentPayload {
			t.Helper()
			amount, err := strconv.ParseUint(accepted.Amount, 10, 64)
			require.NoError(t, err)
			return types.PaymentPayload{
				Accepted: accepted,
				Payload: mustPayloadMap(t, batchsettlement.BatchAuthorizationPayload{
					Type:          batchsettlement.PayloadTypeAuthorization,
					ChannelConfig: serverDeposit.ChannelConfig,
					Authorization: authorizationFor(t, requestID, amount),
				}),
				X402Version: 2,
			}
		}
		reserve := func(t *testing.T, value types.PaymentPayload, accepted types.PaymentRequirements) (x402.VerifyContext, *x402.AfterVerifyResult) {
			t.Helper()
			context := verifyContext(value, accepted)
			verified, err := scheme.BeforeVerifyHook()(context)
			require.NoError(t, err)
			require.NotNil(t, verified)
			require.True(t, verified.Skip)
			result, err := scheme.AfterVerifyHook()(x402.VerifyResultContext{
				VerifyContext: context,
				Result:        verified.SkipVerifyResult,
			})
			require.NoError(t, err)
			return context, result
		}

		firstCtx, _ := reserve(t, payment(t, "concurrent-1", ceiling), ceiling)
		secondCtx, _ := reserve(t, payment(t, "concurrent-2", ceiling), ceiling)
		state, err := store.Get(channelID)
		require.NoError(t, err)
		require.Len(t, state.Reservations, 2)

		exhaustedRequirements := requirements()
		exhaustedRequirements.Amount = "2000"
		exhaustedPayment := payment(t, "concurrent-3", exhaustedRequirements)
		_, exhausted := reserve(t, exhaustedPayment, exhaustedRequirements)
		require.NotNil(t, exhausted)
		require.True(t, exhausted.Abort)
		require.Equal(t, batchsettlement.ErrCumulativeExceedsDeposit, exhausted.Reason)

		refundAuth := authorizationFor(t, "refund-close", 0)
		refundPayload, err := batchclient.BuildRefundPayload(ctx, batchclient.BuildRefundArgs{
			Authorization: &refundAuth,
			ChannelConfig: serverDeposit.ChannelConfig,
			ChannelID:     channelID,
			FeePayer:      feePayer.Address().String(),
			Payer:         payer,
		})
		require.NoError(t, err)
		refundPayment := types.PaymentPayload{
			Accepted:    requirements(),
			Payload:     mustPayloadMap(t, refundPayload),
			X402Version: 2,
		}
		refundCtx := verifyContext(refundPayment, requirements())
		refundVerified, err := scheme.BeforeVerifyHook()(refundCtx)
		require.NoError(t, err)
		require.Nil(t, refundVerified)
		refundAfter, err := scheme.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: refundCtx,
			Result: &x402.VerifyResponse{
				Extra: map[string]any{
					"balance":             "10000",
					"channelId":           channelID,
					"totalClaimed":        "0",
					"withdrawRequestedAt": 0,
				},
				IsValid: true,
				Payer:   payer.Address().String(),
			},
		})
		require.NoError(t, err)
		require.NotNil(t, refundAfter)
		require.True(t, refundAfter.Abort)
		require.Equal(t, ChannelBusy, refundAfter.Reason)

		require.NoError(t, scheme.OnVerifiedPaymentCanceledHook()(x402.VerifiedPaymentCanceledContext{
			SettleContext: x402.SettleContext{
				Ctx:          ctx,
				Payload:      firstCtx.Payload,
				Requirements: firstCtx.Requirements,
			},
			Reason:        x402.CancellationReasonHandlerThrew,
			SettledPhases: nil,
		}))
		replacementPayment := payment(t, "concurrent-4", exhaustedRequirements)
		thirdCtx, third := reserve(t, replacementPayment, exhaustedRequirements)
		require.Nil(t, third)

		thirdSettled, err := scheme.BeforeSettleHook()(x402.SettleContext{
			Ctx:     ctx,
			Payload: thirdCtx.Payload,
			Requirements: func() types.PaymentRequirements {
				req := exhaustedRequirements
				req.Amount = "500"
				return req
			}(),
			Phase: x402.SettlePhaseAfterHandler,
		})
		require.NoError(t, err)
		voucher, ok := thirdSettled.SkipResult.Extra["voucher"].(map[string]any)
		require.True(t, ok)
		require.Equal(t, "1500", voucher["maxClaimableAmount"])

		secondSettled, err := scheme.BeforeSettleHook()(x402.SettleContext{
			Ctx:     ctx,
			Payload: secondCtx.Payload,
			Requirements: func() types.PaymentRequirements {
				req := ceiling
				req.Amount = "250"
				return req
			}(),
			Phase: x402.SettlePhaseAfterHandler,
		})
		require.NoError(t, err)
		voucher, ok = secondSettled.SkipResult.Extra["voucher"].(map[string]any)
		require.True(t, ok)
		require.Equal(t, "1750", voucher["maxClaimableAmount"])
		finalState, err := store.Get(channelID)
		require.NoError(t, err)
		require.Equal(t, uint64(1_750), finalState.ChargedCumulativeAmount)
		require.Empty(t, finalState.Reservations)

		_, replay := reserve(t, replacementPayment, exhaustedRequirements)
		require.NotNil(t, replay)
		require.True(t, replay.Abort)
		require.Equal(t, ChannelBusy, replay.Reason)
	})

	t.Run("enriches server-mode refunds with the stored operator voucher", func(t *testing.T) {
		store := NewMemoryChannelStore()
		scheme := NewBatchSvmScheme(&Config{
			Operator:           operator,
			ReceiverAuthorizer: receiverAuthorizer,
			Store:              store,
		})
		salt, err := strconv.ParseUint(serverDeposit.ChannelConfig.Salt, 10, 64)
		require.NoError(t, err)
		require.NoError(t, store.Put(ChannelState{
			ChannelConfig:           serverDeposit.ChannelConfig,
			ChannelID:               channelID,
			ChargedCumulativeAmount: 2_000,
			Deposit:                 10_000,
			FeePayer:                feePayer.Address().String(),
			HighestVoucherExpiresAt: 0,
			HighestVoucherSignature: "stored-operator-sig",
			Mint:                    svm.USDCDevnetAddress,
			OnchainSyncedAt:         time.Now().UnixMilli(),
			OpenSlot:                uint64(serverDeposit.ChannelConfig.OpenSlot),
			Payer:                   payer.Address().String(),
			PayerAuthorizer:         operator.Address().String(),
			PayoutWatermark:         0,
			Receiver:                serverDeposit.ChannelConfig.Receiver,
			Reservations:            map[string]ChannelReservation{},
			Salt:                    salt,
			Settled:                 0,
			SignedMaxClaimable:      2_000,
			Status:                  ChannelStatusOpen,
			TokenProgram:            solana.TokenProgramID.String(),
			WithdrawDelay:           serverDeposit.ChannelConfig.WithdrawDelay,
		}))
		refundAuth := authorizationFor(t, "refund-enrich", 0)
		refund, err := batchclient.BuildRefundPayload(ctx, batchclient.BuildRefundArgs{
			Authorization: &refundAuth,
			ChannelConfig: serverDeposit.ChannelConfig,
			ChannelID:     channelID,
			FeePayer:      feePayer.Address().String(),
			Payer:         payer,
		})
		require.NoError(t, err)
		payment := types.PaymentPayload{
			Accepted:    requirements(),
			Payload:     mustPayloadMap(t, refund),
			X402Version: 2,
		}
		verifyCtx := verifyContext(payment, requirements())
		_, err = scheme.BeforeVerifyHook()(verifyCtx)
		require.NoError(t, err)
		_, err = scheme.AfterVerifyHook()(x402.VerifyResultContext{
			VerifyContext: verifyCtx,
			Result:        &x402.VerifyResponse{IsValid: true, Payer: payer.Address().String()},
		})
		require.NoError(t, err)
		enriched, err := scheme.EnrichSettlementPayload(x402.SettleContext{
			Ctx:          ctx,
			Payload:      payment,
			Requirements: requirements(),
		})
		require.NoError(t, err)
		require.NotNil(t, enriched["closeAuthorization"])
		voucher, ok := enriched["voucher"].(map[string]any)
		require.True(t, ok)
		require.Equal(t, channelID, voucher["channelId"])
		require.Equal(t, "2000", voucher["maxClaimableAmount"])
		require.Equal(t, "stored-operator-sig", voucher["signature"])
	})
}

func newVoucherSigner(t *testing.T) *batchclient.PrivateKeySigner {
	t.Helper()
	key, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	signer, err := batchclient.NewPrivateKeySigner(key.String())
	require.NoError(t, err)
	return signer
}

func mustPayloadMap(t *testing.T, value any) map[string]any {
	t.Helper()
	body, err := batchsettlement.WireMap(value)
	require.NoError(t, err)
	return body
}

func cloneMap(t *testing.T, value map[string]any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(value)
	require.NoError(t, err)
	var out map[string]any
	require.NoError(t, json.Unmarshal(encoded, &out))
	return out
}

func asMap(t *testing.T, value any) map[string]any {
	t.Helper()
	record, ok := value.(map[string]any)
	require.True(t, ok)
	return record
}

func withOverride(t *testing.T, base map[string]any, overrides map[string]any) map[string]any {
	t.Helper()
	out := cloneMap(t, base)
	for key, value := range overrides {
		out[key] = value
	}
	return out
}

func verifyContext(payment types.PaymentPayload, requirements types.PaymentRequirements) x402.VerifyContext {
	return x402.VerifyContext{
		Ctx:                context.Background(),
		Payload:            payment,
		Requirements:       requirements,
		DeclaredExtensions: map[string]any{},
	}
}
