package facilitator

import (
	"context"
	"encoding/binary"
	"errors"
	"strconv"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto"
	"github.com/x402-foundation/x402/go/v2/types"
)

// newScheme wires a facilitator against the stub RPC.
func newScheme(signer *mockSigner, stub *stubRPC, config *Config) *UptoSvmScheme {
	signer.attachRPC(rpc.New(stub.url))
	return NewUptoSvmScheme(signer, config)
}

// settleErrorReason extracts the scheme error code from a settle failure.
func settleErrorReason(t *testing.T, err error) string {
	t.Helper()
	settleErr := &x402.SettleError{}
	require.ErrorAs(t, err, &settleErr)
	return settleErr.ErrorReason
}

// verifyErrorReason extracts the scheme error code from a verify failure.
func verifyErrorReason(t *testing.T, err error) string {
	t.Helper()
	verifyErr := &x402.VerifyError{}
	require.ErrorAs(t, err, &verifyErr)
	return verifyErr.InvalidReason
}

func TestSchemeIdentity(t *testing.T) {
	scheme := newScheme(newMockSigner(t, 1), newStubRPC(t), nil)

	assert.Equal(t, "upto", scheme.Scheme())
	assert.Equal(t, "solana:*", scheme.CaipFamily())
}

func TestGetExtraAdvertisesAManagedFeePayer(t *testing.T) {
	signer := newMockSigner(t, 3)
	scheme := newScheme(signer, newStubRPC(t), nil)
	managed := map[string]bool{}
	for _, address := range signer.GetAddresses(context.Background(), testNetwork) {
		managed[address.String()] = true
	}

	selected := map[string]bool{}
	for i := 0; i < 50; i++ {
		extra := scheme.GetExtra(testNetwork)
		feePayer, ok := extra[upto.ExtraFeePayer].(string)
		require.True(t, ok)
		require.True(t, managed[feePayer], "the advertised feePayer must be one this facilitator signs for")
		selected[feePayer] = true
	}
	assert.Greater(t, len(selected), 1, "selection spreads load across the signer pool")

	assert.ElementsMatch(t, []string{
		signer.keys[0].PublicKey().String(),
		signer.keys[1].PublicKey().String(),
		signer.keys[2].PublicKey().String(),
	}, scheme.GetSigners(testNetwork))
}

func TestVerifyAcceptsAWellFormedOpen(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)

	response, err := scheme.Verify(context.Background(), fixture.payload, fixture.requirements, nil)
	require.NoError(t, err)

	assert.True(t, response.IsValid)
	assert.Equal(t, fixture.payerKey.PublicKey().String(), response.Payer)
	assert.Empty(t, signer.sentTransactions(), "verify is read-only and never broadcasts")
	assert.Zero(t, stub.simulations(), "verify does not simulate")
}

func TestVerifyRejections(t *testing.T) {
	tests := []struct {
		name       string
		payload    func(t *testing.T, f *paymentFixture) types.PaymentPayload
		require    func(t *testing.T, f *paymentFixture) types.PaymentRequirements
		wantReason string
	}{
		{
			name: "payload from another mechanism",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				payload := f.payload
				payload.Payload = map[string]interface{}{"transaction": "AQ=="}
				return payload
			},
			wantReason: ErrUnsupportedPayloadType,
		},
		{
			name: "scheme mismatch",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				payload := f.payload
				payload.Accepted.Scheme = "exact"
				return payload
			},
			wantReason: ErrUnsupportedScheme,
		},
		{
			name: "network mismatch",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				payload := f.payload
				payload.Accepted.Network = "solana"
				return payload
			},
			wantReason: ErrNetworkMismatch,
		},
		{
			name: "client-supplied voucher",
			payload: func(t *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.claimPayload(t, 1)
			},
			wantReason: ErrUnexpectedVoucher,
		},
		{
			name: "client-supplied empty voucher key",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{svm.UptoVoucherSignatureField: ""})
			},
			wantReason: ErrUnexpectedVoucher,
		},
		{
			name: "missing receiver authorizer in the challenge",
			require: func(_ *testing.T, f *paymentFixture) types.PaymentRequirements {
				return f.withRequirements(func(requirements *types.PaymentRequirements) {
					delete(requirements.Extra, upto.ExtraReceiverAuthorizer)
				})
			},
			wantReason: ErrPaymentRequirements,
		},
		{
			name: "non-integer withdraw delay",
			require: func(_ *testing.T, f *paymentFixture) types.PaymentRequirements {
				return f.withRequirements(func(requirements *types.PaymentRequirements) {
					requirements.Extra[upto.ExtraWithdrawDelay] = 12.5
				})
			},
			wantReason: ErrPaymentRequirements,
		},
		{
			name: "fee payer this facilitator does not manage",
			require: func(_ *testing.T, f *paymentFixture) types.PaymentRequirements {
				return f.withRequirements(func(requirements *types.PaymentRequirements) {
					requirements.Extra[upto.ExtraFeePayer] = solana.SysVarClockPubkey.String()
				})
			},
			wantReason: ErrFacilitatorMismatch,
		},
		{
			name: "authorized signer is not the receiver authorizer",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{
					"authorizedSigner": solana.SysVarClockPubkey.String(),
				})
			},
			wantReason: ErrReceiverAuthorizer,
		},
		{
			// The mismatch above is the more specific answer, so a malformed
			// receiverAuthorizer only surfaces once the payload agrees with it.
			name: "malformed receiver authorizer the payload agrees with",
			require: func(_ *testing.T, f *paymentFixture) types.PaymentRequirements {
				return f.withRequirements(func(requirements *types.PaymentRequirements) {
					requirements.Extra[upto.ExtraReceiverAuthorizer] = "OtherReceiver111111111111111111111111"
				})
			},
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{
					"authorizedSigner": "OtherReceiver111111111111111111111111",
				})
			},
			wantReason: ErrPaymentRequirements,
		},
		{
			name: "malformed asset",
			require: func(_ *testing.T, f *paymentFixture) types.PaymentRequirements {
				return f.withRequirements(func(requirements *types.PaymentRequirements) {
					requirements.Asset = "NotAMint11111111111111111111111111111"
				})
			},
			wantReason: ErrPaymentRequirements,
		},
		{
			name: "malformed payer",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"from": "NotAPayer11111111111111111111111111111"})
			},
			wantReason: ErrPayerMismatch,
		},
		{
			name: "token program that is not an SPL token program",
			require: func(_ *testing.T, f *paymentFixture) types.PaymentRequirements {
				return f.withRequirements(func(requirements *types.PaymentRequirements) {
					requirements.Extra[upto.ExtraTokenProgram] = solana.SysVarClockPubkey.String()
				})
			},
			wantReason: ErrPaymentRequirements,
		},
		{
			name: "max amount does not match the challenge",
			require: func(_ *testing.T, f *paymentFixture) types.PaymentRequirements {
				return f.withRequirements(func(requirements *types.PaymentRequirements) {
					requirements.Amount = "9999"
				})
			},
			wantReason: ErrAmountMismatch,
		},
		{
			name: "deposit below the ceiling",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"deposit": "9999"})
			},
			wantReason: ErrDepositNotCeiling,
		},
		{
			name: "deposit above the ceiling",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"deposit": "10001"})
			},
			wantReason: ErrDepositNotCeiling,
		},
		{
			name: "non-integer max amount",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"maxAmount": "1.5"})
			},
			wantReason: ErrPayloadAmount,
		},
		{
			name: "non-integer open slot",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"openSlot": "soon"})
			},
			wantReason: ErrChannelSeed,
		},
		{
			name: "non-integer nonce",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"nonce": "-1"})
			},
			wantReason: ErrChannelSeed,
		},
		{
			name: "fractional expiry",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"expiresAt": float64(time.Now().Unix()) + 0.5})
			},
			wantReason: ErrUnsupportedPayloadType,
		},
		{
			name: "fractional activation",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"validAfter": 0.5})
			},
			wantReason: ErrUnsupportedPayloadType,
		},
		{
			name: "not yet active",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"validAfter": time.Now().Unix() + 300})
			},
			wantReason: ErrNotYetActive,
		},
		{
			name: "already expired",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"expiresAt": time.Now().Unix() - 1})
			},
			wantReason: ErrExpired,
		},
		{
			name: "zero expiry",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"expiresAt": 0})
			},
			wantReason: ErrExpired,
		},
		{
			name: "expiry beyond the requirement timeout",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"expiresAt": time.Now().Unix() + 1200})
			},
			wantReason: ErrExpiresAtMismatch,
		},
		{
			name: "channel id that does not match the open",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"channelId": solana.SysVarClockPubkey.String()})
			},
			wantReason: ErrChannelID,
		},
		{
			name: "nonce that does not match the open salt",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"nonce": "43"})
			},
			wantReason: ErrNonce,
		},
		{
			name: "undecodable open transaction",
			payload: func(_ *testing.T, f *paymentFixture) types.PaymentPayload {
				return f.withPayload(map[string]interface{}{"openTransaction": "AAAA"})
			},
			wantReason: ErrOpenTransaction,
		},
		{
			name: "payTo that does not match the sealed distribution",
			require: func(_ *testing.T, f *paymentFixture) types.PaymentRequirements {
				return f.withRequirements(func(requirements *types.PaymentRequirements) {
					requirements.PayTo = solana.SysVarClockPubkey.String()
				})
			},
			wantReason: ErrOpenTransaction,
		},
		{
			name: "stale open slot",
			require: func(_ *testing.T, f *paymentFixture) types.PaymentRequirements {
				return f.withRequirements(func(requirements *types.PaymentRequirements) {
					requirements.Extra[upto.ExtraRecentSlot] = strconv.FormatUint(
						testSlot+paymentchannels.OpenSlotWindow+1, 10)
				})
			},
			wantReason: ErrOpenTransaction,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			signer := newMockSigner(t, 1)
			fixture := newPaymentFixture(t, signer)
			scheme := newScheme(signer, newStubRPC(t), nil)

			payload := fixture.payload
			if test.payload != nil {
				payload = test.payload(t, fixture)
			}
			requirements := fixture.requirements
			if test.require != nil {
				requirements = test.require(t, fixture)
			}

			_, err := scheme.Verify(context.Background(), payload, requirements, nil)

			assert.Equal(t, test.wantReason, verifyErrorReason(t, err))
			assert.Empty(t, signer.sentTransactions(), "rejections never broadcast")
		})
	}
}

func TestVerifyEnforcesTheChannelLifetimeCeiling(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newPaymentFixture(t, signer)
	lifetime := 300
	scheme := newScheme(signer, newStubRPC(t), &Config{MaxChannelLifetimeSecs: &lifetime})

	requirements := fixture.withRequirements(func(requirements *types.PaymentRequirements) {
		requirements.MaxTimeoutSeconds = 600
	})
	_, err := scheme.Verify(context.Background(), fixture.payload, requirements, nil)
	assert.Equal(t, ErrChannelLifetimeExceeded, verifyErrorReason(t, err))

	// A timeout inside the ceiling but an expiry beyond it is also rejected.
	requirements = fixture.withRequirements(func(requirements *types.PaymentRequirements) {
		requirements.MaxTimeoutSeconds = 300
	})
	payload := fixture.withPayload(map[string]interface{}{"expiresAt": time.Now().Unix() + 3000})
	_, err = scheme.Verify(context.Background(), payload, requirements, nil)
	assert.Equal(t, ErrChannelLifetimeExceeded, verifyErrorReason(t, err))
}

// An unset cap must mean "use the default ceiling", not "accept any lifetime", so
// a facilitator cannot be talked into sponsoring rent for a year.
func TestVerifyAppliesTheDefaultLifetimeCeilingWhenUnset(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, newStubRPC(t), &Config{})

	requirements := fixture.withRequirements(func(requirements *types.PaymentRequirements) {
		requirements.MaxTimeoutSeconds = DefaultMaxChannelLifetimeSecs + 1
	})

	_, err := scheme.Verify(context.Background(), fixture.payload, requirements, nil)

	assert.Equal(t, ErrChannelLifetimeExceeded, verifyErrorReason(t, err))
}

// A limit that can never accept a payment is an operator error, so it surfaces at
// startup rather than as a runtime rejection, matching the TypeScript constructor.
func TestNewUptoSvmSchemeRejectsUnusableLimits(t *testing.T) {
	signer := newMockSigner(t, 1)
	zero := 0
	negative := -1
	zeroUnits := uint32(0)
	zeroSignatures := 0
	zeroSettleLimit := uint32(0)

	assert.PanicsWithValue(t, "upto svm facilitator: signer is required", func() {
		NewUptoSvmScheme(nil, nil)
	})
	assert.Panics(t, func() {
		NewUptoSvmScheme(signer, &Config{MaxChannelLifetimeSecs: &zero})
	}, "a zero lifetime ceiling can never accept a payment")
	assert.Panics(t, func() {
		NewUptoSvmScheme(signer, &Config{MaxChannelLifetimeSecs: &negative})
	})
	assert.Panics(t, func() {
		NewUptoSvmScheme(signer, &Config{MaxComputeUnits: &zeroUnits})
	})
	assert.Panics(t, func() {
		NewUptoSvmScheme(signer, &Config{MaxRequiredSignatures: &zeroSignatures})
	})
	assert.Panics(t, func() {
		NewUptoSvmScheme(signer, &Config{SettleComputeUnitLimit: &zeroSettleLimit})
	}, "a zero settle compute-unit limit can never land a transaction")

	assert.NotPanics(t, func() { NewUptoSvmScheme(signer, nil) }, "an unset config takes defaults")
}

func TestVerifyRejectsAnUnusableTimeout(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, newStubRPC(t), nil)

	requirements := fixture.withRequirements(func(requirements *types.PaymentRequirements) {
		requirements.MaxTimeoutSeconds = 0
	})

	_, err := scheme.Verify(context.Background(), fixture.payload, requirements, nil)

	assert.Equal(t, ErrPaymentRequirements, verifyErrorReason(t, err))
}

func TestVerifyRejectsAMalformedRecentSlot(t *testing.T) {
	for _, hint := range []interface{}{"not-a-slot", -1, 1.5, true} {
		signer := newMockSigner(t, 1)
		fixture := newPaymentFixture(t, signer)
		scheme := newScheme(signer, newStubRPC(t), nil)

		requirements := fixture.withRequirements(func(requirements *types.PaymentRequirements) {
			requirements.Extra[upto.ExtraRecentSlot] = hint
		})

		_, err := scheme.Verify(context.Background(), fixture.payload, requirements, nil)

		assert.Equal(t, ErrChannelSeed, verifyErrorReason(t, err),
			"recentSlot %v must fail the challenge rather than re-anchor to the live slot", hint)
	}
}

func TestVerifyFallsBackToTheLiveSlot(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)

	requirements := fixture.withRequirements(func(requirements *types.PaymentRequirements) {
		delete(requirements.Extra, upto.ExtraRecentSlot)
	})

	response, err := scheme.Verify(context.Background(), fixture.payload, requirements, nil)

	require.NoError(t, err)
	assert.True(t, response.IsValid)
}

func TestSettleRejectsAChargeAboveTheCeiling(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)

	_, err := scheme.Settle(
		context.Background(),
		fixture.claimPayload(t, 20_000),
		fixture.claimRequirements(20_000),
		nil,
	)

	assert.Equal(t, ErrSettlementExceedsAmount, settleErrorReason(t, err))
	assert.Empty(t, signer.sentTransactions())
	assert.Zero(t, stub.simulations(), "the ceiling is enforced before any RPC")
}

func TestSettleRejectsAPartialChargeWithoutAVoucher(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, newStubRPC(t), nil)

	_, err := scheme.Settle(context.Background(), fixture.payload, fixture.claimRequirements(500), nil)

	assert.Equal(t, ErrMissingVoucher, settleErrorReason(t, err))
	assert.Empty(t, signer.sentTransactions())
}

func TestSettleRejectsAnEmptyVoucher(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, newStubRPC(t), nil)
	payload := fixture.withPayload(map[string]interface{}{svm.UptoVoucherSignatureField: ""})

	_, err := scheme.Settle(context.Background(), payload, fixture.claimRequirements(500), nil)

	assert.Equal(t, ErrMissingVoucher, settleErrorReason(t, err))
}

func TestDepositSettleSimulatesThenBroadcasts(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	// The channel account appears once the open lands.
	signer.onSend = func(*solana.Transaction) {
		stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))
	}

	response, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)
	require.NoError(t, err)

	assert.True(t, response.Success)
	assert.Equal(t, "10000", response.Amount, "the deposit escrows the full ceiling")
	assert.Equal(t, fixture.payerKey.PublicKey().String(), response.Payer)
	assert.Equal(t, 1, stub.simulations(), "the whole lifecycle is simulated before the deposit is locked")
	require.Len(t, signer.sentTransactions(), 1)

	record, err := scheme.ChannelStorage().Get(context.Background(), fixture.channelID.String())
	require.NoError(t, err)
	require.NotNil(t, record, "the channel is indexed for rent cleanup")
	assert.Equal(t, fixture.payTo.String(), record.PayTo)
	assert.Equal(t, solana.TokenProgramID.String(), record.TokenProgram)
	assert.Equal(t, fixture.expiresAt, record.ExpiresAt)
}

// The commitment per read class is a cross-SDK contract: a TypeScript and a Go
// facilitator must judge the same channel from the same view of the chain.
func TestSettleReadsEachRPCClassAtThePolicyCommitment(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	signer.onSend = func(*solana.Transaction) {
		stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))
	}

	// Drop the slot hint so the facilitator has to fetch its own anchor.
	requirements := fixture.withRequirements(func(requirements *types.PaymentRequirements) {
		delete(requirements.Extra, upto.ExtraRecentSlot)
	})
	_, err := scheme.Settle(context.Background(), fixture.payload, requirements, nil)
	require.NoError(t, err)

	tests := []struct {
		method string
		want   rpc.CommitmentType
		reason string
	}{
		{
			method: "getAccountInfo",
			want:   upto.StateCommitment,
			reason: "a finalized read would miss a channel opened seconds ago",
		},
		{
			method: "getSlot",
			want:   upto.SlotCommitment,
			reason: "the openSlot anchor must sit in the frame the client pinned",
		},
		{
			method: "simulateTransaction",
			want:   upto.StateCommitment,
			reason: "simulation must see the state the settlement will execute against",
		},
	}

	for _, test := range tests {
		t.Run(test.method, func(t *testing.T) {
			commitments := stub.commitmentsFor(test.method)
			require.NotEmpty(t, commitments, "%s was never called", test.method)
			for _, commitment := range commitments {
				assert.Equal(t, string(test.want), commitment, test.reason)
			}
		})
	}
}

func TestDepositSettleRejectsAnExistingChannel(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	_, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)

	assert.Equal(t, ErrChannelAlreadyOpen, settleErrorReason(t, err))
	assert.Empty(t, signer.sentTransactions(), "one authorization opens exactly one channel")
}

func TestDepositSettleDoesNotBroadcastWhenSimulationFails(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.failSimulation(map[string]interface{}{"InstructionError": []interface{}{2, "AccountNotFound"}})

	_, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)

	assert.Equal(t, ErrSettlementSimulation, settleErrorReason(t, err))
	assert.Empty(t, signer.sentTransactions(), "a failed simulation must not escrow the client's deposit")
}

func TestDepositSettleReleasesTheCacheOnBroadcastFailure(t *testing.T) {
	signer := newMockSigner(t, 1)
	signer.sendErr = errors.New("blockhash not found")
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)

	_, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)
	assert.Equal(t, ErrChannelBroadcast, settleErrorReason(t, err))

	record, storageErr := scheme.ChannelStorage().Get(context.Background(), fixture.channelID.String())
	require.NoError(t, storageErr)
	require.NotNil(t, record, "the PDA stays indexed so cleanup can recover its rent")

	// The deposit cache entry was released, so a retry is not a duplicate.
	_, err = scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)
	assert.Equal(t, ErrChannelBroadcast, settleErrorReason(t, err))
}

func TestDepositSettleRejectsConcurrentDuplicates(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)

	// Both requests see a missing channel; only one may broadcast the open.
	signer.onSend = func(*solana.Transaction) {
		stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))
	}
	entered, release := stub.blockFirstSimulation()
	inFlight := make(chan error, 1)
	go func() {
		_, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)
		inFlight <- err
	}()
	<-entered

	_, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)
	assert.Equal(t, ErrDuplicateSettlement, settleErrorReason(t, err))

	release()
	require.NoError(t, <-inFlight)
	assert.Len(t, signer.sentTransactions(), 1, "one authorization opens exactly one channel")
}

func TestDepositSettleReportsAnUnboundChannel(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)

	signer.onSend = func(*solana.Transaction) {
		// A channel whose deposit does not match the authorization.
		account := fixture.openChannel()
		account.Deposit = 1
		stub.setAccount(fixture.channelID.String(), account.encode(t))
	}

	_, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)

	assert.Equal(t, ErrChannelState, settleErrorReason(t, err))
	record, storageErr := scheme.ChannelStorage().Get(context.Background(), fixture.channelID.String())
	require.NoError(t, storageErr)
	assert.NotNil(t, record, "the channel stays indexed so its rent is still recoverable")
}

func TestClaimSettleDistributesTheMeteredAmount(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	response, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 1858), fixture.claimRequirements(1858), nil,
	)
	require.NoError(t, err)

	assert.True(t, response.Success)
	assert.Equal(t, "1858", response.Amount)
	assert.Equal(t, fixture.payerKey.PublicKey().String(), response.Payer)

	sent := signer.sentTransactions()
	require.Len(t, sent, 1)
	programs := instructionPrograms(t, sent[0])
	assert.Equal(t, []solana.PublicKey{
		solana.ComputeBudget, solana.ComputeBudget,
		paymentchannels.Ed25519ProgramID, paymentchannels.ProgramID, paymentchannels.ProgramID,
	}, programs, "the voucher precompile must immediately precede settle_and_seal")
}

func TestClaimSettleSealsAZeroChargeWithoutAPrecompile(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	response, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 0), fixture.claimRequirements(0), nil,
	)
	require.NoError(t, err)

	assert.True(t, response.Success)
	assert.Equal(t, "0", response.Amount)

	sent := signer.sentTransactions()
	require.Len(t, sent, 1)
	assert.Equal(t, []solana.PublicKey{
		solana.ComputeBudget, solana.ComputeBudget, paymentchannels.ProgramID, paymentchannels.ProgramID,
	}, instructionPrograms(t, sent[0]),
		"a zero charge seals at the watermark, which the program rejects with a voucher")
}

// computeBudgetData extracts the SetComputeUnitLimit/SetComputeUnitPrice
// instruction data from a sent transaction's leading ComputeBudget prefix.
func computeBudgetData(t *testing.T, tx *solana.Transaction) (limit uint32, price uint64) {
	t.Helper()
	for _, instruction := range tx.Message.Instructions {
		program, err := tx.Message.Program(instruction.ProgramIDIndex)
		require.NoError(t, err)
		if !program.Equals(solana.ComputeBudget) {
			continue
		}
		switch instruction.Data[0] {
		case paymentchannels.ComputeBudgetSetUnitLimit:
			limit = binary.LittleEndian.Uint32(instruction.Data[1:5])
		case paymentchannels.ComputeBudgetSetUnitPrice:
			price = binary.LittleEndian.Uint64(instruction.Data[1:9])
		}
	}
	return limit, price
}

func TestClaimSettleUsesTheConfiguredComputeBudget(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	settleLimit := uint32(123_456)
	price := uint64(7)
	scheme := newScheme(signer, stub, &Config{
		SettleComputeUnitLimit:        &settleLimit,
		ComputeUnitPriceMicroLamports: &price,
	})
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	_, err := scheme.Settle(context.Background(), fixture.claimPayload(t, 0), fixture.claimRequirements(0), nil)
	require.NoError(t, err)

	sent := signer.sentTransactions()
	require.Len(t, sent, 1)
	limit, gotPrice := computeBudgetData(t, sent[0])
	assert.Equal(t, settleLimit, limit)
	assert.Equal(t, price, gotPrice)
}

func TestClaimSettleOmitsComputeUnitPriceWhenZero(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	price := uint64(0)
	scheme := newScheme(signer, stub, &Config{ComputeUnitPriceMicroLamports: &price})
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	_, err := scheme.Settle(context.Background(), fixture.claimPayload(t, 0), fixture.claimRequirements(0), nil)
	require.NoError(t, err)

	sent := signer.sentTransactions()
	require.Len(t, sent, 1)
	assert.Equal(t, []solana.PublicKey{solana.ComputeBudget, paymentchannels.ProgramID, paymentchannels.ProgramID},
		instructionPrograms(t, sent[0]), "a zero price omits SetComputeUnitPrice but SetComputeUnitLimit is always emitted")
}

// Rent cleanup only sees channels the settle path indexed, so the claim must
// keep the record current instead of relying on the deposit having stored it.
func TestClaimSettleIndexesTheChannelForCleanup(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	_, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 1858), fixture.claimRequirements(1858), nil,
	)
	require.NoError(t, err)

	record, err := scheme.ChannelStorage().Get(context.Background(), fixture.channelID.String())
	require.NoError(t, err)
	require.NotNil(t, record, "an unindexed channel would leak its rent")
	assert.Equal(t, fixture.payTo.String(), record.PayTo)
	assert.Equal(t, solana.TokenProgramID.String(), record.TokenProgram)
	assert.Equal(t, fixture.expiresAt, record.ExpiresAt)
	assert.Equal(t, testNetwork, record.Network)
}

// A deposit must never broadcast without a durable index: an open that
// reaches the chain unindexed can never be found by rent cleanup, so the
// facilitator refuses to broadcast rather than risk stranding its rent.
func TestDepositSettleFailsClosedWhenChannelStorageFails(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	var reported []StoragePhase
	scheme := newScheme(signer, stub, &Config{
		ChannelStorage: failingStorage{},
		OnStorageError: func(_ error, _ string, phase StoragePhase) {
			reported = append(reported, phase)
		},
	})

	_, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)

	assert.Equal(t, ErrChannelBroadcast, settleErrorReason(t, err))
	assert.Equal(t, []StoragePhase{StoragePhaseSettle}, reported)
	assert.Empty(t, signer.sentTransactions(), "nothing may reach the chain without a durable index")
}

// A retry after a transient storage failure must succeed once storage
// recovers: the deposit-scoped dedup key must not have been left in flight.
func TestDepositSettleSucceedsOnRetryAfterAStorageFailure(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	storage := &toggleableStorage{failing: true, inner: NewInMemoryChannelStorage()}
	scheme := newScheme(signer, stub, &Config{ChannelStorage: storage})
	signer.onSend = func(*solana.Transaction) {
		stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))
	}

	_, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)
	require.Error(t, err)

	storage.failing = false
	response, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)

	require.NoError(t, err)
	assert.True(t, response.Success)
}

func TestClaimSettleRejectsAForgedVoucher(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	// A voucher for a smaller amount replayed against a larger charge.
	payload := fixture.withPayload(map[string]interface{}{
		svm.UptoVoucherSignatureField: fixture.voucher(t, 1),
	})

	_, err := scheme.Settle(context.Background(), payload, fixture.claimRequirements(9_000), nil)

	assert.Equal(t, ErrVoucherSignature, settleErrorReason(t, err))
	assert.Empty(t, signer.sentTransactions())
}

func TestClaimSettleRejectsAnUnboundChannel(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)

	tests := []struct {
		name    string
		account func(f *paymentFixture) *channelAccount
	}{
		{
			name:    "channel does not exist",
			account: func(*paymentFixture) *channelAccount { return nil },
		},
		{
			name: "channel already sealed",
			account: func(f *paymentFixture) *channelAccount {
				account := f.openChannel()
				account.Status = paymentchannels.StatusSealed
				return &account
			},
		},
		{
			name: "distribution does not match payTo",
			account: func(f *paymentFixture) *channelAccount {
				account := f.openChannel()
				account.Splits = []paymentchannels.Split{
					{Recipient: solana.SysVarClockPubkey.String(), BPS: paymentchannels.BasisPointsDenominator},
				}
				return &account
			},
		},
		{
			name: "authorized signer rotated onchain",
			account: func(f *paymentFixture) *channelAccount {
				account := f.openChannel()
				account.AuthorizedSigner = solana.SysVarClockPubkey
				return &account
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stub.deleteAccount(fixture.channelID.String())
			if account := test.account(fixture); account != nil {
				stub.setAccount(fixture.channelID.String(), account.encode(t))
			}

			_, err := scheme.Settle(
				context.Background(), fixture.claimPayload(t, 1858), fixture.claimRequirements(1858), nil,
			)

			assert.Equal(t, ErrChannelState, settleErrorReason(t, err))
			assert.Empty(t, signer.sentTransactions())
		})
	}
}

// The voucher is the only authorization for a partial charge, so every field it
// commits to must be bound: the signing key, the channel, and the deadline.
func TestClaimSettleRejectsVoucherBindingTampering(t *testing.T) {
	attacker, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	otherChannel, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)

	tests := []struct {
		name    string
		voucher func(t *testing.T, fixture *paymentFixture) string
	}{
		{
			name: "signed by a key that is not the authorized signer",
			voucher: func(t *testing.T, fixture *paymentFixture) string {
				return fixture.voucherSignedBy(t, attacker, fixture.channelID, 1858, fixture.expiresAt)
			},
		},
		{
			name: "signed for a different channel",
			voucher: func(t *testing.T, fixture *paymentFixture) string {
				return fixture.voucherSignedBy(
					t, fixture.authorizer, otherChannel.PublicKey(), 1858, fixture.expiresAt,
				)
			},
		},
		{
			name: "signed for a different deadline",
			voucher: func(t *testing.T, fixture *paymentFixture) string {
				return fixture.voucherSignedBy(
					t, fixture.authorizer, fixture.channelID, 1858, fixture.expiresAt-3600,
				)
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			signer := newMockSigner(t, 1)
			stub := newStubRPC(t)
			fixture := newPaymentFixture(t, signer)
			scheme := newScheme(signer, stub, nil)
			stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

			payload := fixture.withPayload(map[string]interface{}{
				svm.UptoVoucherSignatureField: test.voucher(t, fixture),
			})

			_, err := scheme.Settle(context.Background(), payload, fixture.claimRequirements(1858), nil)

			assert.Equal(t, ErrVoucherSignature, settleErrorReason(t, err))
			assert.Empty(t, signer.sentTransactions())
		})
	}
}

func TestClaimSettleRejectsMalformedVoucherSignatures(t *testing.T) {
	tests := []struct {
		name    string
		voucher string
	}{
		{name: "not base58", voucher: "not-a-signature!!"},
		{name: "base58 but too short", voucher: solana.PublicKey{}.String()},
		{name: "all zero bytes", voucher: solana.Signature{}.String()},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			signer := newMockSigner(t, 1)
			stub := newStubRPC(t)
			fixture := newPaymentFixture(t, signer)
			scheme := newScheme(signer, stub, nil)
			stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

			payload := fixture.withPayload(map[string]interface{}{
				svm.UptoVoucherSignatureField: test.voucher,
			})

			_, err := scheme.Settle(context.Background(), payload, fixture.claimRequirements(1858), nil)

			assert.Equal(t, ErrVoucherSignature, settleErrorReason(t, err))
			assert.Empty(t, signer.sentTransactions())
		})
	}
}

// The claim path re-checks the authorization window itself rather than trusting
// an earlier verify, so the boundaries are enforced there too.
func TestClaimSettleEnforcesTheAuthorizationWindow(t *testing.T) {
	tests := []struct {
		name      string
		mutate    func(payload map[string]interface{}, now int64) int64
		wantError string
	}{
		{
			name: "expiring exactly now",
			mutate: func(payload map[string]interface{}, now int64) int64 {
				payload["expiresAt"] = now
				return now
			},
			wantError: ErrExpired,
		},
		{
			name: "not yet active",
			mutate: func(payload map[string]interface{}, now int64) int64 {
				payload["validAfter"] = now + 60
				return 0
			},
			wantError: ErrNotYetActive,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			signer := newMockSigner(t, 1)
			stub := newStubRPC(t)
			fixture := newPaymentFixture(t, signer)
			scheme := newScheme(signer, stub, nil)
			stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

			payload := fixture.claimPayload(t, 1858)
			// Re-sign over the mutated deadline so the window, not the
			// signature, is what rejects the claim.
			if expiresAt := test.mutate(payload.Payload, time.Now().Unix()); expiresAt != 0 {
				payload.Payload[svm.UptoVoucherSignatureField] = fixture.voucherSignedBy(
					t, fixture.authorizer, fixture.channelID, 1858, expiresAt,
				)
			}

			_, err := scheme.Settle(context.Background(), payload, fixture.claimRequirements(1858), nil)

			assert.Equal(t, test.wantError, settleErrorReason(t, err))
			assert.Empty(t, signer.sentTransactions())
		})
	}
}

// A client that injects a voucher into a deposit-phase payload is routed to the
// claim path, where the missing channel stops it before anything is broadcast.
func TestDepositSettleIgnoresAnInjectedVoucher(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)

	_, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, fixture.deposit), fixture.requirements, nil,
	)

	assert.Equal(t, ErrChannelState, settleErrorReason(t, err))
	assert.Empty(t, signer.sentTransactions(), "an injected voucher must never open a channel")
}

func TestClaimSettleDeduplicatesPerChannel(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	_, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 1858), fixture.claimRequirements(1858), nil,
	)
	require.NoError(t, err)

	// A different valid amount for the same channel is still a duplicate.
	_, err = scheme.Settle(
		context.Background(), fixture.claimPayload(t, 900), fixture.claimRequirements(900), nil,
	)
	assert.Equal(t, ErrDuplicateSettlement, settleErrorReason(t, err))
	assert.Len(t, signer.sentTransactions(), 1, "only one settle_and_seal reaches the chain")
}

func TestClaimSettleDoesNotCacheRejectedRequests(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	forged := fixture.withPayload(map[string]interface{}{
		svm.UptoVoucherSignatureField: fixture.voucher(t, 1),
	})
	_, err := scheme.Settle(context.Background(), forged, fixture.claimRequirements(9_000), nil)
	require.Error(t, err)

	// The rejected attempt must not block the legitimate claim.
	response, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 1858), fixture.claimRequirements(1858), nil,
	)
	require.NoError(t, err)
	assert.True(t, response.Success)
}

func TestClaimSettleReleasesTheCacheOnBroadcastFailure(t *testing.T) {
	signer := newMockSigner(t, 1)
	signer.sendErr = errors.New("node is behind")
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	_, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 1858), fixture.claimRequirements(1858), nil,
	)
	assert.Equal(t, ErrTransactionFailed, settleErrorReason(t, err))

	signer.sendErr = nil
	response, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 1858), fixture.claimRequirements(1858), nil,
	)
	require.NoError(t, err, "a released cache entry lets the retry proceed")
	assert.True(t, response.Success)
}

func TestDepositCacheDoesNotBlockTheLaterClaim(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)

	signer.onSend = func(*solana.Transaction) {
		stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))
	}

	deposit, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)
	require.NoError(t, err)
	require.True(t, deposit.Success)

	claim, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 1858), fixture.claimRequirements(1858), nil,
	)
	require.NoError(t, err)
	assert.True(t, claim.Success)
	assert.Len(t, signer.sentTransactions(), 2, "the deposit and the claim are separate transactions")
}

func TestClaimSettleRejectsAForeignAuthorizer(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	payload := fixture.withPayload(map[string]interface{}{
		"authorizedSigner":            solana.SysVarClockPubkey.String(),
		svm.UptoVoucherSignatureField: fixture.voucher(t, 1858),
	})

	_, err := scheme.Settle(context.Background(), payload, fixture.claimRequirements(1858), nil)

	assert.Equal(t, ErrReceiverAuthorizer, settleErrorReason(t, err))
}

func TestClaimSettleRejectsAnExpiredAuthorization(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	payload := fixture.claimPayload(t, 1858)
	payload.Payload["expiresAt"] = time.Now().Unix() - 1

	_, err := scheme.Settle(context.Background(), payload, fixture.claimRequirements(1858), nil)

	assert.Equal(t, ErrExpired, settleErrorReason(t, err))
	assert.Empty(t, signer.sentTransactions())
}

func TestSettleSucceedsWhenChannelStorageFails(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	var reported []StoragePhase
	scheme := newScheme(signer, stub, &Config{
		ChannelStorage: failingStorage{},
		OnStorageError: func(_ error, _ string, phase StoragePhase) {
			reported = append(reported, phase)
		},
	})
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	response, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 1858), fixture.claimRequirements(1858), nil,
	)

	require.NoError(t, err, "cleanup bookkeeping never turns a charged payment into a failure")
	assert.True(t, response.Success)
	assert.Equal(t, []StoragePhase{StoragePhaseSettle}, reported)
}

func TestNewRentCleanupManagerSharesTheSchemeStorage(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	scheme := newScheme(signer, stub, nil)

	manager := scheme.NewRentCleanupManager(testNetwork)

	require.NotNil(t, manager)
	assert.Same(t, scheme.ChannelStorage(), manager.storage)

	storage := NewInMemoryChannelStorage()
	injected := newScheme(signer, stub, &Config{ChannelStorage: storage})
	assert.Same(t, storage, injected.ChannelStorage())
	assert.Same(t, storage, injected.NewRentCleanupManager(testNetwork).storage)
}

// failingStorage rejects every write so storage-failure paths can be exercised.
type failingStorage struct{}

func (failingStorage) Get(context.Context, string) (*ChannelRecord, error) {
	return nil, errors.New("storage unavailable")
}

func (failingStorage) List(context.Context) ([]ChannelRecord, error) {
	return nil, errors.New("storage unavailable")
}

func (failingStorage) Upsert(context.Context, ChannelRecord) error {
	return errors.New("storage unavailable")
}

func (failingStorage) Delete(context.Context, string) error {
	return errors.New("storage unavailable")
}

// toggleableStorage lets a test flip storage from failing to healthy between
// two settle calls, to prove a retry is not left permanently blocked.
type toggleableStorage struct {
	failing bool
	inner   *InMemoryChannelStorage
}

func (s *toggleableStorage) Get(ctx context.Context, channelID string) (*ChannelRecord, error) {
	return s.inner.Get(ctx, channelID)
}

func (s *toggleableStorage) List(ctx context.Context) ([]ChannelRecord, error) {
	return s.inner.List(ctx)
}

func (s *toggleableStorage) Upsert(ctx context.Context, record ChannelRecord) error {
	if s.failing {
		return errors.New("storage unavailable")
	}
	return s.inner.Upsert(ctx, record)
}

func (s *toggleableStorage) Delete(ctx context.Context, channelID string) error {
	return s.inner.Delete(ctx, channelID)
}

// instructionPrograms lists the program invoked by each top-level instruction.
func instructionPrograms(t *testing.T, tx *solana.Transaction) []solana.PublicKey {
	t.Helper()
	programs := make([]solana.PublicKey, 0, len(tx.Message.Instructions))
	for _, instruction := range tx.Message.Instructions {
		program, err := tx.Message.Program(instruction.ProgramIDIndex)
		require.NoError(t, err)
		programs = append(programs, program)
	}
	return programs
}
