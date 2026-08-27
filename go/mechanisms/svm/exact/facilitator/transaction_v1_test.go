package facilitator

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// A compute unit limit of 20,000 at the 5,000,000 micro-lamport per-CU cap
// allows a total priority fee of 100,000 lamports.
const (
	v1ComputeUnitLimit   = uint32(20_000)
	v1MaxPriorityFee     = uint64(100_000)
	v1DataSizeLimit      = uint32(65_536)
	v1TransferAmount     = uint64(1000)
	v1TransferDecimals   = uint8(6)
	v1TransferAmountText = "1000"
)

// validV1Config is the config a conformant transaction v1 client produces: both
// required limits set, and a priority fee inside the normalized cap.
func validV1Config() solana.TransactionConfig {
	return solana.TransactionConfig{}.
		WithComputeUnitLimit(v1ComputeUnitLimit).
		WithLoadedAccountsDataSizeLimit(v1DataSizeLimit).
		WithPriorityFee(v1MaxPriorityFee)
}

type v1PayloadOptions struct {
	config solana.TransactionConfig
	// prefix and suffix surround the transfer, which a conformant transaction v1
	// payment leads with.
	prefix []solana.Instruction
	suffix []solana.Instruction
	// splice rewrites the built message before it is serialized, so a test can
	// produce wire bytes the SDK's transaction builder refuses to emit.
	splice func(t *testing.T, tx *solana.Transaction)
	// memo, when set, is pinned in requirements.extra.
	memo string
}

// buildV1Payload assembles an exact-SVM payment as a transaction v1 message.
// The payer differs from the facilitator's fee payer so the
// fee-payer-transferring-funds guard doesn't trip.
func buildV1Payload(
	t *testing.T,
	opts v1PayloadOptions,
) (types.PaymentPayload, types.PaymentRequirements, solana.PublicKey, solana.PublicKey) {
	t.Helper()

	facilitatorAddr := solana.NewWallet().PrivateKey.PublicKey()
	ownerWallet := solana.NewWallet()
	owner := ownerWallet.PrivateKey.PublicKey()
	mint := solana.NewWallet().PrivateKey.PublicKey()
	payTo := solana.NewWallet().PrivateKey.PublicKey()

	sourceATA, _, err := solana.FindAssociatedTokenAddress(owner, mint)
	require.NoError(t, err)
	destATA, _, err := solana.FindAssociatedTokenAddress(payTo, mint)
	require.NoError(t, err)

	transferIx, err := token.NewTransferCheckedInstructionBuilder().
		SetAmount(v1TransferAmount).
		SetDecimals(v1TransferDecimals).
		SetSourceAccount(sourceATA).
		SetMintAccount(mint).
		SetDestinationAccount(destATA).
		SetOwnerAccount(owner).
		ValidateAndBuild()
	require.NoError(t, err)

	instructions := append([]solana.Instruction{}, opts.prefix...)
	instructions = append(instructions, transferIx)
	instructions = append(instructions, opts.suffix...)

	tx, err := solana.NewTransaction(
		instructions,
		solana.Hash{},
		solana.TransactionPayer(facilitatorAddr),
		solana.TransactionV1Config(opts.config),
	)
	require.NoError(t, err)
	if opts.splice != nil {
		opts.splice(t, tx)
	}
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
	signTransaction(t, tx, ownerWallet.PrivateKey)

	wire, err := tx.MarshalBinary()
	require.NoError(t, err)

	requirements := types.PaymentRequirements{
		Scheme:  svm.SchemeExact,
		Network: svm.SolanaDevnetCAIP2,
		Asset:   mint.String(),
		Amount:  v1TransferAmountText,
		PayTo:   payTo.String(),
		Extra: map[string]interface{}{
			"feePayer": facilitatorAddr.String(),
		},
	}
	if opts.memo != "" {
		requirements.Extra["memo"] = opts.memo
	}
	payload := types.PaymentPayload{
		X402Version: 2,
		Payload: (&svm.ExactSvmPayload{
			Transaction: base64.StdEncoding.EncodeToString(wire),
		}).ToMap(),
		Accepted: requirements,
	}
	return payload, requirements, facilitatorAddr, owner
}

func memoInstruction(data string) solana.Instruction {
	return solana.NewInstruction(
		solana.MustPublicKeyFromBase58(svm.MemoProgramAddress),
		solana.AccountMetaSlice{},
		[]byte(data),
	)
}

// spliceComputeBudgetInstruction inserts a ComputeBudget instruction into an
// already-built transaction v1 message. solana-go's builder refuses to put one
// in a v1 transaction, but a client writes its own wire bytes, so the
// facilitator has to reject the decoded message rather than trust a builder.
// The program is appended as a read-only unsigned account, which is the last
// section of the key list, so existing instruction indices still resolve.
func spliceComputeBudgetInstruction(index int) func(*testing.T, *solana.Transaction) {
	return func(t *testing.T, tx *solana.Transaction) {
		t.Helper()
		programIndex := len(tx.Message.AccountKeys)
		tx.Message.AccountKeys = append(tx.Message.AccountKeys, solana.ComputeBudget)
		tx.Message.Header.NumReadonlyUnsignedAccounts++

		compiled := solana.CompiledInstruction{
			ProgramIDIndex: uint16(programIndex),
			Data:           []byte{2, 160, 134, 1, 0},
		}
		spliced := append([]solana.CompiledInstruction{}, tx.Message.Instructions[:index]...)
		spliced = append(spliced, compiled)
		tx.Message.Instructions = append(spliced, tx.Message.Instructions[index:]...)
	}
}

func verifyV1(t *testing.T, opts v1PayloadOptions) (*x402.VerifyResponse, solana.PublicKey, error) {
	t.Helper()
	payload, requirements, facilitatorAddr, owner := buildV1Payload(t, opts)
	scheme := NewExactSvmScheme(&mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr}})
	resp, err := scheme.Verify(context.Background(), payload, requirements, nil)
	return resp, owner, err
}

func requireInvalidReason(t *testing.T, err error, want string) {
	t.Helper()
	var ve *x402.VerifyError
	require.True(t, errors.As(err, &ve), "expected a VerifyError, got %v", err)
	assert.Equal(t, want, ve.InvalidReason)
}

func TestExactSvmSchemeAcceptsATransactionV1Transfer(t *testing.T) {
	resp, owner, err := verifyV1(t, v1PayloadOptions{config: validV1Config()})

	require.NoError(t, err)
	assert.True(t, resp.IsValid)
	assert.Equal(t, owner.String(), resp.Payer)
}

func TestExactSvmSchemeAcceptsATransactionV1TransferWithOptionalInstructions(t *testing.T) {
	tests := []struct {
		name   string
		suffix []solana.Instruction
	}{
		{name: "trailing memo", suffix: []solana.Instruction{memoInstruction("unique-nonce")}},
		{name: "trailing lighthouse", suffix: []solana.Instruction{lighthouseInstruction()}},
		{
			name: "the full optional window",
			suffix: []solana.Instruction{
				lighthouseInstruction(), lighthouseInstruction(),
				lighthouseInstruction(), memoInstruction("unique-nonce"),
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			resp, _, err := verifyV1(t, v1PayloadOptions{config: validV1Config(), suffix: test.suffix})

			require.NoError(t, err)
			assert.True(t, resp.IsValid)
		})
	}
}

func TestExactSvmSchemeRejectsATransactionV1ConfigViolation(t *testing.T) {
	tests := []struct {
		name   string
		config solana.TransactionConfig
		want   string
	}{
		{
			name:   "no config at all",
			config: solana.TransactionConfig{},
			want:   ErrV1ConfigComputeLimitMissing,
		},
		{
			name: "no compute unit limit",
			config: solana.TransactionConfig{}.
				WithLoadedAccountsDataSizeLimit(v1DataSizeLimit).
				WithPriorityFee(1),
			want: ErrV1ConfigComputeLimitMissing,
		},
		{
			name: "no loaded accounts data size limit",
			config: solana.TransactionConfig{}.
				WithComputeUnitLimit(v1ComputeUnitLimit).
				WithPriorityFee(1),
			want: ErrV1ConfigLoadedAccountsDataSizeLimitMissing,
		},
		{
			name:   "a priority fee one lamport over the normalized cap",
			config: validV1Config().WithPriorityFee(v1MaxPriorityFee + 1),
			want:   ErrV1ConfigPriorityFeeTooHigh,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, _, err := verifyV1(t, v1PayloadOptions{config: test.config})

			requireInvalidReason(t, err, test.want)
		})
	}
}

// The per-CU cap becomes a total-lamport ceiling once normalized against the
// declared compute unit limit, so the transaction at exactly the ceiling must be
// accepted and the one a single lamport above it rejected.
func TestExactSvmSchemeNormalizesTheTransactionV1PriorityFee(t *testing.T) {
	atCap, _, err := verifyV1(t, v1PayloadOptions{config: validV1Config().WithPriorityFee(v1MaxPriorityFee)})
	require.NoError(t, err)
	assert.True(t, atCap.IsValid)

	_, _, err = verifyV1(t, v1PayloadOptions{config: validV1Config().WithPriorityFee(v1MaxPriorityFee + 1)})
	requireInvalidReason(t, err, ErrV1ConfigPriorityFeeTooHigh)

	// A larger compute unit limit buys proportionally more total fee.
	widened := solana.TransactionConfig{}.
		WithComputeUnitLimit(v1ComputeUnitLimit * 2).
		WithLoadedAccountsDataSizeLimit(v1DataSizeLimit).
		WithPriorityFee(v1MaxPriorityFee * 2)
	resp, _, err := verifyV1(t, v1PayloadOptions{config: widened})
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
}

// A ComputeBudget instruction has no place in a transaction whose budget is
// declared in the message config: it can only be there to satisfy a check that
// scans instructions. The layout rules are what reject it.
func TestExactSvmSchemeRejectsComputeBudgetInstructionsInsideTransactionV1(t *testing.T) {
	t.Run("after the transfer", func(t *testing.T) {
		_, _, err := verifyV1(t, v1PayloadOptions{
			config: validV1Config(),
			splice: spliceComputeBudgetInstruction(1),
		})

		requireInvalidReason(t, err, ErrUnknownOptionalInstruction)
	})

	t.Run("before the transfer", func(t *testing.T) {
		_, _, err := verifyV1(t, v1PayloadOptions{
			config: validV1Config(),
			splice: spliceComputeBudgetInstruction(0),
		})

		requireInvalidReason(t, err, ErrNoTransferInstruction)
	})
}

func TestExactSvmSchemeEnforcesTheTransactionV1InstructionWindow(t *testing.T) {
	_, _, err := verifyV1(t, v1PayloadOptions{
		config: validV1Config(),
		suffix: []solana.Instruction{
			lighthouseInstruction(), lighthouseInstruction(),
			lighthouseInstruction(), lighthouseInstruction(),
			memoInstruction("unique-nonce"),
		},
	})

	requireInvalidReason(t, err, ErrTransactionInstructionsLength)
}

// On transaction v1 the transfer leads the instruction list, so anything else at
// index 0 is not the payment the requirements describe.
func TestExactSvmSchemeRejectsATransactionV1WithoutTheTransferFirst(t *testing.T) {
	_, _, err := verifyV1(t, v1PayloadOptions{
		config: validV1Config(),
		prefix: []solana.Instruction{memoInstruction("first")},
	})

	requireInvalidReason(t, err, ErrNoTransferInstruction)
}

func TestExactSvmSchemeVerifiesTheTransactionV1Memo(t *testing.T) {
	t.Run("matching memo", func(t *testing.T) {
		resp, _, err := verifyV1(t, v1PayloadOptions{
			config: validV1Config(),
			suffix: []solana.Instruction{memoInstruction("order-1")},
			memo:   "order-1",
		})

		require.NoError(t, err)
		assert.True(t, resp.IsValid)
	})

	t.Run("mismatched memo", func(t *testing.T) {
		_, _, err := verifyV1(t, v1PayloadOptions{
			config: validV1Config(),
			suffix: []solana.Instruction{memoInstruction("order-2")},
			memo:   "order-1",
		})

		requireInvalidReason(t, err, ErrMemoMismatch)
	})
}

// Settle re-verifies, keys its dedup entry on the message hash and reads the fee
// payer out of the static account keys; all three must work on a v1 message.
func TestExactSvmSchemeSettlesATransactionV1Transfer(t *testing.T) {
	payload, requirements, facilitatorAddr, owner := buildV1Payload(t, v1PayloadOptions{config: validV1Config()})
	wantSig := solana.SignatureFromBytes(append([]byte{7}, make([]byte, 63)...))
	signer := &mockExactSvmSigner{
		addresses:     []solana.PublicKey{facilitatorAddr},
		sendSignature: wantSig,
	}
	scheme := NewExactSvmScheme(signer)

	resp, err := scheme.Settle(context.Background(), payload, requirements, nil)

	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, wantSig.String(), resp.Transaction)
	assert.Equal(t, owner.String(), resp.Payer)
	assert.Equal(t, 1, signer.sendCalls)
}

func TestExactSvmSchemeSettleRejectsATransactionV1ConfigViolation(t *testing.T) {
	payload, requirements, facilitatorAddr, _ := buildV1Payload(t, v1PayloadOptions{
		config: validV1Config().WithPriorityFee(v1MaxPriorityFee + 1),
	})
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmScheme(signer)

	_, err := scheme.Settle(context.Background(), payload, requirements, nil)

	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrV1ConfigPriorityFeeTooHigh, se.ErrorReason)
	assert.Equal(t, 0, signer.sendCalls, "a config violation must never be broadcast")
}

// Widening the version allowlist must not have moved the legacy and v0 layout,
// which keeps its ComputeBudget prefix and its transfer at index 2.
func TestExactSvmSchemeStillAcceptsTheVersion0Layout(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	scheme := NewExactSvmScheme(&mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr}})

	resp, err := scheme.Verify(context.Background(), payload, requirements, nil)

	require.NoError(t, err)
	assert.True(t, resp.IsValid)
}

// The smart wallet caps default to 400,000 CU and 50,000 micro-lamports per CU,
// which over 20,000 CUs normalizes to a 1,000 lamport total priority fee.
const (
	v1SmartWalletMaxCU          = uint32(400_000)
	v1SmartWalletMaxPerCU       = uint64(50_000)
	v1SmartWalletMaxPriorityFee = uint64(1_000)
)

func v1TransactionWithConfig(
	t *testing.T,
	config solana.TransactionConfig,
	instructions ...solana.Instruction,
) *solana.Transaction {
	t.Helper()
	tx, err := solana.NewTransaction(
		instructions,
		solana.Hash{},
		solana.TransactionPayer(solana.NewWallet().PrivateKey.PublicKey()),
		solana.TransactionV1Config(config),
	)
	require.NoError(t, err)
	return tx
}

// The smart wallet path reads the compute budget from the same message config as
// the static path, under its own caps. Without this the instruction scan finds no
// ComputeBudget instruction in a v1 transaction and passes vacuously, leaving the
// facilitator's compute and priority fee exposure unbounded.
func TestValidateComputeBudgetLimitsOnTransactionV1(t *testing.T) {
	withinCaps := solana.TransactionConfig{}.
		WithComputeUnitLimit(v1ComputeUnitLimit).
		WithLoadedAccountsDataSizeLimit(v1DataSizeLimit).
		WithPriorityFee(v1SmartWalletMaxPriorityFee)

	tests := []struct {
		name   string
		config solana.TransactionConfig
		want   string
	}{
		{name: "a config within the caps", config: withinCaps},
		{
			name:   "no config at all",
			config: solana.TransactionConfig{},
			want:   ErrSmartWalletComputeUnitLimitMissing,
		},
		{
			name: "no loaded accounts data size limit",
			config: solana.TransactionConfig{}.
				WithComputeUnitLimit(v1ComputeUnitLimit),
			want: ErrSmartWalletLoadedAccountsDataSizeLimitMissing,
		},
		{
			name: "a compute unit limit above the cap",
			config: solana.TransactionConfig{}.
				WithComputeUnitLimit(v1SmartWalletMaxCU + 1).
				WithLoadedAccountsDataSizeLimit(v1DataSizeLimit),
			want: ErrSmartWalletComputeUnitsTooHigh,
		},
		{
			name:   "a priority fee one lamport above the normalized cap",
			config: withinCaps.WithPriorityFee(v1SmartWalletMaxPriorityFee + 1),
			want:   ErrSmartWalletPriorityFeeTooHigh,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tx := v1TransactionWithConfig(t, test.config, memoInstruction("payment"))

			err := validateComputeBudgetLimits(tx, v1SmartWalletMaxCU, v1SmartWalletMaxPerCU)

			if test.want == "" {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), test.want)
		})
	}
}

func TestValidateComputeBudgetLimitsRejectsComputeBudgetInsideTransactionV1(t *testing.T) {
	tx := v1TransactionWithConfig(
		t,
		solana.TransactionConfig{}.
			WithComputeUnitLimit(v1ComputeUnitLimit).
			WithLoadedAccountsDataSizeLimit(v1DataSizeLimit),
		memoInstruction("payment"),
	)
	spliceComputeBudgetInstruction(0)(t, tx)

	err := validateComputeBudgetLimits(tx, v1SmartWalletMaxCU, v1SmartWalletMaxPerCU)

	require.Error(t, err)
	assert.Contains(t, err.Error(), ErrSmartWalletUnsupportedComputeBudget)
}
