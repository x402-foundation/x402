package paymentchannels

import (
	"context"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/require"

	svm "github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

// simulationRecorder captures the transaction a readiness simulation runs.
type simulationRecorder struct {
	recordingChannelSigner
	simulated *solana.Transaction
}

func (s *simulationRecorder) SimulateTransaction(_ context.Context, tx *solana.Transaction, _ string, _ *svm.FacilitatorSimulateTransactionOptions) error {
	s.simulated = tx
	return nil
}

func (s *simulationRecorder) GetAccountInfo(context.Context, solana.PublicKey, string, *rpc.GetAccountInfoOpts) (*rpc.GetAccountInfoResult, error) {
	return nil, rpc.ErrNotFound
}

func (s *simulationRecorder) GetSlot(context.Context, string, rpc.CommitmentType) (uint64, error) {
	return 0, nil
}

// The open + settle + distribute readiness simulation runs in the open's own
// message version: a version-1 open is simulated as version 1 with its budget
// in the message config and no ComputeBudget instruction.
func TestSimulateOpenSettleDistributeFollowsTheOpenVersion(t *testing.T) {
	fixture := newOpenFixture(t)
	for _, tc := range []struct {
		name    string
		wire    string
		version solana.MessageVersion
	}{
		{"version 0", encodeTransaction(t, fixture.built.Transaction), solana.MessageVersionV0},
		{"version 1", fixture.buildV1Open(t, nil), solana.MessageVersionV1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			open, err := svm.DecodeTransaction(tc.wire)
			require.NoError(t, err)
			signer := &simulationRecorder{}
			err = SimulateOpenSettleDistribute(context.Background(), signer, fixture.feePayer, tc.wire, SettlementSimChannel{
				ChannelID:    fixture.built.ChannelID,
				Mint:         fixture.mint,
				Network:      svm.SolanaDevnetCAIP2,
				Payee:        fixture.feePayer,
				Payer:        fixture.payerKey.PublicKey(),
				RentPayer:    fixture.feePayer,
				Splits:       []Split{{Recipient: fixture.payTo.String(), BPS: BasisPointsDenominator}},
				TokenProgram: fixture.tokenProgram,
			})
			require.NoError(t, err)
			require.NotNil(t, signer.simulated)
			require.Equal(t, tc.version, open.Message.GetVersion())
			require.Equal(t, tc.version, signer.simulated.Message.GetVersion())
			hasComputeBudget := false
			for _, ix := range signer.simulated.Message.Instructions {
				program, err := signer.simulated.Message.Program(ix.ProgramIDIndex)
				require.NoError(t, err)
				hasComputeBudget = hasComputeBudget || program.Equals(solana.ComputeBudget)
			}
			require.Equal(t, tc.version != solana.MessageVersionV1, hasComputeBudget)
		})
	}
}
