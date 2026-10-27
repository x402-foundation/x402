package facilitator

import (
	"context"
	"errors"
	"fmt"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

const recipientSimulationMessage = "Transaction simulation failed: InvalidAccountData"

type recipientDiagnosticSigner struct {
	mockSmartWalletSigner
	simulationErr error
	innerCalls    int
}

func (s *recipientDiagnosticSigner) SimulateTransaction(context.Context, *solana.Transaction, string, *svm.FacilitatorSimulateTransactionOptions) error {
	s.simulateCalls++
	return s.simulationErr
}

func (s *recipientDiagnosticSigner) SimulateTransactionWithInnerInstructions(context.Context, *solana.Transaction, string) ([]rpc.InnerInstruction, error) {
	s.innerCalls++
	return nil, errors.New("unexpected smart-wallet fallback")
}

type recipientAccountRead struct {
	account    solana.PublicKey
	network    string
	commitment rpc.CommitmentType
}

type recipientAccountSigner struct {
	*recipientDiagnosticSigner
	account *rpc.GetAccountInfoResult
	readErr error
	reads   []recipientAccountRead
}

func (s *recipientAccountSigner) GetAccountInfo(_ context.Context, account solana.PublicKey, network string, opts *rpc.GetAccountInfoOpts) (*rpc.GetAccountInfoResult, error) {
	s.reads = append(s.reads, recipientAccountRead{account: account, network: network, commitment: opts.Commitment})
	return s.account, s.readErr
}

func recipientFixture(t *testing.T, program solana.PublicKey) exactFixture {
	t.Helper()
	f := buildExactFixture(t)
	if program == solana.TokenProgramID {
		return f
	}
	source, err := findATA(f.ownerKey.PublicKey(), f.mint, solana.TokenProgramID)
	require.NoError(t, err)
	newSource, err := findATA(f.ownerKey.PublicKey(), f.mint, program)
	require.NoError(t, err)
	newDestination, err := findATA(f.payTo, f.mint, program)
	require.NoError(t, err)
	for i, key := range f.tx.Message.AccountKeys {
		switch key {
		case solana.TokenProgramID:
			f.tx.Message.AccountKeys[i] = program
		case source:
			f.tx.Message.AccountKeys[i] = newSource
		case f.destATA:
			f.tx.Message.AccountKeys[i] = newDestination
		}
	}
	f.destATA = newDestination
	signTransaction(t, f.tx, f.ownerKey)
	encoded, err := svm.EncodeTransaction(f.tx)
	require.NoError(t, err)
	f.payload.Payload["transaction"] = encoded
	return f
}

func newRecipientSigner(f exactFixture) *recipientDiagnosticSigner {
	return &recipientDiagnosticSigner{
		mockSmartWalletSigner: mockSmartWalletSigner{
			mockExactSvmSigner: mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}},
		},
		simulationErr: errors.New(recipientSimulationMessage),
	}
}

func assertRecipientNoSettlement(t *testing.T, s *recipientDiagnosticSigner) {
	t.Helper()
	assert.Zero(t, s.signCalls)
	assert.Zero(t, s.sendCalls)
	assert.Zero(t, s.confirmCalls)
	assert.Zero(t, s.innerCalls)
}

func TestRecipientATADiagnostics(t *testing.T) {
	for _, program := range []solana.PublicKey{solana.TokenProgramID, solana.Token2022ProgramID} {
		t.Run(program.String(), func(t *testing.T) {
			f := recipientFixture(t, program)
			owned := func(owner solana.PublicKey) *rpc.GetAccountInfoResult {
				return &rpc.GetAccountInfoResult{Value: &rpc.Account{Owner: owner}}
			}
			otherProgram := solana.Token2022ProgramID
			if program == otherProgram {
				otherProgram = solana.TokenProgramID
			}
			const missing = "invalid_exact_solana_recipient_ata_missing"
			const wrongOwner = "invalid_exact_solana_recipient_ata_wrong_program_owner"
			cases := []struct {
				name    string
				account *rpc.GetAccountInfoResult
				readErr error
				reason  string
			}{
				{"not found", nil, rpc.ErrNotFound, missing},
				{"wrapped not found", nil, fmt.Errorf("account read: %w", rpc.ErrNotFound), missing},
				{"empty account value", &rpc.GetAccountInfoResult{}, nil, missing},
				{"system program owner", owned(solana.SystemProgramID), nil, wrongOwner},
				{"other token program owner", owned(otherProgram), nil, wrongOwner},
				{"correct program owner", owned(program), nil, ErrTransactionSimulationFailed},
				{"read error", nil, errors.New("secondary account read failed"), ErrTransactionSimulationFailed},
				{"partial result with read error", owned(solana.SystemProgramID), errors.New("incomplete account read"), ErrTransactionSimulationFailed},
				{"inconclusive result", nil, nil, ErrTransactionSimulationFailed},
			}
			for _, tc := range cases {
				t.Run(tc.name, func(t *testing.T) {
					base := newRecipientSigner(f)
					s := &recipientAccountSigner{recipientDiagnosticSigner: base, account: tc.account, readErr: tc.readErr}
					scheme := NewExactSvmScheme(s, &Config{EnableSmartWalletVerification: true})
					_, err := scheme.Verify(context.Background(), f.payload, f.requirements, nil)
					var verification *x402.VerifyError
					require.ErrorAs(t, err, &verification)
					assert.Equal(t, tc.reason, verification.InvalidReason)
					assert.Equal(t, f.ownerKey.PublicKey().String(), verification.Payer)
					assert.Contains(t, verification.InvalidMessage, recipientSimulationMessage)
					if tc.reason == ErrTransactionSimulationFailed {
						assert.Equal(t, recipientSimulationMessage, verification.InvalidMessage)
					} else {
						assert.Contains(t, verification.InvalidMessage, f.destATA.String())
						if tc.reason == wrongOwner {
							assert.Contains(t, verification.InvalidMessage, program.String())
							assert.Contains(t, verification.InvalidMessage, tc.account.Value.Owner.String())
						}
					}
					assert.Equal(t, []recipientAccountRead{{f.destATA, string(f.requirements.Network), rpc.CommitmentConfirmed}}, s.reads)
					assert.Equal(t, 1, s.simulateCalls)
					assertRecipientNoSettlement(t, base)
				})
			}

			t.Run("no optional getter", func(t *testing.T) {
				s := newRecipientSigner(f)
				_, err := NewExactSvmScheme(s).Verify(context.Background(), f.payload, f.requirements, nil)
				var verification *x402.VerifyError
				require.ErrorAs(t, err, &verification)
				assert.Equal(t, ErrTransactionSimulationFailed, verification.InvalidReason)
				assert.Equal(t, recipientSimulationMessage, verification.InvalidMessage)
				assert.Equal(t, f.ownerKey.PublicKey().String(), verification.Payer)
				assertRecipientNoSettlement(t, s)
			})

			t.Run("successful simulation", func(t *testing.T) {
				base := newRecipientSigner(f)
				base.simulationErr = nil
				s := &recipientAccountSigner{recipientDiagnosticSigner: base}
				result, err := NewExactSvmScheme(s).Verify(context.Background(), f.payload, f.requirements, nil)
				require.NoError(t, err)
				assert.True(t, result.IsValid)
				assert.Empty(t, s.reads)
				assertRecipientNoSettlement(t, base)
			})

			t.Run("early amount rejection", func(t *testing.T) {
				base := newRecipientSigner(f)
				s := &recipientAccountSigner{recipientDiagnosticSigner: base}
				requirements := f.requirements
				requirements.Amount = "1001"
				_, err := NewExactSvmScheme(s).Verify(context.Background(), f.payload, requirements, nil)
				var verification *x402.VerifyError
				require.ErrorAs(t, err, &verification)
				assert.Equal(t, ErrAmountMismatch, verification.InvalidReason)
				assert.Zero(t, s.simulateCalls)
				assert.Empty(t, s.reads)
				assertRecipientNoSettlement(t, base)
			})

			t.Run("early recipient rejection", func(t *testing.T) {
				base := newRecipientSigner(f)
				s := &recipientAccountSigner{recipientDiagnosticSigner: base}
				requirements := f.requirements
				requirements.PayTo = f.facilitatorAddr.String()
				_, err := NewExactSvmScheme(s).Verify(context.Background(), f.payload, requirements, nil)
				var verification *x402.VerifyError
				require.ErrorAs(t, err, &verification)
				assert.Equal(t, ErrRecipientMismatch, verification.InvalidReason)
				assert.Zero(t, s.simulateCalls)
				assert.Empty(t, s.reads)
				assertRecipientNoSettlement(t, base)
			})

			t.Run("early mint rejection", func(t *testing.T) {
				base := newRecipientSigner(f)
				s := &recipientAccountSigner{recipientDiagnosticSigner: base}
				requirements := f.requirements
				requirements.Asset = f.facilitatorAddr.String()
				_, err := NewExactSvmScheme(s).Verify(context.Background(), f.payload, requirements, nil)
				var verification *x402.VerifyError
				require.ErrorAs(t, err, &verification)
				assert.Equal(t, ErrMintMismatch, verification.InvalidReason)
				assert.Zero(t, s.simulateCalls)
				assert.Empty(t, s.reads)
				assertRecipientNoSettlement(t, base)
			})

			t.Run("undecodable transaction", func(t *testing.T) {
				base := newRecipientSigner(f)
				s := &recipientAccountSigner{recipientDiagnosticSigner: base}
				payload := f.payload
				payload.Payload = (&svm.ExactSvmPayload{Transaction: "invalid-base64"}).ToMap()
				_, err := NewExactSvmScheme(s).Verify(context.Background(), payload, f.requirements, nil)
				var verification *x402.VerifyError
				require.ErrorAs(t, err, &verification)
				assert.Equal(t, ErrTransactionCouldNotBeDecoded, verification.InvalidReason)
				assert.Zero(t, s.simulateCalls)
				assert.Empty(t, s.reads)
				assertRecipientNoSettlement(t, base)
			})

			for _, tc := range cases[:5] {
				// One missing-account and one ownership result cover the settle conversion.
				if tc.name != "not found" && tc.name != "system program owner" {
					continue
				}
				t.Run("settle "+tc.name, func(t *testing.T) {
					base := newRecipientSigner(f)
					s := &recipientAccountSigner{recipientDiagnosticSigner: base, account: tc.account, readErr: tc.readErr}
					_, err := NewExactSvmScheme(s).Settle(context.Background(), f.payload, f.requirements, nil)
					var settlement *x402.SettleError
					require.ErrorAs(t, err, &settlement)
					assert.Equal(t, tc.reason, settlement.ErrorReason)
					assert.Equal(t, f.ownerKey.PublicKey().String(), settlement.Payer)
					assert.Contains(t, settlement.ErrorMessage, recipientSimulationMessage)
					assert.Contains(t, settlement.ErrorMessage, f.destATA.String())
					assertRecipientNoSettlement(t, base)
				})
			}
		})
	}
}
