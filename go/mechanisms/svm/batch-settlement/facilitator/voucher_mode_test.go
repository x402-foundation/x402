package facilitator_test

import (
	"context"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	batchclient "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/client"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/facilitator"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestBatchFacilitatorVoucherMode(t *testing.T) {
	ctx := context.Background()
	payer := newVoucherSigner(t)
	operator := newVoucherSigner(t)
	feePayer := newVoucherSigner(t)
	receiverAuthorizer := newVoucherSigner(t)
	built, err := batchclient.BuildDepositPayload(ctx, batchclient.BuildDepositArgs{
		Payer:              payer,
		Receiver:           svm.USDCMainnetAddress,
		ReceiverAuthorizer: receiverAuthorizer.Address().String(),
		Mint:               svm.USDCDevnetAddress,
		FeePayer:           feePayer.Address().String(),
		TokenProgram:       solana.TokenProgramID.String(),
		Blockhash:          solana.MustHashFromBase58(svm.USDCMainnetAddress),
		OpenSlot:           77,
		DepositAmount:      10_000,
		FirstCharge:        1_000,
		WithdrawDelay:      900,
	})
	require.NoError(t, err)
	channelID := built.ChannelID
	clientConfig := built.Payload.ChannelConfig
	serverConfig := clientConfig
	serverConfig.PayerAuthorizer = operator.Address().String()
	serverConfig.VoucherSigner = batchsettlement.VoucherSignerServer
	now := time.Now().Unix()

	requirements := func(extra map[string]any) types.PaymentRequirements {
		merged := map[string]any{
			batchsettlement.ExtraFeePayer:           feePayer.Address().String(),
			batchsettlement.ExtraReceiverAuthorizer: receiverAuthorizer.Address().String(),
			batchsettlement.ExtraTokenProgram:       solana.TokenProgramID.String(),
			batchsettlement.ExtraWithdrawDelay:      900,
		}
		for key, value := range extra {
			merged[key] = value
		}
		return types.PaymentRequirements{
			Amount:            "1000",
			Asset:             svm.USDCDevnetAddress,
			Extra:             merged,
			MaxTimeoutSeconds: 300,
			Network:           svm.SolanaDevnetCAIP2,
			PayTo:             svm.USDCMainnetAddress,
			Scheme:            batchsettlement.Scheme,
		}
	}

	t.Run("follows channel config when terms are payload-bound", func(t *testing.T) {
		signer, err := facilitator.VoucherSignerFor(clientConfig, map[string]any{}, facilitator.VoucherModePayload)
		require.NoError(t, err)
		require.Equal(t, batchsettlement.VoucherSignerClient, signer)

		signer, err = facilitator.VoucherSignerFor(serverConfig, map[string]any{
			batchsettlement.ExtraOperator: operator.Address().String(),
		}, facilitator.VoucherModePayload)
		require.NoError(t, err)
		require.Equal(t, batchsettlement.VoucherSignerServer, signer)

		_, err = facilitator.VoucherSignerFor(serverConfig, map[string]any{}, facilitator.VoucherModePayload)
		require.ErrorContains(t, err, batchsettlement.ErrChannelState)

		bogus := clientConfig
		bogus.VoucherSigner = "bogus"
		_, err = facilitator.VoucherSignerFor(bogus, map[string]any{}, facilitator.VoucherModePayload)
		require.ErrorContains(t, err, batchsettlement.ErrChannelState)
	})

	t.Run("matches requirements extra to channel config when requirements-bound", func(t *testing.T) {
		signer, err := facilitator.VoucherSignerFor(clientConfig, map[string]any{
			batchsettlement.ExtraVoucherSigner: batchsettlement.VoucherSignerClient,
		}, facilitator.VoucherModeRequirements)
		require.NoError(t, err)
		require.Equal(t, batchsettlement.VoucherSignerClient, signer)

		signer, err = facilitator.VoucherSignerFor(serverConfig, map[string]any{
			batchsettlement.ExtraOperator:      operator.Address().String(),
			batchsettlement.ExtraVoucherSigner: batchsettlement.VoucherSignerServer,
		}, facilitator.VoucherModeRequirements)
		require.NoError(t, err)
		require.Equal(t, batchsettlement.VoucherSignerServer, signer)

		_, err = facilitator.VoucherSignerFor(serverConfig, map[string]any{
			batchsettlement.ExtraOperator:      feePayer.Address().String(),
			batchsettlement.ExtraVoucherSigner: batchsettlement.VoucherSignerServer,
		}, facilitator.VoucherModeRequirements)
		require.ErrorContains(t, err, batchsettlement.ErrChannelState)

		_, err = facilitator.VoucherSignerFor(clientConfig, map[string]any{
			batchsettlement.ExtraOperator:      operator.Address().String(),
			batchsettlement.ExtraVoucherSigner: batchsettlement.VoucherSignerClient,
		}, facilitator.VoucherModeRequirements)
		require.ErrorContains(t, err, batchsettlement.ErrChannelState)

		_, err = facilitator.VoucherSignerFor(serverConfig, map[string]any{
			batchsettlement.ExtraOperator:      operator.Address().String(),
			batchsettlement.ExtraVoucherSigner: batchsettlement.VoucherSignerClient,
		}, facilitator.VoucherModeRequirements)
		require.ErrorContains(t, err, batchsettlement.ErrChannelState)

		_, err = facilitator.VoucherSignerFor(clientConfig, map[string]any{
			batchsettlement.ExtraVoucherSigner: "bogus",
		}, facilitator.VoucherModeRequirements)
		require.ErrorContains(t, err, batchsettlement.ErrChannelState)
	})

	t.Run("accepts a valid server-mode payer proof at verify and settle ceilings", func(t *testing.T) {
		expiresAt := now + 600
		authorization, err := batchsettlement.SignBatchAuthorization(ctx, payer, channelID, operator.Address().String(), "request-1", 1_000, expiresAt)
		require.NoError(t, err)
		deposit := batchsettlement.ParsedBatchPayload{
			Type:          batchsettlement.PayloadTypeDeposit,
			Authorization: &authorization,
			ChannelConfig: serverConfig,
			Deposit:       &batchsettlement.BatchDeposit{Amount: "10000", Transaction: "setup"},
		}
		req := requirements(map[string]any{
			batchsettlement.ExtraOperator:      operator.Address().String(),
			batchsettlement.ExtraVoucherSigner: batchsettlement.VoucherSignerServer,
		})
		require.NoError(t, facilitator.AssertServerModeProof(deposit, channelID, req, facilitator.ProofAmountExact, now))

		lower := req
		lower.Amount = "500"
		require.NoError(t, facilitator.AssertServerModeProof(deposit, channelID, lower, facilitator.ProofAmountCeiling, now))
		require.ErrorContains(t, facilitator.AssertServerModeProof(deposit, channelID, lower, facilitator.ProofAmountExact, now), "invalid payer proof")

		blank := authorization
		blank.RequestID = ""
		require.ErrorContains(t, facilitator.AssertServerModeProof(batchsettlement.ParsedBatchPayload{
			Type:          deposit.Type,
			Authorization: &blank,
			ChannelConfig: serverConfig,
			Deposit:       deposit.Deposit,
		}, channelID, req, facilitator.ProofAmountExact, now), "invalid payer proof")

		missing := deposit
		missing.Authorization = nil
		require.ErrorContains(t, facilitator.AssertServerModeProof(missing, channelID, req, facilitator.ProofAmountExact, now), "payer proof missing")
	})

	t.Run("accepts only a zero-amount authorization for server-mode cooperative refund", func(t *testing.T) {
		expiresAt := now + 600
		closeProof, err := batchsettlement.SignBatchAuthorization(ctx, payer, channelID, operator.Address().String(), "close-1", 0, expiresAt)
		require.NoError(t, err)
		refund := batchsettlement.BatchRefundPayload{
			Type:          batchsettlement.PayloadTypeRefund,
			Authorization: &closeProof,
			ChannelConfig: serverConfig,
		}
		require.NoError(t, facilitator.AssertServerModeRefundProof(refund, channelID, now))

		withVoucher := refund
		withVoucher.Voucher = &batchsettlement.BatchVoucher{
			ChannelID:          channelID,
			ExpiresAt:          0,
			MaxClaimableAmount: "0",
			Signature:          "sig",
		}
		require.ErrorContains(t, facilitator.AssertServerModeRefundProof(withVoucher, channelID, now), "invalid payer proof")

		charged, err := batchsettlement.SignBatchAuthorization(ctx, payer, channelID, operator.Address().String(), "close-2", 1, expiresAt)
		require.NoError(t, err)
		chargedRefund := refund
		chargedRefund.Authorization = &charged
		require.ErrorContains(t, facilitator.AssertServerModeRefundProof(chargedRefund, channelID, now), "invalid payer proof")

		missing := refund
		missing.Authorization = nil
		require.ErrorContains(t, facilitator.AssertServerModeRefundProof(missing, channelID, now), "payer proof missing")
	})

	t.Run("rejects malformed batch authorization message inputs", func(t *testing.T) {
		expiresAt := now + 60
		_, err := batchsettlement.EncodeBatchAuthorizationMessage(channelID, payer.Address().String(), operator.Address().String(), "request", 1_000, 0)
		require.ErrorContains(t, err, "positive safe integer")
		_, err = batchsettlement.EncodeBatchAuthorizationMessage(channelID, payer.Address().String(), operator.Address().String(), "", 1_000, expiresAt)
		require.ErrorContains(t, err, "1 through 256 bytes")
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
