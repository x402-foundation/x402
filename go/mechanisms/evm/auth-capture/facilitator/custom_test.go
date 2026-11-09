package facilitator

import (
	"bytes"
	"context"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	gethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

var (
	customSubmitter  = "0x" + strings.Repeat("b", 40)
	customTokenStore = "0x" + strings.Repeat("5", 40)
	startingBalance  = big.NewInt(5_000_000)
)

// customRun scripts one custom operator collect against a simulating mock signer.
type customRun struct {
	t            *testing.T
	scheme       *AuthCaptureEvmScheme
	signer       *mockFacSigner
	payload      types.PaymentPayload
	requirements types.PaymentRequirements
	pre          *collectPreconditions
	addresses    []string
	deltas       map[string]*big.Int
}

func newCustomRun(t *testing.T, charge bool) *customRun {
	t.Helper()
	var payload types.PaymentPayload
	var requirements types.PaymentRequirements
	if charge {
		fx := newChargeFixture(t, map[string]interface{}{"operatorType": "custom"}, collectOpts{})
		payload, requirements = fx.complete(t, chargeOpts{}), fx.requirements
	} else {
		requirements = facBaseRequirements(facCaptureAuthorizer, map[string]interface{}{"operatorType": "custom"})
		payload = buildCollectPayload(t, requirements, newKeySigner(t), collectOpts{})
	}

	signer := newMockFacSigner(customSubmitter)
	signer.tokenStore = customTokenStore
	// The custom operator is not a signer address, so the scheme is relay-only.
	scheme := NewAuthCaptureEvmScheme(signer, AuthCaptureEvmSchemeConfig{Operators: allowAllCustomOperators})
	pre, err := scheme.checkCollectPreconditions(context.Background(), payload, requirements, charge)
	require.NoError(t, err)

	addresses := scheme.watchedAddresses(&pre.collectOutcome, customTokenStore)
	return &customRun{
		t: t, scheme: scheme, signer: signer, payload: payload, requirements: requirements, pre: pre,
		addresses: addresses, deltas: scheme.expectedDeltas(&pre.collectOutcome, customTokenStore),
	}
}

func (r *customRun) delta(address string) *big.Int {
	if d := r.deltas[strings.ToLower(address)]; d != nil {
		return d
	}
	return new(big.Int)
}

func (r *customRun) state(collected bool, capturable, refundable *big.Int) []byte {
	escrow, err := abi.JSON(bytes.NewReader(authcapture.EscrowABIForDeployment(&r.pre.deployment)))
	require.NoError(r.t, err)
	data, err := escrow.Methods["paymentState"].Outputs.Pack(collected, capturable, refundable)
	require.NoError(r.t, err)
	return data
}

func (r *customRun) balance(amount *big.Int) []byte {
	erc20, err := abi.JSON(bytes.NewReader(evm.ERC20BalanceOfABI))
	require.NoError(r.t, err)
	data, err := erc20.Methods["balanceOf"].Outputs.Pack(amount)
	require.NoError(r.t, err)
	return data
}

// finalState is the payment state the escrow reaches after the collect.
func (r *customRun) finalState() (capturable, refundable *big.Int) {
	if r.pre.function == "charge" {
		return big.NewInt(0), new(big.Int).Set(r.pre.amount)
	}
	return new(big.Int).Set(r.pre.amount), big.NewInt(0)
}

// reads is one snapshot: the payment state, then each watched balance, moved by moved(address).
func (r *customRun) reads(collected bool, capturable, refundable *big.Int, moved func(address string) *big.Int) []SimulatedCallResult {
	results := []SimulatedCallResult{{Success: true, ReturnData: r.state(collected, capturable, refundable)}}
	for _, address := range r.addresses {
		balance := new(big.Int).Set(startingBalance)
		if moved != nil {
			balance.Add(balance, moved(address))
		}
		results = append(results, SimulatedCallResult{Success: true, ReturnData: r.balance(balance)})
	}
	return results
}

func (r *customRun) eventLog(tweak func(fields []interface{})) *gethtypes.Log {
	out := &r.pre.collectOutcome
	escrow, err := abi.JSON(bytes.NewReader(authcapture.EscrowABIForDeployment(&out.deployment)))
	require.NoError(r.t, err)
	name := "PaymentAuthorized"
	tuple, err := out.paymentInfo.ToAbiTuple()
	require.NoError(r.t, err)
	fields := []interface{}{tuple, out.amount, common.HexToAddress(out.tokenCollector)}
	if out.function == "charge" {
		name = "PaymentCharged"
		fields = append(fields, out.fee.Arg(), common.HexToAddress(out.feeReceiver))
	}
	if tweak != nil {
		tweak(fields)
	}
	data, err := escrow.Events[name].Inputs.NonIndexed().Pack(fields...)
	require.NoError(r.t, err)
	hash, err := evm.HexToBytes(out.paymentInfoHash)
	require.NoError(r.t, err)
	return &gethtypes.Log{
		Address: common.HexToAddress(out.deployment.Escrow),
		Topics:  []common.Hash{escrow.Events[name].ID, common.BytesToHash(hash)},
		Data:    data,
	}
}

// simulation is the scripted eth_simulateV1 outcome; tests overwrite the part they break.
type simulation struct {
	before, after []SimulatedCallResult
	call          SimulatedCallResult
}

func (r *customRun) happy() *simulation {
	capturable, refundable := r.finalState()
	return &simulation{
		before: r.reads(false, big.NewInt(0), big.NewInt(0), nil),
		after:  r.reads(true, capturable, refundable, func(address string) *big.Int { return r.delta(address) }),
		call:   SimulatedCallResult{Success: true, GasUsed: 100_000, Logs: []*gethtypes.Log{r.eventLog(nil)}},
	}
}

func (r *customRun) script(s *simulation) {
	r.signer.simulateCalls = func(from string, calls []SimulatedCall) ([]SimulatedCallResult, error) {
		assert.Equal(r.t, customSubmitter, from)
		results := append(append(append([]SimulatedCallResult{}, s.before...), s.call), s.after...)
		return results, nil
	}
}

func (r *customRun) verify() error {
	_, err := r.scheme.Verify(context.Background(), r.payload, r.requirements, nil)
	return err
}

func TestVerifyCustomCollect_HappyPath(t *testing.T) {
	for _, charge := range []bool{false, true} {
		run := newCustomRun(t, charge)
		run.script(run.happy())

		assert.NoError(t, run.verify(), "charge=%v", charge)
	}
}

func TestVerifyCustomCollect_ForwardsThroughTheOperatorWithAGasCap(t *testing.T) {
	run := newCustomRun(t, false)
	s := run.happy()
	run.signer.simulateCalls = func(_ string, calls []SimulatedCall) ([]SimulatedCallResult, error) {
		call := calls[len(s.before)]
		assert.True(t, strings.EqualFold(facCaptureAuthorizer, call.To), "the call goes to the custom operator")
		assert.Equal(t, authcapture.DefaultCustomOperatorGasLimit, call.Gas)
		return append(append(append([]SimulatedCallResult{}, s.before...), s.call), s.after...), nil
	}

	require.NoError(t, run.verify())
}

func TestVerifyCustomCollect_Rejections(t *testing.T) {
	zero := big.NewInt(0)
	tests := []struct {
		name   string
		charge bool
		mutate func(r *customRun, s *simulation)
		reason string
	}{
		{
			name:   "the operator call reverts",
			mutate: func(_ *customRun, s *simulation) { s.call = SimulatedCallResult{Success: false} },
			reason: ErrSimulationFailed,
		},
		{
			name:   "the operator call exceeds its gas limit",
			mutate: func(_ *customRun, s *simulation) { s.call.GasUsed = authcapture.DefaultCustomOperatorGasLimit + 1 },
			reason: ErrSimulationFailed,
		},
		{
			name:   "no escrow event is emitted",
			mutate: func(_ *customRun, s *simulation) { s.call.Logs = nil },
			reason: ErrSimulationFailed,
		},
		{
			name: "the event is for another amount",
			mutate: func(r *customRun, s *simulation) {
				s.call.Logs = []*gethtypes.Log{r.eventLog(func(f []interface{}) { f[1] = big.NewInt(1) })}
			},
			reason: ErrSimulationFailed,
		},
		{
			name: "the event names another token collector",
			mutate: func(r *customRun, s *simulation) {
				s.call.Logs = []*gethtypes.Log{r.eventLog(func(f []interface{}) { f[2] = common.HexToAddress("0x" + strings.Repeat("9", 40)) })}
			},
			reason: ErrSimulationFailed,
		},
		{
			name:   "the charge event names another fee receiver",
			charge: true,
			mutate: func(r *customRun, s *simulation) {
				s.call.Logs = []*gethtypes.Log{r.eventLog(func(f []interface{}) { f[4] = common.HexToAddress("0x" + strings.Repeat("9", 40)) })}
			},
			reason: ErrSimulationFailed,
		},
		{
			name:   "the charge event reports another fee",
			charge: true,
			mutate: func(r *customRun, s *simulation) {
				s.call.Logs = []*gethtypes.Log{r.eventLog(func(f []interface{}) { f[3] = big.NewInt(7) })}
			},
			reason: ErrSimulationFailed,
		},
		{
			name: "the event is emitted by another contract",
			mutate: func(_ *customRun, s *simulation) {
				s.call.Logs[0].Address = common.HexToAddress("0x" + strings.Repeat("9", 40))
			},
			reason: ErrSimulationFailed,
		},
		{
			name: "the payment was already collected",
			mutate: func(r *customRun, s *simulation) {
				s.before = r.reads(true, zero, zero, nil)
			},
			reason: ErrPaymentAlreadyCollected,
		},
		{
			name: "the payment never reaches the collected state",
			mutate: func(r *customRun, s *simulation) {
				s.after = r.reads(false, zero, zero, func(a string) *big.Int { return r.delta(a) })
			},
			reason: ErrUnexpectedPaymentState,
		},
		{
			name: "the payer is debited less than the amount",
			mutate: func(r *customRun, s *simulation) {
				capturable, refundable := r.finalState()
				s.after = r.reads(true, capturable, refundable, func(a string) *big.Int {
					if strings.EqualFold(a, r.pre.payer) {
						return new(big.Int).Neg(big.NewInt(1))
					}
					return r.delta(a)
				})
			},
			reason: ErrUnexpectedPaymentState,
		},
		{
			name: "the operator skims the token store",
			mutate: func(r *customRun, s *simulation) {
				capturable, refundable := r.finalState()
				s.after = r.reads(true, capturable, refundable, func(a string) *big.Int {
					if strings.EqualFold(a, customTokenStore) {
						return new(big.Int).Sub(r.delta(a), big.NewInt(1))
					}
					return r.delta(a)
				})
			},
			reason: ErrUnexpectedPaymentState,
		},
		{
			name: "the operator drains the facilitator",
			mutate: func(r *customRun, s *simulation) {
				capturable, refundable := r.finalState()
				s.after = r.reads(true, capturable, refundable, func(a string) *big.Int {
					if strings.EqualFold(a, customSubmitter) {
						return big.NewInt(-1)
					}
					return r.delta(a)
				})
			},
			reason: ErrUnexpectedPaymentState,
		},
		{
			name:   "a charge that leaves the hold capturable",
			charge: true,
			mutate: func(r *customRun, s *simulation) {
				s.after = r.reads(true, r.pre.amount, zero, func(a string) *big.Int { return r.delta(a) })
			},
			reason: ErrUnexpectedPaymentState,
		},
		{
			name:   "an unreadable state",
			mutate: func(_ *customRun, s *simulation) { s.before[0].ReturnData = []byte{1} },
			reason: ErrSimulationFailed,
		},
		{
			name:   "a reverted state read",
			mutate: func(_ *customRun, s *simulation) { s.after[1].Success = false },
			reason: ErrSimulationFailed,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			run := newCustomRun(t, test.charge)
			s := run.happy()
			test.mutate(run, s)
			run.script(s)

			assertVerifyReason(t, run.verify(), test.reason)
		})
	}
}

func TestVerifyCustomCollect_SimulatorFailures(t *testing.T) {
	t.Run("the simulator errors", func(t *testing.T) {
		run := newCustomRun(t, false)
		run.signer.simulateCalls = func(string, []SimulatedCall) ([]SimulatedCallResult, error) { return nil, assert.AnError }
		assertVerifyReason(t, run.verify(), ErrSimulationFailed)
	})

	t.Run("the simulator drops results", func(t *testing.T) {
		run := newCustomRun(t, false)
		run.signer.simulateCalls = func(string, []SimulatedCall) ([]SimulatedCallResult, error) { return nil, nil }
		assertVerifyReason(t, run.verify(), ErrSimulationFailed)
	})
}

func TestSettleCustomCollect(t *testing.T) {
	// Settle re-reads the state around the broadcast, so the mock mirrors the happy simulation
	// in its own state: balances move and the payment is collected once the write lands.
	arm := func(run *customRun) {
		run.script(run.happy())
		for _, address := range run.addresses {
			run.signer.balances[address] = new(big.Int).Set(startingBalance)
		}
		run.signer.paymentStateCapturable, run.signer.paymentStateRefundable = big.NewInt(0), big.NewInt(0)
		run.signer.afterWrite = func(string) {
			capturable, refundable := run.finalState()
			run.signer.paymentStateHasCollected = true
			run.signer.paymentStateCapturable, run.signer.paymentStateRefundable = capturable, refundable
			for _, address := range run.addresses {
				run.signer.balances[address] = new(big.Int).Add(startingBalance, run.delta(address))
			}
		}
		run.signer.receipt = &evm.TransactionReceipt{
			Status: evm.TxStatusSuccess, TxHash: run.signer.writeTx, Logs: []*gethtypes.Log{run.eventLog(nil)},
		}
	}

	for _, charge := range []bool{false, true} {
		t.Run("a confirmed collect that matches settles", func(t *testing.T) {
			run := newCustomRun(t, charge)
			arm(run)

			resp, err := run.scheme.Settle(context.Background(), run.payload, run.requirements, nil)
			require.NoError(t, err)
			assert.True(t, resp.Success)
			assert.Equal(t, uint64(authcapture.DefaultCustomOperatorGasLimit), run.signer.writeGas)
			assert.Equal(t, strings.ToLower(facCaptureAuthorizer), strings.ToLower(run.signer.writeTarget))
		})
	}

	t.Run("a receipt without the escrow event is rejected", func(t *testing.T) {
		run := newCustomRun(t, false)
		arm(run)
		run.signer.receipt.Logs = nil

		resp, err := run.scheme.Settle(context.Background(), run.payload, run.requirements, nil)
		require.NoError(t, err)
		assert.False(t, resp.Success)
		assert.Equal(t, ErrSimulationFailed, resp.ErrorReason)
		assert.Equal(t, run.signer.writeTx, resp.Transaction)
	})

	t.Run("balances that moved differently on chain are rejected", func(t *testing.T) {
		run := newCustomRun(t, false)
		arm(run)
		write := run.signer.afterWrite
		run.signer.afterWrite = func(function string) {
			write(function)
			run.signer.balances[strings.ToLower(customTokenStore)] = new(big.Int).Set(startingBalance)
		}

		resp, err := run.scheme.Settle(context.Background(), run.payload, run.requirements, nil)
		require.NoError(t, err)
		assert.False(t, resp.Success)
		assert.Equal(t, ErrUnexpectedPaymentState, resp.ErrorReason)
	})

	t.Run("a failing pre-broadcast simulation never broadcasts", func(t *testing.T) {
		run := newCustomRun(t, false)
		arm(run)
		s := run.happy()
		s.call.Logs = nil
		run.script(s)

		_, err := run.scheme.Settle(context.Background(), run.payload, run.requirements, nil)
		assertSettleReason(t, err, ErrSimulationFailed)
		assert.Empty(t, run.signer.writtenFunctions)
	})

	t.Run("a lagging paymentState read is retried until the collect is visible", func(t *testing.T) {
		run := newCustomRun(t, false)
		arm(run)
		write := run.signer.afterWrite
		run.signer.afterWrite = func(function string) {
			write(function)
			run.signer.stalePaymentStateReads = 2
		}

		resp, err := run.scheme.Settle(context.Background(), run.payload, run.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.Equal(t, 0, run.signer.stalePaymentStateReads)
	})

	t.Run("a payment that stays uncollected is rejected", func(t *testing.T) {
		run := newCustomRun(t, false)
		arm(run)
		write := run.signer.afterWrite
		run.signer.afterWrite = func(function string) {
			write(function)
			run.signer.paymentStateHasCollected = false
			run.signer.paymentStateCapturable = big.NewInt(0)
			run.signer.paymentStateRefundable = big.NewInt(0)
		}

		resp, err := run.scheme.Settle(context.Background(), run.payload, run.requirements, nil)
		require.NoError(t, err)
		assert.False(t, resp.Success)
		assert.Equal(t, ErrUnexpectedPaymentState, resp.ErrorReason)
	})

	t.Run("a resumed settlement is still checked against the receipt", func(t *testing.T) {
		run := newCustomRun(t, true)
		arm(run)
		run.signer.receipt.Logs = nil
		require.NoError(t, run.scheme.pendingStore.Set(context.Background(), settlementKey(run.payload.Payload), run.signer.writeTx))

		resp, err := run.scheme.Settle(context.Background(), run.payload, run.requirements, nil)
		require.NoError(t, err)
		assert.False(t, resp.Success)
		assert.Empty(t, run.signer.writtenFunctions)
	})
}

func TestCustomOperatorRequiresASimulatingSigner(t *testing.T) {
	run := newCustomRun(t, false)
	plain := &plainSigner{Signer: run.signer}
	scheme := NewAuthCaptureEvmScheme(plain, AuthCaptureEvmSchemeConfig{Operators: allowAllCustomOperators})

	err := scheme.simulateCustomCollect(context.Background(), run.pre)
	assertVerifyReason(t, err, ErrOperatorNotAdmitted)
}

// plainSigner hides the optional simulator and gas-limit capabilities.
type plainSigner struct{ Signer }
