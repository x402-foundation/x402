package paymentchannels

import (
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/require"
)

// buildReclaimBatch returns the exact distinct-channel instruction set the
// cleanup packer evaluates before broadcasting.
func buildReclaimBatch(t *testing.T, n int) (solana.PublicKey, []solana.Instruction) {
	t.Helper()
	rentPayer, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	instructions := make([]solana.Instruction, 0, n)
	for i := 0; i < n; i++ {
		channel, err := solana.NewRandomPrivateKey()
		require.NoError(t, err)
		instructions = append(instructions,
			BuildReclaimInstruction(channel.PublicKey(), rentPayer.PublicKey()))
	}
	return rentPayer.PublicKey(), instructions
}

func TestReclaimBatchUsesEveryAvailableV1Account(t *testing.T) {
	t.Parallel()

	// fee payer + program id + one distinct channel per instruction = 64 keys.
	feePayer, instructions := buildReclaimBatch(t, 62)
	limit := ReclaimComputeUnitLimit(len(instructions))
	loadedLimit := ReclaimLoadedAccountsDataSizeLimit(len(instructions))
	opts := SubmitSettleOptions{
		ComputeUnitLimit:            &limit,
		LoadedAccountsDataSizeLimit: &loadedLimit,
	}
	require.True(t, FacilitatorV1TransactionFits(feePayer, instructions, opts))

	tx, err := buildSettleTransaction(feePayer, solana.Hash{}, instructions, opts)
	require.NoError(t, err)
	wire, err := tx.MarshalBinary()
	require.NoError(t, err)
	require.Len(t, tx.Message.AccountKeys, solana.MaxAddressesV1)
	require.LessOrEqual(t, len(wire), solana.MaxTransactionSizeV1)
}

func TestReclaimBatchRejectsTheFirstAccountOverTheV1Limit(t *testing.T) {
	t.Parallel()

	feePayer, instructions := buildReclaimBatch(t, 63)
	limit := ReclaimComputeUnitLimit(len(instructions))
	loadedLimit := ReclaimLoadedAccountsDataSizeLimit(len(instructions))
	require.False(t, FacilitatorV1TransactionFits(feePayer, instructions, SubmitSettleOptions{
		ComputeUnitLimit:            &limit,
		LoadedAccountsDataSizeLimit: &loadedLimit,
	}))
}

func TestFacilitatorV1PackingChecksInstructionAndWireLimits(t *testing.T) {
	t.Parallel()
	payer := solana.NewWallet().PublicKey()
	tiny := solana.NewInstruction(solana.MemoProgramID, nil, []byte("x"))
	instructions := make([]solana.Instruction, solana.MaxInstructionsV1)
	for i := range instructions {
		instructions[i] = tiny
	}
	require.True(t, FacilitatorV1TransactionFits(payer, instructions, SubmitSettleOptions{}))
	tooManyInstructions := make([]solana.Instruction, len(instructions)+1)
	copy(tooManyInstructions, instructions)
	tooManyInstructions[len(instructions)] = tiny
	require.False(t, FacilitatorV1TransactionFits(payer, tooManyInstructions, SubmitSettleOptions{}))

	tooLarge := solana.NewInstruction(solana.MemoProgramID, nil, make([]byte, 4_000))
	require.False(t, FacilitatorV1TransactionFits(payer, []solana.Instruction{tooLarge}, SubmitSettleOptions{}))
}

func TestCleanupOptionsClampsMaxReclaimsPerTxToSafeLimit(t *testing.T) {
	t.Parallel()
	opts, _ := (RentCleanupOptions{MaxReclaimsPerTx: MaxSafeReclaimsPerTx + 100}).withDefaults(nil, false)
	require.Equal(t, MaxSafeReclaimsPerTx, opts.MaxReclaimsPerTx)
}

func TestCleanupOptionsV1ReclaimLimits(t *testing.T) {
	t.Parallel()
	for _, value := range []int{0, -1, 62, 1000} {
		opts, _ := (RentCleanupOptions{MaxReclaimsPerTx: value}).withDefaults(nil, true)
		expected := value
		if value <= 0 {
			expected = DefaultMaxReclaimsPerTx
		}
		require.Equal(t, expected, opts.MaxReclaimsPerTx)
	}
}
