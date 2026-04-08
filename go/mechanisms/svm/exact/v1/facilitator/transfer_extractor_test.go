package facilitator

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	x402 "github.com/x402-foundation/x402/go"
	svm "github.com/x402-foundation/x402/go/mechanisms/svm"
	"github.com/x402-foundation/x402/go/types"
)

const testWrappedTransferBlockhashV1 = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF"

type mockFacilitatorSigner struct {
	addresses []solana.PublicKey
}

func (m *mockFacilitatorSigner) GetAddresses(context.Context, string) []solana.PublicKey {
	return m.addresses
}

func (m *mockFacilitatorSigner) SignTransaction(context.Context, *solana.Transaction, solana.PublicKey, string) error {
	return nil
}

func (m *mockFacilitatorSigner) SimulateTransaction(context.Context, *solana.Transaction, string) error {
	return nil
}

func (m *mockFacilitatorSigner) SendTransaction(context.Context, *solana.Transaction, string) (solana.Signature, error) {
	return solana.Signature{}, nil
}

func (m *mockFacilitatorSigner) ConfirmTransaction(context.Context, solana.Signature, string) error {
	return nil
}

func wrappedTransferExtractor(wrapperProgram solana.PublicKey) svm.TransferExtractor {
	return func(tx *solana.Transaction, inst solana.CompiledInstruction) (*svm.TransferDetails, error) {
		if tx.Message.AccountKeys[inst.ProgramIDIndex] != wrapperProgram {
			return nil, svm.ErrTransferNotRecognized
		}

		accounts, err := inst.ResolveInstructionAccounts(&tx.Message)
		if err != nil {
			return nil, err
		}
		if len(accounts) < 4 || len(inst.Data) < 8 {
			return nil, svm.ErrTransferNotRecognized
		}

		return &svm.TransferDetails{
			ProgramID:   solana.TokenProgramID,
			Source:      accounts[0].PublicKey,
			Mint:        accounts[1].PublicKey,
			Destination: accounts[2].PublicKey,
			Authority:   accounts[3].PublicKey,
			Amount:      binary.LittleEndian.Uint64(inst.Data[:8]),
		}, nil
	}
}

func buildWrappedTransferPayloadV1(
	t *testing.T,
	wrapperProgram solana.PublicKey,
	authority solana.PrivateKey,
	feePayer solana.PrivateKey,
	mint solana.PublicKey,
	payTo solana.PublicKey,
	amount uint64,
) (types.PaymentPayloadV1, types.PaymentRequirementsV1) {
	t.Helper()

	sourceATA, _, err := solana.FindAssociatedTokenAddress(authority.PublicKey(), mint)
	require.NoError(t, err)

	destinationATA, _, err := solana.FindAssociatedTokenAddress(payTo, mint)
	require.NoError(t, err)

	cuLimit, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().
		SetUnits(svm.DefaultComputeUnitLimit).
		ValidateAndBuild()
	require.NoError(t, err)

	cuPrice, err := computebudget.NewSetComputeUnitPriceInstructionBuilder().
		SetMicroLamports(svm.DefaultComputeUnitPriceMicrolamports).
		ValidateAndBuild()
	require.NoError(t, err)

	amountData := make([]byte, 8)
	binary.LittleEndian.PutUint64(amountData, amount)

	wrappedTransfer := solana.NewInstruction(
		wrapperProgram,
		solana.AccountMetaSlice{
			{PublicKey: sourceATA, IsWritable: true},
			{PublicKey: mint},
			{PublicKey: destinationATA, IsWritable: true},
			{PublicKey: authority.PublicKey(), IsSigner: true},
		},
		amountData,
	)

	tx, err := solana.NewTransactionBuilder().
		AddInstruction(cuLimit).
		AddInstruction(cuPrice).
		AddInstruction(wrappedTransfer).
		SetRecentBlockHash(solana.MustHashFromBase58(testWrappedTransferBlockhashV1)).
		SetFeePayer(feePayer.PublicKey()).
		Build()
	require.NoError(t, err)

	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(authority.PublicKey()) {
			return &authority
		}
		if key.Equals(feePayer.PublicKey()) {
			return &feePayer
		}
		return nil
	})
	require.NoError(t, err)

	encodedTx, err := svm.EncodeTransaction(tx)
	require.NoError(t, err)

	extraJSON, err := json.Marshal(map[string]interface{}{
		"feePayer": feePayer.PublicKey().String(),
	})
	require.NoError(t, err)

	payload := types.PaymentPayloadV1{
		X402Version: 1,
		Scheme:      svm.SchemeExact,
		Network:     "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
		Payload: map[string]interface{}{
			"transaction": encodedTx,
		},
	}

	requirements := types.PaymentRequirementsV1{
		Scheme:            svm.SchemeExact,
		Network:           "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
		MaxAmountRequired: "1000000",
		Resource:          "https://example.com/paid",
		PayTo:             payTo.String(),
		MaxTimeoutSeconds: 300,
		Asset:             mint.String(),
		Extra:             (*json.RawMessage)(&extraJSON),
	}

	return payload, requirements
}

func TestVerifySupportsRegisteredTransferExtractorsV1(t *testing.T) {
	authority := solana.NewWallet().PrivateKey
	feePayer := solana.NewWallet().PrivateKey
	payTo := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	wrapperProgram := solana.NewWallet().PublicKey()

	payload, requirements := buildWrappedTransferPayloadV1(t, wrapperProgram, authority, feePayer, mint, payTo, 1_000_000)

	scheme := NewExactSvmSchemeV1(&mockFacilitatorSigner{
		addresses: []solana.PublicKey{feePayer.PublicKey()},
	})

	_, err := scheme.Verify(context.Background(), payload, requirements, nil)
	require.Error(t, err)

	var verifyErr *x402.VerifyError
	require.True(t, errors.As(err, &verifyErr))
	assert.Equal(t, ErrNoTransferInstruction, verifyErr.InvalidReason)

	scheme.RegisterTransferExtractor(wrappedTransferExtractor(wrapperProgram))

	response, err := scheme.Verify(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.True(t, response.IsValid)
	assert.Equal(t, authority.PublicKey().String(), response.Payer)
}
