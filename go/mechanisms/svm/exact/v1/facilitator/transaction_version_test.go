package facilitator

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

func v1MessageConfig() solana.TransactionConfig {
	return solana.TransactionConfig{}.
		WithComputeUnitLimit(svm.DefaultComputeUnitLimit).
		WithLoadedAccountsDataSizeLimit(svm.DefaultLoadedAccountsDataSizeLimit).
		WithPriorityFee(1)
}

// buildMessageV1Fixture builds a signed transaction-v1 exact payment for the
// legacy x402 v1 protocol: prefix, the TransferChecked, then extra.
func buildMessageV1Fixture(t *testing.T, config solana.TransactionConfig, prefix []solana.Instruction, extra ...solana.Instruction) (types.PaymentPayloadV1, types.PaymentRequirementsV1, solana.PublicKey, *solana.Transaction) {
	t.Helper()
	facilitatorAddr := solana.NewWallet().PublicKey()
	ownerWallet := solana.NewWallet()
	owner := ownerWallet.PublicKey()
	mint := solana.NewWallet().PublicKey()
	payTo := solana.NewWallet().PublicKey()
	sourceATA, _, err := solana.FindAssociatedTokenAddress(owner, mint)
	require.NoError(t, err)
	destATA, _, err := solana.FindAssociatedTokenAddress(payTo, mint)
	require.NoError(t, err)
	transferIx, err := token.NewTransferCheckedInstructionBuilder().
		SetAmount(1000).SetDecimals(6).
		SetSourceAccount(sourceATA).SetMintAccount(mint).
		SetDestinationAccount(destATA).SetOwnerAccount(owner).
		ValidateAndBuild()
	require.NoError(t, err)
	blockhash, err := solana.HashFromBase58("5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF")
	require.NoError(t, err)

	builder := solana.NewTransactionBuilder()
	for _, ix := range prefix {
		builder.AddInstruction(ix)
	}
	builder.AddInstruction(transferIx)
	for _, ix := range extra {
		builder.AddInstruction(ix)
	}
	tx, err := builder.SetRecentBlockHash(blockhash).SetFeePayer(facilitatorAddr).Build()
	require.NoError(t, err)
	_, err = tx.Message.SetVersion(solana.MessageVersionV1)
	require.NoError(t, err)
	tx.Message.TransactionConfig = config
	signV1Tx(t, tx, ownerWallet.PrivateKey)

	encoded, err := svm.EncodeTransaction(tx)
	require.NoError(t, err)
	extraJSON, err := json.Marshal(map[string]string{"feePayer": facilitatorAddr.String()})
	require.NoError(t, err)
	raw := json.RawMessage(extraJSON)
	requirements := types.PaymentRequirementsV1{
		Scheme:            svm.SchemeExact,
		Network:           "solana-devnet",
		Asset:             mint.String(),
		MaxAmountRequired: "1000",
		PayTo:             payTo.String(),
		Extra:             &raw,
	}
	payload := types.PaymentPayloadV1{
		X402Version: 1,
		Scheme:      svm.SchemeExact,
		Network:     "solana-devnet",
		Payload:     (&svm.ExactSvmPayload{Transaction: encoded}).ToMap(),
	}
	return payload, requirements, facilitatorAddr, tx
}

func futureVersionTransaction(t *testing.T) string {
	t.Helper()
	_, _, _, tx := buildMessageV1Fixture(t, v1MessageConfig(), nil)
	raw, err := tx.MarshalBinary()
	require.NoError(t, err)
	require.Equal(t, byte(0x81), raw[0])
	raw[0] = 0x82
	return base64.StdEncoding.EncodeToString(raw)
}

func TestExactSvmSchemeV1_GetExtraAdvertisesTransactionVersions(t *testing.T) {
	addr := solana.NewWallet().PublicKey()
	scheme := NewExactSvmSchemeV1(&mockV1Signer{addresses: []solana.PublicKey{addr}})

	extra := scheme.GetExtra(x402.Network(svm.SolanaDevnetCAIP2))
	assert.Equal(t, addr.String(), extra["feePayer"])
	assert.Equal(t, []int{0, 1}, extra[svm.ExtraTransactionVersions])
}

func TestExactSvmSchemeV1_VerifyRejectsUnknownTransactionVersion(t *testing.T) {
	payload, requirements, facilitatorAddr, _, _ := buildV1Fixture(t)
	payload.Payload = (&svm.ExactSvmPayload{Transaction: futureVersionTransaction(t)}).ToMap()

	signer := &mockV1Signer{addresses: []solana.PublicKey{facilitatorAddr}}
	_, err := NewExactSvmSchemeV1(signer).Verify(context.Background(), payload, requirements, nil)
	var ve *x402.VerifyError
	require.True(t, errors.As(err, &ve), "%v", err)
	assert.Equal(t, ErrUnsupportedTransactionVersion, ve.InvalidReason)
	assert.Contains(t, ve.InvalidMessage, "version 2")
	assert.Equal(t, 0, signer.signCalls)
	assert.Equal(t, 0, signer.simulateCalls)
}

func TestExactSvmSchemeV1_SettleRejectsUnknownTransactionVersion(t *testing.T) {
	payload, requirements, facilitatorAddr, _, _ := buildV1Fixture(t)
	payload.Payload = (&svm.ExactSvmPayload{Transaction: futureVersionTransaction(t)}).ToMap()

	signer := &mockV1Signer{addresses: []solana.PublicKey{facilitatorAddr}}
	_, err := NewExactSvmSchemeV1(signer).Settle(context.Background(), payload, requirements, nil)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se), "%v", err)
	assert.Equal(t, ErrUnsupportedTransactionVersion, se.ErrorReason)
	assert.Contains(t, se.ErrorMessage, "version 2")
	assert.Equal(t, 0, signer.signCalls)
}

func TestExactSvmSchemeV1_VerifyAcceptsTransactionVersion1(t *testing.T) {
	memo := solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.MemoProgramAddress), solana.AccountMetaSlice{}, []byte("nonce"))
	for _, extra := range [][]solana.Instruction{nil, {memo}} {
		payload, requirements, facilitatorAddr, _ := buildMessageV1Fixture(t, v1MessageConfig(), nil, extra...)
		signer := &mockV1Signer{addresses: []solana.PublicKey{facilitatorAddr}}
		resp, err := NewExactSvmSchemeV1(signer).Verify(context.Background(), payload, requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.IsValid)
		assert.Equal(t, 1, signer.simulateCalls)
	}
}

func TestExactSvmSchemeV1_VerifyRejectsTransactionVersion1Violations(t *testing.T) {
	cuLimit, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().SetUnits(20_000).ValidateAndBuild()
	require.NoError(t, err)
	atCap := uint64(svm.MaxComputeUnitPriceMicrolamports) * uint64(svm.DefaultComputeUnitLimit) / 1_000_000
	tests := []struct {
		name   string
		config solana.TransactionConfig
		prefix []solana.Instruction
		reason string
	}{
		{name: "ComputeBudget instruction", config: v1MessageConfig(), prefix: []solana.Instruction{cuLimit}, reason: ErrTransactionV1ComputeBudgetIx},
		{name: "computeUnitLimit unset", config: solana.TransactionConfig{}.WithLoadedAccountsDataSizeLimit(1), reason: ErrComputeLimitInstruction},
		{name: "loadedAccountsDataSizeLimit unset", config: solana.TransactionConfig{}.WithComputeUnitLimit(20_000), reason: ErrLoadedAccountsDataSizeLimitMissing},
		{name: "heap size", config: v1MessageConfig().WithHeapSize(64 * 1024), reason: ErrTransactionV1HeapSize},
		{name: "priorityFee over the cap", config: v1MessageConfig().WithPriorityFee(atCap + 1), reason: ErrComputePriceInstructionTooHigh},
		{name: "priorityFee near u64 max", config: v1MessageConfig().WithPriorityFee(math.MaxUint64), reason: ErrComputePriceInstructionTooHigh},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload, requirements, facilitatorAddr, _ := buildMessageV1Fixture(t, test.config, test.prefix)
			signer := &mockV1Signer{addresses: []solana.PublicKey{facilitatorAddr}}
			_, err := NewExactSvmSchemeV1(signer).Verify(context.Background(), payload, requirements, nil)
			var ve *x402.VerifyError
			require.True(t, errors.As(err, &ve), "%v", err)
			assert.Equal(t, test.reason, ve.InvalidReason)
			assert.Equal(t, 0, signer.simulateCalls)
		})
	}

	t.Run("priorityFee at the cap is accepted", func(t *testing.T) {
		payload, requirements, facilitatorAddr, _ := buildMessageV1Fixture(t, v1MessageConfig().WithPriorityFee(atCap), nil)
		resp, err := NewExactSvmSchemeV1(&mockV1Signer{addresses: []solana.PublicKey{facilitatorAddr}}).Verify(context.Background(), payload, requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.IsValid)
	})
}

func TestExactSvmSchemeV1_VerifyEnforcesTheVersion1SizeLimit(t *testing.T) {
	memo := func(n int) solana.Instruction {
		return solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.MemoProgramAddress), solana.AccountMetaSlice{}, []byte(strings.Repeat("a", n)))
	}
	_, _, _, probe := buildMessageV1Fixture(t, v1MessageConfig(), nil, memo(500))
	raw, err := probe.MarshalBinary()
	require.NoError(t, err)
	for _, test := range []struct {
		size     int
		accepted bool
	}{
		{svm.MaxTransactionSizeV1, true},
		{svm.MaxTransactionSizeV1 + 1, false},
	} {
		payload, requirements, facilitatorAddr, tx := buildMessageV1Fixture(t, v1MessageConfig(), nil, memo(500+test.size-len(raw)))
		sized, err := tx.MarshalBinary()
		require.NoError(t, err)
		require.Len(t, sized, test.size)
		signer := &mockV1Signer{addresses: []solana.PublicKey{facilitatorAddr}}
		resp, err := NewExactSvmSchemeV1(signer).Verify(context.Background(), payload, requirements, nil)
		if test.accepted {
			require.NoError(t, err)
			assert.True(t, resp.IsValid)
			continue
		}
		var verifyErr *x402.VerifyError
		require.True(t, errors.As(err, &verifyErr), "%v", err)
		assert.Equal(t, ErrTransactionSizeExceeded, verifyErr.InvalidReason)
		assert.Zero(t, signer.simulateCalls)
	}
}

func TestExactSvmSchemeV1_ConfiguredTransactionVersions(t *testing.T) {
	payload, requirements, facilitatorAddr, _ := buildMessageV1Fixture(t, v1MessageConfig(), nil)
	signer := &mockV1Signer{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmSchemeV1WithConfig(signer, &Config{TransactionVersions: []int{0}})

	extra := scheme.GetExtra(x402.Network(svm.SolanaDevnetCAIP2))
	assert.Equal(t, []int{0}, extra[svm.ExtraTransactionVersions])

	_, err := scheme.Verify(context.Background(), payload, requirements, nil)
	var ve *x402.VerifyError
	require.True(t, errors.As(err, &ve), "%v", err)
	assert.Equal(t, ErrUnsupportedTransactionVersion, ve.InvalidReason)

	_, err = scheme.Settle(context.Background(), payload, requirements, nil)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se), "%v", err)
	assert.Equal(t, ErrUnsupportedTransactionVersion, se.ErrorReason)
	assert.Equal(t, 0, signer.signCalls)

	assert.Panics(t, func() {
		NewExactSvmSchemeV1WithConfig(signer, &Config{TransactionVersions: []int{}})
	})
}
