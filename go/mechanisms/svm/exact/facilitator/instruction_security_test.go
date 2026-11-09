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

type layoutSecuritySigner struct {
	mockSmartWalletSigner
	innerCalls int
}

func (s *layoutSecuritySigner) SimulateTransactionWithInnerInstructions(context.Context, *solana.Transaction, string) ([]rpc.InnerInstruction, error) {
	s.innerCalls++
	return nil, errors.New("unexpected smart-wallet fallback")
}

func TestLighthouseSecurity(t *testing.T) {
	for _, data := range [][]byte{nil, {0, 0, 0, 0, 0}, {1}, {18}, {255}, {2}, {17}} {
		for _, reference := range []bool{false, true} {
			for _, fromEnd := range []bool{false, true} {
				for _, allowlisted := range []bool{false, true} {
					for _, fallback := range []bool{false, true} {
						name := fmt.Sprintf("data=%x/reference=%t/post=%t/allowlist=%t/fallback=%t", data, reference, fromEnd, allowlisted, fallback)
						t.Run(name, func(t *testing.T) {
							guard := func(fp solana.PublicKey) []solana.Instruction {
								accounts := solana.AccountMetaSlice{}
								if reference {
									accounts = append(accounts, solana.NewAccountMeta(fp, true, true))
								}
								return []solana.Instruction{solana.NewInstruction(lighthouseProgramID, accounts, data)}
							}
							empty := func(solana.PublicKey) []solana.Instruction { return nil }
							before, after := guard, empty
							if fromEnd {
								before, after = empty, guard
							}
							f := buildExactFixtureWithInstructionsFn(t, before, after)
							signer := &layoutSecuritySigner{mockSmartWalletSigner: mockSmartWalletSigner{mockExactSvmSigner: mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}}}
							config := &Config{EnableSmartWalletVerification: fallback, SmartWalletAllowedPrograms: []string{svm.LighthouseProgramAddress}}
							if allowlisted {
								discriminator := data
								if len(discriminator) == 0 {
									discriminator = []byte{0}
								}
								tuples := []InstructionTuple{{{ProgramID: lighthouseProgramID, Discriminator: discriminator}}}
								if fromEnd {
									config.PostflightInstructionAllowlist = tuples
								} else {
									config.PreflightInstructionAllowlist = tuples
								}
							}
							want := ""
							if len(data) == 0 || data[0] < 2 || data[0] > 17 {
								want = ErrInvalidLighthouseInstruction
							} else if reference {
								want = ErrFeePayerTransferringFunds
							}
							assert.Equal(t, want, verifyReason(t, NewExactSvmScheme(signer, config), f))
							assert.Zero(t, signer.innerCalls)
							if want != "" {
								assert.Zero(t, signer.signCalls)
								assert.Zero(t, signer.simulateCalls)
							}
						})
					}
				}
			}
		}
	}
}

func TestInvalidLighthouseAfterUnknownWrapperDoesNotFallback(t *testing.T) {
	f := buildExactFixtureWithInstructions(t, []solana.Instruction{
		blockInstruction(solana.SystemProgramID, []byte{0}),
		blockInstruction(lighthouseProgramID, []byte{0}),
	}, nil)
	signer := &layoutSecuritySigner{mockSmartWalletSigner: mockSmartWalletSigner{mockExactSvmSigner: mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}}}
	assert.Equal(t, ErrInvalidLighthouseInstruction, verifyReason(t, NewExactSvmScheme(signer, &Config{EnableSmartWalletVerification: true}), f))
	assert.Zero(t, signer.innerCalls)
}

func TestAllLighthouseAssertionsAreGuards(t *testing.T) {
	for discriminator := byte(2); discriminator <= 17; discriminator++ {
		f := buildExactFixtureWithOptional(t, blockInstruction(lighthouseProgramID, []byte{discriminator}))
		signer := &mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}
		assert.Empty(t, verifyReason(t, NewExactSvmScheme(signer), f))
	}
}

func TestAllowlistedTransferCheckedRejected(t *testing.T) {
	for _, tokenProgram := range []solana.PublicKey{solana.TokenProgramID, solana.Token2022ProgramID} {
		for _, fromEnd := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/post=%t", tokenProgram, fromEnd), func(t *testing.T) {
				f := buildExactFixture(t)
				transfer := f.tx.Message.Instructions[2]
				// The same mint, amount and destination appear twice, with one copy hidden
				// in an otherwise explicitly allowlisted block.
				f.tx.Message.AccountKeys[transfer.ProgramIDIndex] = tokenProgram
				if fromEnd {
					f.tx.Message.Instructions = append(f.tx.Message.Instructions, transfer)
				} else {
					f.tx.Message.Instructions = append([]solana.CompiledInstruction{transfer}, f.tx.Message.Instructions...)
				}
				signTransaction(t, f.tx, f.ownerKey)
				encoded, err := svm.EncodeTransaction(f.tx)
				require.NoError(t, err)
				f.payload.Payload["transaction"] = encoded
				signer := &layoutSecuritySigner{mockSmartWalletSigner: mockSmartWalletSigner{mockExactSvmSigner: mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}}}
				config := &Config{EnableSmartWalletVerification: true}
				tuples := []InstructionTuple{{{ProgramID: tokenProgram, Discriminator: []byte{12}}}}
				if fromEnd {
					config.PostflightInstructionAllowlist = tuples
				} else {
					config.PreflightInstructionAllowlist = tuples
				}
				assert.Equal(t, ErrPreflightPostflightTransferNotAllowed, verifyReason(t, NewExactSvmScheme(signer, config), f))
				assert.Zero(t, signer.innerCalls)
				assert.Zero(t, signer.signCalls)
			})
		}
	}
}

func TestPendingSettlementMalformedFeePayerStillReconciles(t *testing.T) {
	for _, feePayer := range []string{"", "not-base58!", "missing"} {
		for _, pending := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/pending=%t", feePayer, pending), func(t *testing.T) {
				f := buildExactFixture(t)
				if feePayer == "missing" {
					delete(f.requirements.Extra, "feePayer")
				} else {
					f.requirements.Extra["feePayer"] = feePayer
				}
				signer := &layoutSecuritySigner{mockSmartWalletSigner: mockSmartWalletSigner{mockExactSvmSigner: mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}}}
				if pending {
					signer.confirmErr = errors.New("still pending")
				}
				scheme := NewExactSvmScheme(signer, &Config{EnableSmartWalletVerification: true})
				signature := solana.SignatureFromBytes(append([]byte{3}, make([]byte, 63)...)).String()
				key := messageHashForPayload(t, f.payload)
				require.NoError(t, scheme.pendingStore.Set(context.Background(), key, signature))
				response, err := scheme.Settle(context.Background(), f.payload, f.requirements, nil)
				if pending {
					var se *x402.SettleError
					require.ErrorAs(t, err, &se)
					assert.Equal(t, ErrSettlementPending, se.ErrorReason)
					assert.Equal(t, signature, se.Transaction)
				} else {
					require.NoError(t, err)
					assert.True(t, response.Success)
					assert.Equal(t, signature, response.Transaction)
				}
				stored, hit, err := scheme.pendingStore.Get(context.Background(), key)
				require.NoError(t, err)
				assert.Equal(t, pending, hit)
				if pending {
					assert.Equal(t, signature, stored)
				}
				assert.Equal(t, 1, signer.confirmCalls)
				assert.Zero(t, signer.signCalls)
				assert.Zero(t, signer.sendCalls)
				assert.Zero(t, signer.simulateCalls)
				assert.Zero(t, signer.innerCalls)
			})
		}
	}
}
