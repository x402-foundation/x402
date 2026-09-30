package facilitator

import (
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

// solanaPacketDataSize is Solana's maximum serialized transaction size
// (PACKET_DATA_SIZE), fixed by the protocol and not exposed by solana-go.
const solanaPacketDataSize = 1232

// buildReclaimBatchTransaction serializes the exact instruction set
// submitReclaimGroup sends: n BuildReclaimInstruction calls sharing one
// rent-payer fee payer, no other accounts or compute-budget instructions.
func buildReclaimBatchTransaction(t *testing.T, n int) *solana.Transaction {
	t.Helper()

	rentPayer, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)

	instructions := make([]solana.Instruction, 0, n)
	for i := 0; i < n; i++ {
		channel, err := solana.NewRandomPrivateKey()
		require.NoError(t, err)
		instructions = append(
			instructions,
			paymentchannels.BuildReclaimInstruction(channel.PublicKey(), rentPayer.PublicKey()),
		)
	}

	builder := solana.NewTransactionBuilder().
		SetRecentBlockHash(solana.Hash{}).
		SetFeePayer(rentPayer.PublicKey())
	for _, instruction := range instructions {
		builder = builder.AddInstruction(instruction)
	}
	tx, err := builder.Build()
	require.NoError(t, err)
	tx.Message.SetVersion(solana.MessageVersionV0)
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
	return tx
}

// TestReclaimBatchFitsInOneTransaction is the size validator gating
// MaxReclaimsPerTx: every channel PDA in a batch is distinct so this is the
// worst case for account-key growth, and it must stay under Solana's
// PACKET_DATA_SIZE with the same fee payer (rent payer) submitting every
// batch. It also pins the byte cost of one reclaim so a future instruction
// change is caught here instead of failing on a live cluster.
func TestReclaimBatchFitsInOneTransaction(t *testing.T) {
	t.Parallel()

	sizes := map[int]int{}
	for _, n := range []int{1, DefaultMaxReclaimsPerTx, MaxSafeReclaimsPerTx} {
		tx := buildReclaimBatchTransaction(t, n)
		encoded, err := tx.MarshalBinary()
		require.NoError(t, err)
		require.LessOrEqualf(t, len(encoded), solanaPacketDataSize,
			"%d reclaims per tx serialize to %d bytes, over the %d byte packet limit",
			n, len(encoded), solanaPacketDataSize)
		sizes[n] = len(encoded)
	}

	// Bytes added per extra reclaim instruction (one channel PDA plus its
	// instruction overhead); used below to derive the largest safe batch size.
	perReclaimBytes := (sizes[MaxSafeReclaimsPerTx] - sizes[1]) / (MaxSafeReclaimsPerTx - 1)
	require.Positive(t, perReclaimBytes)
	maxSafeReclaims := 1 + (solanaPacketDataSize-sizes[1])/perReclaimBytes
	require.GreaterOrEqualf(t, maxSafeReclaims, MaxSafeReclaimsPerTx,
		"largest safe batch is %d reclaims, below MaxSafeReclaimsPerTx (%d)", maxSafeReclaims, MaxSafeReclaimsPerTx)
}

// TestCleanupOptionsClampsMaxReclaimsPerTxToTheSafeCeiling proves an operator
// cannot configure a reclaim batch size that TestReclaimBatchFitsInOneTransaction
// has not already proven safe: withDefaults silently clamps any value above
// MaxSafeReclaimsPerTx instead of building transactions that fail to
// serialize or get rejected on broadcast.
func TestCleanupOptionsClampsMaxReclaimsPerTxToTheSafeCeiling(t *testing.T) {
	t.Parallel()

	opts := CleanupOptions{MaxReclaimsPerTx: MaxSafeReclaimsPerTx + 100}.withDefaults()
	require.Equal(t, MaxSafeReclaimsPerTx, opts.MaxReclaimsPerTx)
}
