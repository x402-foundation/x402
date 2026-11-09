package paymentchannels

import (
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/require"

	svm "github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

// distribute pays the treasury of the program deployed on the network by
// default, and the configured treasury owner for a custom or local build.
func TestDistributeTreasuryOwnerOverride(t *testing.T) {
	require.Equal(t, devnetTreasuryOwner, ResolveTreasuryOwner(solana.PublicKey{}, svm.SolanaDevnetCAIP2))
	require.Equal(t, mainnetTreasuryOwner, ResolveTreasuryOwner(mainnetTreasuryOwner, svm.SolanaDevnetCAIP2))

	fixture := newOpenFixture(t)
	accounts := func(override solana.PublicKey) []solana.PublicKey {
		ix, err := BuildDistributeInstruction(DistributeInstructionArgs{
			Channel:       fixture.built.ChannelID,
			Payer:         fixture.payerKey.PublicKey(),
			Payee:         fixture.feePayer,
			RentPayer:     fixture.feePayer,
			Mint:          fixture.mint,
			TokenProgram:  fixture.tokenProgram,
			Splits:        []Split{{Recipient: fixture.payTo.String(), BPS: BasisPointsDenominator}},
			Network:       svm.SolanaDevnetCAIP2,
			TreasuryOwner: override,
		})
		require.NoError(t, err)
		keys := make([]solana.PublicKey, 0, len(ix.Accounts()))
		for _, meta := range ix.Accounts() {
			keys = append(keys, meta.PublicKey)
		}
		return keys
	}
	devnetATA, err := FindATA(devnetTreasuryOwner, fixture.mint, fixture.tokenProgram)
	require.NoError(t, err)
	mainnetATA, err := FindATA(mainnetTreasuryOwner, fixture.mint, fixture.tokenProgram)
	require.NoError(t, err)
	require.Contains(t, accounts(solana.PublicKey{}), devnetATA)
	overridden := accounts(mainnetTreasuryOwner)
	require.Contains(t, overridden, mainnetATA)
	require.NotContains(t, overridden, devnetATA)
}
