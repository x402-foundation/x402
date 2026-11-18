package facilitator

import (
	"context"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

func intPtr(v int) *int { return &v }

func TestResolveFacilitatorTransactionVersion(t *testing.T) {
	assert.Equal(t, DefaultFacilitatorTransactionVersion, resolveFacilitatorTransactionVersion(nil))
	assert.Equal(t, 0, resolveFacilitatorTransactionVersion(intPtr(paymentchannels.FacilitatorTransactionVersion0)))
	assert.Equal(t, 1, resolveFacilitatorTransactionVersion(intPtr(paymentchannels.FacilitatorTransactionVersion1)))
}

func TestInvalidFacilitatorTransactionVersionPanicsAtConstruction(t *testing.T) {
	for _, version := range []int{-1, 2, 3} {
		assert.Panics(t, func() {
			NewBatchSvmScheme(context.Background(), newScriptedSigner(t, 1), &Config{FacilitatorTransactionVersion: intPtr(version)})
		}, "version %d", version)
		assert.Panics(t, func() {
			NewBatchSvmRentCleanupManager(RentCleanupConfig{FacilitatorTransactionVersion: intPtr(version)})
		}, "version %d", version)
	}
}

// Version-1 redemptions (scheme_batch_settlement_svm.md, "Facilitator-built
// transactions and batching capacity").
func TestBatchRedemptionsTransactionV1(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)

	t.Run("advertises the version-1 capacity by default and four when built as version 0", func(t *testing.T) {
		v1 := NewBatchSvmScheme(context.Background(), newScriptedSigner(t, 1), nil).GetExtra(svm.SolanaDevnetCAIP2)
		assert.Equal(t, batchsettlement.V1MaxClaimChannels, v1[batchsettlement.ExtraMaxClaimChannels])
		assert.Equal(t, batchsettlement.V1MaxSettleChannels, v1[batchsettlement.ExtraMaxSettleChannels])

		v0 := NewBatchSvmScheme(context.Background(), newScriptedSigner(t, 1), &Config{FacilitatorTransactionVersion: intPtr(paymentchannels.FacilitatorTransactionVersion0)}).GetExtra(svm.SolanaDevnetCAIP2)
		assert.Equal(t, batchsettlement.DefaultBatchChannels, v0[batchsettlement.ExtraMaxClaimChannels])
		assert.Equal(t, batchsettlement.DefaultBatchChannels, v0[batchsettlement.ExtraMaxSettleChannels])
	})

	claimInstructions := func(t *testing.T, channels int) []solana.Instruction {
		t.Helper()
		var instructions []solana.Instruction
		for i := 0; i < channels; i++ {
			signature := solana.Signature{byte(i + 1)}
			pair, err := paymentchannels.BuildSettleInstructions(paymentchannels.SettleBuildArgs{
				ChannelID: mustKey(t).PublicKey(),
				Voucher: paymentchannels.SettleVoucher{
					AuthorizedSigner: mustKey(t).PublicKey(),
					SignatureBase58:  signature.String(),
					CumulativeAmount: 123_456_789,
				},
			})
			require.NoError(t, err)
			instructions = append(instructions, pair...)
		}
		return instructions
	}

	distributeInstructions := func(t *testing.T, channels int, tokenProgram string, feePayer solana.PublicKey) []solana.Instruction {
		t.Helper()
		// Every channel of a settle request pays the route's payTo at 100%
		// (assertClaimChannel), so the recipient is shared.
		payTo := mustKey(t).PublicKey().String()
		var instructions []solana.Instruction
		for i := 0; i < channels; i++ {
			// Distinct channel and payer per channel.
			instruction, err := paymentchannels.BuildDistributeInstruction(paymentchannels.DistributeInstructionArgs{
				Channel:      mustKey(t).PublicKey(),
				Payer:        mustKey(t).PublicKey(),
				Payee:        feePayer,
				RentPayer:    feePayer,
				Mint:         solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
				TokenProgram: solana.MustPublicKeyFromBase58(tokenProgram),
				Splits:       []paymentchannels.Split{{Recipient: payTo, BPS: batchsettlement.FullSplitBPS}},
				Network:      network,
			})
			require.NoError(t, err)
			instructions = append(instructions, instruction)
		}
		return instructions
	}

	t.Run("a full version-1 claim and settle batch fit one transaction", func(t *testing.T) {
		scheme := NewBatchSvmScheme(context.Background(), newScriptedSigner(t, 1), nil)
		feePayer := mustKey(t).PublicKey()
		for _, tokenProgram := range []string{svm.TokenProgramAddress, svm.Token2022ProgramAddress} {
			claims := claimInstructions(t, batchsettlement.V1MaxClaimChannels)
			assert.True(t, paymentchannels.FacilitatorV1TransactionFits(feePayer, claims, scheme.redemptionOptions(claims, nil)), tokenProgram)
			settles := distributeInstructions(t, batchsettlement.V1MaxSettleChannels, tokenProgram, feePayer)
			assert.True(t, paymentchannels.FacilitatorV1TransactionFits(feePayer, settles, scheme.redemptionOptions(settles, nil)), tokenProgram)
		}
		// One more channel than the advertised claim capacity no longer fits.
		over := claimInstructions(t, batchsettlement.V1MaxClaimChannels+1)
		assert.False(t, paymentchannels.FacilitatorV1TransactionFits(feePayer, over, scheme.redemptionOptions(over, nil)))
	})

	t.Run("sizes the version-1 compute unit limit for the batch", func(t *testing.T) {
		assert.Equal(t, paymentchannels.DefaultSettleComputeUnitLimit, RedemptionComputeUnitLimit(claimInstructions(t, 1)))
		assert.Equal(t, uint32(RedemptionComputeUnitsBase+18*RedemptionComputeUnitsPerChannel), RedemptionComputeUnitLimit(claimInstructions(t, 18)))
	})

	submit := func(t *testing.T, config *Config, instructions []solana.Instruction) *solana.Transaction {
		t.Helper()
		signer := &confirmingSigner{scriptedSigner: newScriptedSigner(t, 1), slot: 432}
		scheme := NewBatchSvmScheme(context.Background(), signer, config)
		result, err := scheme.submitRedemption(context.Background(), signer.feePayer().String(), network, instructions, "redemption", "")
		require.NoError(t, err)
		require.True(t, result.OK)
		sent := signer.sentTransactions()
		require.Len(t, sent, 1)
		return sent[0]
	}

	t.Run("submits redemptions as version 1 with the batch budget", func(t *testing.T) {
		instructions := claimInstructions(t, 6)
		tx := submit(t, nil, instructions)
		assert.Equal(t, solana.MessageVersionV1, tx.Message.GetVersion())
		require.NotNil(t, tx.Message.TransactionConfig.ComputeUnitLimit)
		assert.Equal(t, RedemptionComputeUnitLimit(instructions), *tx.Message.TransactionConfig.ComputeUnitLimit)
		require.NotNil(t, tx.Message.TransactionConfig.LoadedAccountsDataSizeLimit)
		assert.Equal(t, paymentchannels.DefaultSettleLoadedAccountsDataSizeLimit, *tx.Message.TransactionConfig.LoadedAccountsDataSizeLimit)
	})

	t.Run("submits redemptions as version 0 when configured", func(t *testing.T) {
		tx := submit(t, &Config{FacilitatorTransactionVersion: intPtr(paymentchannels.FacilitatorTransactionVersion0)}, claimInstructions(t, 2))
		assert.Equal(t, solana.MessageVersionV0, tx.Message.GetVersion())
		assert.Nil(t, tx.Message.TransactionConfig.ComputeUnitLimit, "version 0 carries no inline batch budget")
		hasBudget := false
		for _, instruction := range tx.Message.Instructions {
			program, err := tx.Message.Program(instruction.ProgramIDIndex)
			require.NoError(t, err)
			if program.Equals(solana.ComputeBudget) {
				hasBudget = true
			}
		}
		assert.True(t, hasBudget, "version 0 carries ComputeBudget instructions")
	})

	t.Run("fails a redemption that does not fit instead of truncating it", func(t *testing.T) {
		signer := &confirmingSigner{scriptedSigner: newScriptedSigner(t, 1), slot: 432}
		scheme := NewBatchSvmScheme(context.Background(), signer, nil)
		_, err := scheme.submitRedemption(context.Background(), signer.feePayer().String(), network, claimInstructions(t, batchsettlement.V1MaxClaimChannels+1), "redemption", "")
		require.ErrorContains(t, err, "does not fit one version-1 transaction")
		assert.Empty(t, signer.sentTransactions())
	})
}
