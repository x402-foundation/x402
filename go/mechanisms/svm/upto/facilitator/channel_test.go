package facilitator

import (
	"context"
	"encoding/binary"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

// Pins the exact schedule, so a change back to `backoffStep << (attempt-1)` fails here.
func TestChannelReadPolicyBackoffIsLinear(t *testing.T) {
	policy := channelReadPolicy{}.resolve()

	assert.Equal(t, DefaultChannelReadMaxAttempts, policy.maxAttempts)
	assert.Equal(t, DefaultChannelReadBackoffStep, policy.backoffStep)

	var (
		delays []time.Duration
		total  time.Duration
	)
	for attempt := 1; attempt < policy.maxAttempts; attempt++ {
		delay := policy.delayAfterAttempt(attempt)
		delays = append(delays, delay)
		total += delay
	}

	assert.Equal(t, []time.Duration{
		200 * time.Millisecond,
		400 * time.Millisecond,
		600 * time.Millisecond,
		800 * time.Millisecond,
		1000 * time.Millisecond,
	}, delays)
	assert.Equal(t, 3*time.Second, total)
	assert.Equal(t, time.Second, delays[len(delays)-1], "longest single wait")
}

// Config overrides must reach the retry loop rather than it using the defaults unconditionally.
func TestChannelReadPolicyHonoursSchemeConfig(t *testing.T) {
	attempts := 8
	step := 50 * time.Millisecond
	scheme := &UptoSvmScheme{config: Config{
		ChannelReadMaxAttempts: &attempts,
		ChannelReadBackoffStep: &step,
	}}

	policy := scheme.resolveChannelReadPolicy().resolve()
	assert.Equal(t, attempts, policy.maxAttempts)
	assert.Equal(t, step, policy.backoffStep)
	assert.Equal(t, 400*time.Millisecond, policy.delayAfterAttempt(8))
}

// A channel that never becomes visible must be read exactly maxAttempts times.
func TestFetchAndVerifyOpenChannelStopsAtConfiguredAttemptCount(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newPaymentFixture(t, signer)
	rpcStub := newStubRPC(t)
	signer.attachRPC(rpc.New(rpcStub.url))

	_, err := fetchAndVerifyOpenChannel(
		context.Background(),
		signer,
		testNetwork,
		fixture.channelID,
		expectedFrom(fixture),
		channelReadPolicy{maxAttempts: 3, backoffStep: time.Millisecond},
	)
	require.Error(t, err)
	assert.Len(t, rpcStub.commitments["getAccountInfo"], 3)
}

// expectedFrom derives the binding the facilitator checks for a fixture channel.
func expectedFrom(fixture *paymentFixture) expectedOpenChannel {
	return expectedOpenChannel{
		AuthorizedSigner: fixture.authorizer.PublicKey().String(),
		Mint:             fixture.mint.String(),
		Payee:            fixture.feePayer.String(),
		Payer:            fixture.payerKey.PublicKey().String(),
		RentPayer:        fixture.feePayer.String(),
		Deposit:          fixture.deposit,
		GracePeriod:      fixture.graceSeconds,
		Splits:           fixture.splits(),
	}
}

func TestFetchAndVerifyOpenChannelRetriesMissingAccount(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newPaymentFixture(t, signer)
	rpcStub := newStubRPC(t)
	signer.attachRPC(rpc.New(rpcStub.url))
	rpcStub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))
	rpcStub.hideAccountForReads(fixture.channelID.String(), 1)

	verified, err := fetchAndVerifyOpenChannel(
		context.Background(),
		signer,
		testNetwork,
		fixture.channelID,
		expectedFrom(fixture),
		channelReadPolicy{},
	)
	require.NoError(t, err)
	assert.Equal(t, fixture.channelID, verified.ChannelID)
	assert.Len(t, rpcStub.commitments["getAccountInfo"], 2)
}

func TestFetchAndVerifyOpenChannelStopsRetryingWhenContextEnds(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newPaymentFixture(t, signer)
	rpcStub := newStubRPC(t)
	signer.attachRPC(rpc.New(rpcStub.url))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	_, err := fetchAndVerifyOpenChannel(
		ctx,
		signer,
		testNetwork,
		fixture.channelID,
		expectedFrom(fixture),
		channelReadPolicy{},
	)
	require.ErrorIs(t, err, context.DeadlineExceeded)
	assert.Len(t, rpcStub.commitments["getAccountInfo"], 1)
}

func TestVerifyOpenChannelAccountBindsTheOnchainState(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newPaymentFixture(t, signer)
	channel, err := paymentchannels.DecodeChannel(fixture.openChannel().encode(t))
	require.NoError(t, err)

	verified, err := verifyOpenChannelAccount(fixture.channelID, channel, expectedFrom(fixture))
	require.NoError(t, err)

	// The parsed keys are what settlement signs against.
	assert.Equal(t, fixture.channelID, verified.ChannelID)
	assert.Equal(t, fixture.payerKey.PublicKey(), verified.Payer)
	assert.Equal(t, fixture.authorizer.PublicKey(), verified.AuthorizedSigner)
	assert.Equal(t, fixture.mint, verified.Mint)
	assert.Equal(t, fixture.feePayer, verified.Payee)
	assert.Equal(t, fixture.feePayer, verified.RentPayer)
	assert.Equal(t, fixture.splits(), verified.Splits)
}

// The onchain account, not the client payload, is the source of truth, so every
// term the facilitator verified in the open must still match at settle time.
func TestVerifyOpenChannelAccountRejectsEveryUnboundTerm(t *testing.T) {
	stranger, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)

	tests := []struct {
		name      string
		mutate    func(account *channelAccount, expected *expectedOpenChannel)
		wantError string
	}{
		{
			name: "channel already sealed",
			mutate: func(account *channelAccount, _ *expectedOpenChannel) {
				account.Status = paymentchannels.StatusSealed
			},
			wantError: "is not open",
		},
		{
			name: "channel closing",
			mutate: func(account *channelAccount, _ *expectedOpenChannel) {
				account.Status = paymentchannels.StatusClosing
			},
			wantError: "is not open",
		},
		{
			name: "mint rotated",
			mutate: func(account *channelAccount, _ *expectedOpenChannel) {
				account.Mint = stranger.PublicKey()
			},
			wantError: "mint",
		},
		{
			name: "payee rotated",
			mutate: func(account *channelAccount, _ *expectedOpenChannel) {
				account.Payee = stranger.PublicKey()
			},
			wantError: "payee",
		},
		{
			name: "authorized signer rotated",
			mutate: func(account *channelAccount, _ *expectedOpenChannel) {
				account.AuthorizedSigner = stranger.PublicKey()
			},
			wantError: "authorized signer",
		},
		{
			name: "rent payer rotated",
			mutate: func(account *channelAccount, _ *expectedOpenChannel) {
				account.RentPayer = stranger.PublicKey()
			},
			wantError: "rent payer",
		},
		{
			name: "payer is not the payload sender",
			mutate: func(account *channelAccount, _ *expectedOpenChannel) {
				account.Payer = stranger.PublicKey()
			},
			wantError: "payer",
		},
		{
			name: "grace period shortened",
			mutate: func(account *channelAccount, _ *expectedOpenChannel) {
				account.GracePeriod = 60
			},
			wantError: "grace period",
		},
		{
			name: "deposit below the authorized ceiling",
			mutate: func(account *channelAccount, _ *expectedOpenChannel) {
				account.Deposit = 1
			},
			wantError: "deposit",
		},
		{
			name: "distribution pays a different recipient",
			mutate: func(account *channelAccount, _ *expectedOpenChannel) {
				account.Splits = []paymentchannels.Split{
					{Recipient: stranger.PublicKey().String(), BPS: paymentchannels.BasisPointsDenominator},
				}
			},
			wantError: "distribution does not match",
		},
		{
			name: "distribution splits the payout",
			mutate: func(_ *channelAccount, expected *expectedOpenChannel) {
				expected.Splits = append(expected.Splits,
					paymentchannels.Split{Recipient: stranger.PublicKey().String(), BPS: 1})
			},
			wantError: "distribution does not match",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			signer := newMockSigner(t, 1)
			fixture := newPaymentFixture(t, signer)
			account, expected := fixture.openChannel(), expectedFrom(fixture)
			test.mutate(&account, &expected)

			channel, err := paymentchannels.DecodeChannel(account.encode(t))
			require.NoError(t, err)

			_, err = verifyOpenChannelAccount(fixture.channelID, channel, expected)

			require.ErrorContains(t, err, test.wantError)
		})
	}
}

func TestBuildSettleAndDistributeCarriesTheVoucherPrecompile(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newPaymentFixture(t, signer)
	channel := settlementChannel{
		ChannelID:    fixture.channelID,
		Mint:         fixture.mint,
		Payee:        fixture.feePayer,
		Payer:        fixture.payerKey.PublicKey(),
		RentPayer:    fixture.feePayer,
		TokenProgram: solana.TokenProgramID,
		Network:      testNetwork,
		Splits:       fixture.splits(),
	}
	voucher := &voucherArgs{
		AuthorizedSigner: fixture.authorizer.PublicKey(),
		SignatureBase58:  fixture.voucher(t, 1858),
		CumulativeAmount: 1858,
		ExpiresAt:        fixture.expiresAt,
	}

	t.Run("metered charge", func(t *testing.T) {
		instructions, err := buildSettleAndDistribute(channel, voucher)
		require.NoError(t, err)
		require.Len(t, instructions, 3)

		assert.Equal(t, paymentchannels.Ed25519ProgramID, instructions[0].ProgramID())
		precompile, err := instructions[0].Data()
		require.NoError(t, err)
		signature, err := solana.SignatureFromBase58(voucher.SignatureBase58)
		require.NoError(t, err)
		expected, err := paymentchannels.BuildEd25519VerifyInstruction(
			paymentchannels.EncodeVoucherMessage(fixture.channelID, 1858, fixture.expiresAt),
			signature[:],
			fixture.authorizer.PublicKey(),
		)
		require.NoError(t, err)
		expectedData, err := expected.Data()
		require.NoError(t, err)
		assert.Equal(t, expectedData, precompile,
			"the precompile must commit to the same amount and deadline the facilitator settles")

		seal, err := instructions[1].Data()
		require.NoError(t, err)
		assert.Equal(t, []byte{paymentchannels.SettleAndSealDiscriminator, 1}, seal,
			"settle_and_seal must read the voucher from the preceding instruction")
	})

	t.Run("zero charge", func(t *testing.T) {
		instructions, err := buildSettleAndDistribute(channel, nil)
		require.NoError(t, err)
		require.Len(t, instructions, 2, "sealing at the watermark needs no precompile")

		seal, err := instructions[0].Data()
		require.NoError(t, err)
		assert.Equal(t, []byte{paymentchannels.SettleAndSealDiscriminator, 0}, seal)
	})

	t.Run("malformed voucher signature", func(t *testing.T) {
		malformed := *voucher
		malformed.SignatureBase58 = "not-a-signature!!"

		_, err := buildSettleAndDistribute(channel, &malformed)

		require.ErrorContains(t, err, "not valid base58")
	})
}

// The composite settlement simulation must not duplicate the client's
// SetComputeUnitLimit (the settle/distribute instructions appended after it
// need headroom the client's own budget cannot see), but the client's
// priority fee is meaningful to transaction landing and must survive.
func TestSettleSimulationReplacesTheClientComputeUnitLimitButKeepsItsPriorityFee(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	signer.onSend = func(*solana.Transaction) {
		stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))
	}

	_, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)
	require.NoError(t, err)

	simulated := stub.lastSimulatedTransaction()
	require.NotNil(t, simulated, "settle must simulate the composite open+settle+distribute transaction")

	var limitCount, priceCount int
	var simulatedLimitUnits uint32
	for _, compiled := range simulated.Message.Instructions {
		program, err := simulated.Message.Program(compiled.ProgramIDIndex)
		require.NoError(t, err)
		if !program.Equals(solana.ComputeBudget) || len(compiled.Data) == 0 {
			continue
		}
		switch compiled.Data[0] {
		case paymentchannels.ComputeBudgetSetUnitLimit:
			limitCount++
			simulatedLimitUnits = binary.LittleEndian.Uint32(compiled.Data[1:5])
		case paymentchannels.ComputeBudgetSetUnitPrice:
			priceCount++
		}
	}

	assert.Equal(t, 1, limitCount,
		"the client's compute-unit limit must be replaced, not duplicated alongside the facilitator's")
	assert.Equal(t, uint32(simComputeUnitLimit), simulatedLimitUnits,
		"simulation must raise the limit to the per-transaction max, not keep the client's own budget")
	assert.Equal(t, 1, priceCount, "the client's priority fee must survive into the simulated transaction")
}
