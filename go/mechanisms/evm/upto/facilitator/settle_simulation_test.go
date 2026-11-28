package facilitator

import (
	"context"
	"errors"
	"math/big"
	"slices"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	gethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/v2/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// All chain interactions are synthetic; authorization hashing and approval
// transaction decoding/signature recovery still use the real SDK implementations.
type chargeSimulationSigner struct {
	*mockFacilitatorSigner
	t               *testing.T
	balance         *big.Int
	allowance       *big.Int
	ethBalance      *big.Int
	expectedHash    [32]byte
	function        string
	prerequisites   bool
	forceFailure    bool
	approval        string
	signatureCalls  int
	signatureResult [4]byte
	signatureError  error
	multicalls      int
	simulated       []int64
	broadcast       []int64
}

func (s *chargeSimulationSigner) charge(function string, args []interface{}) *big.Int {
	s.t.Helper()
	if function != s.function {
		s.t.Fatalf("contract function = %s, want %s", function, s.function)
	}
	index := 1
	if function == evm.FunctionSettleWithPermit {
		index = 2
	}
	return args[index].(*big.Int)
}

func (s *chargeSimulationSigner) simulate(amount *big.Int) error {
	s.simulated = append(s.simulated, amount.Int64())
	if s.forceFailure || amount.Cmp(s.balance) > 0 {
		return errors.New("synthetic execution revert")
	}
	return nil
}

func (s *chargeSimulationSigner) ReadContract(ctx context.Context, address string, abi []byte, function string, args ...interface{}) (interface{}, error) {
	switch function {
	case "isValidSignature":
		s.signatureCalls++
		if args[0] != s.expectedHash {
			s.t.Fatal("signature verification changed the signed authorization")
		}
		return s.signatureResult, s.signatureError
	case evm.FunctionSettle, evm.FunctionSettleWithPermit:
		return nil, s.simulate(s.charge(function, args))
	case evm.FunctionTryAggregate:
		s.multicalls++
		third := s.allowance
		if s.prerequisites {
			third = s.ethBalance
		}
		// ABI words for PERMIT2(), balanceOf(), and allowance() or getEthBalance().
		return []struct {
			Success    bool
			ReturnData []byte
		}{
			{true, common.LeftPadBytes(common.HexToAddress(evm.PERMIT2Address).Bytes(), 32)},
			{true, s.balance.FillBytes(make([]byte, 32))},
			{true, third.FillBytes(make([]byte, 32))},
		}, nil
	default:
		s.t.Fatalf("unexpected synthetic contract read: %s", function)
		return nil, nil
	}
}

func (s *chargeSimulationSigner) WriteContract(ctx context.Context, address string, abi []byte, function string, suffix []byte, args ...interface{}) (string, error) {
	amount := s.charge(function, args)
	s.broadcast = append(s.broadcast, amount.Int64())
	if amount.Cmp(s.balance) > 0 {
		return "", errors.New("synthetic transfer exceeds balance")
	}
	return s.mockFacilitatorSigner.WriteContract(ctx, address, abi, function, suffix, args...)
}

// Separate types exercise signers both with and without the optional simulator.
type chargeApprovalSigner struct{ *chargeSimulationSigner }

func (s *chargeApprovalSigner) settleCall(requests []erc20approvalgassponsor.TransactionRequest) *erc20approvalgassponsor.WriteContractCall {
	s.t.Helper()
	if len(requests) != 2 || requests[0].Serialized != s.approval || requests[1].Call == nil {
		s.t.Fatalf("expected signed approval followed by settlement, got %+v", requests)
	}
	return requests[1].Call
}

func (s *chargeApprovalSigner) SendTransactions(ctx context.Context, requests []erc20approvalgassponsor.TransactionRequest) ([]string, error) {
	call := s.settleCall(requests)
	hash, err := s.WriteContract(ctx, call.Address, call.ABI, call.Function, call.DataSuffix, call.Args...)
	return []string{hash}, err
}

type chargeApprovalSimulator struct{ *chargeApprovalSigner }

func (s *chargeApprovalSimulator) SimulateTransactions(_ context.Context, requests []erc20approvalgassponsor.TransactionRequest) (bool, error) {
	call := s.settleCall(requests)
	err := s.simulate(s.charge(call.Function, call.Args))
	return err == nil, err
}

func newChargeSimulation(t *testing.T, path string) (*chargeSimulationSigner, types.PaymentPayload, types.PaymentRequirements, *x402.FacilitatorContext) {
	t.Helper()
	evm.ResetAssetContractCache()
	p := buildValidUptoPayload(testFacilitatorAddr)
	p.Permit2Authorization.Permitted.Amount = "1000000"
	// Use a full-length token address for the signed ERC20 approval validator.
	token := "0xeED520980fC7C7B4eB379B96d61CEdea2423005a"
	p.Permit2Authorization.Permitted.Token = token
	payload := buildValidPayload(testFacilitatorAddr)
	payload.Accepted.Amount = "1000000"
	payload.Accepted.Asset = token
	requirements := buildValidRequirements()
	requirements.Amount = "300000"
	requirements.Asset = token
	s := &chargeSimulationSigner{
		mockFacilitatorSigner: newMockSigner(), t: t,
		balance: big.NewInt(400_000), allowance: big.NewInt(400_000),
		ethBalance: big.NewInt(1_000_000_000_000_000_000), function: evm.FunctionSettle,
		signatureResult: [4]byte{0x16, 0x26, 0xba, 0x7e},
	}
	var facilCtx *x402.FacilitatorContext
	chainID := big.NewInt(84532)
	if path == "eip2612" {
		s.function = evm.FunctionSettleWithPermit
		payload.Extensions = map[string]interface{}{
			eip2612gassponsor.EIP2612GasSponsoring.Key(): map[string]interface{}{"info": map[string]interface{}{
				"from": p.Permit2Authorization.From, "asset": token, "spender": evm.PERMIT2Address,
				"amount": evm.MaxUint256().String(), "nonce": "0", "deadline": futureDeadline(),
				"signature": dummySig, "version": "1",
			}},
		}
	}
	if path == "erc20_batch" || path == "erc20_prerequisites" {
		// Public, deterministic test key; never used outside this synthetic fixture.
		key, err := crypto.HexToECDSA(strings.Repeat("01", 32))
		if err != nil {
			t.Fatal(err)
		}
		p.Permit2Authorization.From = crypto.PubkeyToAddress(key.PublicKey).Hex()
		data := append([]byte{0x09, 0x5e, 0xa7, 0xb3}, common.LeftPadBytes(common.HexToAddress(evm.PERMIT2Address).Bytes(), 32)...)
		data = append(data, evm.MaxUint256().FillBytes(make([]byte, 32))...)
		to := common.HexToAddress(token)
		tx, err := gethtypes.SignTx(gethtypes.NewTx(&gethtypes.DynamicFeeTx{
			ChainID: chainID, GasTipCap: big.NewInt(1), GasFeeCap: big.NewInt(2),
			Gas: evm.ERC20ApproveGasLimit, To: &to, Value: big.NewInt(0), Data: data,
		}), gethtypes.LatestSignerForChainID(chainID), key)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := tx.MarshalBinary()
		if err != nil {
			t.Fatal(err)
		}
		s.approval = common.Bytes2Hex(raw)
		s.approval = "0x" + s.approval
		payload.Extensions = map[string]interface{}{
			erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): map[string]interface{}{"info": map[string]interface{}{
				"from": p.Permit2Authorization.From, "asset": token, "spender": evm.PERMIT2Address,
				"amount": evm.MaxUint256().String(), "signedTransaction": s.approval, "version": "1",
			}},
		}
		s.prerequisites = path == "erc20_prerequisites"
		var extensionSigner erc20approvalgassponsor.Erc20ApprovalGasSponsoringSigner = &chargeApprovalSigner{s}
		if !s.prerequisites {
			extensionSigner = &chargeApprovalSimulator{&chargeApprovalSigner{s}}
		}
		ext := &erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension{Signer: extensionSigner}
		facilCtx = x402.NewFacilitatorContext(map[string]x402.FacilitatorExtension{ext.Key(): ext})
	}
	hash, err := evm.HashUptoPermit2Authorization(p.Permit2Authorization, chainID)
	if err != nil {
		t.Fatal(err)
	}
	copy(s.expectedHash[:], hash)
	payload.Payload = p.ToMap()
	return s, payload, requirements, facilCtx
}

func TestUptoSettleSimulationUsesActualCharge(t *testing.T) {
	for _, path := range []string{"plain", "eip2612", "erc20_batch", "erc20_prerequisites"} {
		t.Run(path, func(t *testing.T) {
			for _, tc := range []struct {
				name       string
				amount     string
				balance    int64
				wantReason string
				disabled   bool
			}{
				{name: "partial_charge_covered", amount: "300000", balance: 400_000},
				{name: "exact_balance", amount: "300000", balance: 300_000},
				{name: "full_ceiling", amount: "1000000", balance: 1_000_000},
				{name: "insufficient_balance", amount: "300000", balance: 299_999, wantReason: ErrPermit2InsufficientBalance},
				{name: "zero_without_funds", amount: "0", balance: 0},
				{name: "over_ceiling_without_funds", amount: "1000001", balance: 0, wantReason: ErrUptoSettlementExceedsAmount},
				{name: "negative", amount: "-1", balance: 400_000, wantReason: ErrUptoInvalidPayload},
				{name: "malformed", amount: "invalid", balance: 400_000, wantReason: ErrUptoInvalidPayload},
				{name: "default_config", amount: "300000", balance: 400_000, disabled: true},
			} {
				t.Run(tc.name, func(t *testing.T) {
					s, payload, requirements, facilCtx := newChargeSimulation(t, path)
					s.balance.SetInt64(tc.balance)
					requirements.Amount = tc.amount
					var config *UptoEvmSchemeConfig
					if !tc.disabled {
						config = &UptoEvmSchemeConfig{SimulateInSettle: true}
					}
					resp, err := NewUptoEvmScheme(s, config).Settle(context.Background(), payload, requirements, facilCtx)
					var settleErr *x402.SettleError
					if tc.wantReason != "" {
						if !errors.As(err, &settleErr) || settleErr.ErrorReason != tc.wantReason {
							t.Fatalf("want %s, got response=%+v err=%v", tc.wantReason, resp, err)
						}
						if len(s.broadcast) != 0 {
							t.Fatalf("rejected settlement broadcast: %v", s.broadcast)
						}
					} else {
						if err != nil || resp == nil || !resp.Success || resp.Amount != tc.amount {
							t.Fatalf("want successful charge %s, got response=%+v err=%v", tc.amount, resp, err)
						}
						if s.signatureCalls != 1 {
							t.Fatalf("signature checks = %d, want 1", s.signatureCalls)
						}
						if tc.amount != "0" {
							amount, _ := new(big.Int).SetString(tc.amount, 10)
							if !slices.Equal(s.broadcast, []int64{amount.Int64()}) {
								t.Fatalf("broadcast = %v, want [%s]", s.broadcast, tc.amount)
							}
						} else if resp.Transaction != "" || len(s.broadcast) != 0 {
							t.Fatal("zero settlement must not broadcast")
						}
					}
					if tc.disabled || tc.amount == "0" || (tc.wantReason != "" && tc.wantReason != ErrPermit2InsufficientBalance) {
						if len(s.simulated) != 0 || s.multicalls != 0 {
							t.Fatalf("unexpected simulation/prerequisites: %v, multicalls=%d", s.simulated, s.multicalls)
						}
					} else if s.prerequisites {
						if s.multicalls != 1 || len(s.simulated) != 0 {
							t.Fatalf("expected prerequisite check only, got %d multicalls and %v simulations", s.multicalls, s.simulated)
						}
					} else {
						amount, _ := new(big.Int).SetString(tc.amount, 10)
						if !slices.Equal(s.simulated, []int64{amount.Int64()}) {
							t.Fatalf("simulated = %v, want [%s]", s.simulated, tc.amount)
						}
					}
				})
			}
		})
	}
}

func TestUptoSettleSimulationDiagnostics(t *testing.T) {
	for _, path := range []string{"plain", "eip2612", "erc20_batch"} {
		for _, tc := range []struct {
			name      string
			allowance int64
			reason    string
		}{
			{"unrelated_revert", 400_000, ErrPermit2SimulationFailed},
			{"allowance_below_charge", 299_999, ErrPermit2AllowanceRequired},
		} {
			t.Run(path+"/"+tc.name, func(t *testing.T) {
				s, payload, requirements, facilCtx := newChargeSimulation(t, path)
				s.forceFailure = true
				s.allowance.SetInt64(tc.allowance)
				_, err := NewUptoEvmScheme(s, &UptoEvmSchemeConfig{SimulateInSettle: true}).Settle(context.Background(), payload, requirements, facilCtx)
				var settleErr *x402.SettleError
				if !errors.As(err, &settleErr) || settleErr.ErrorReason != tc.reason || len(s.broadcast) != 0 {
					t.Fatalf("want %s without broadcast, got err=%v broadcasts=%v", tc.reason, err, s.broadcast)
				}
			})
		}
	}
}

func TestUptoVerifySimulationStillUsesCeiling(t *testing.T) {
	for _, path := range []string{"plain", "eip2612", "erc20_batch", "erc20_prerequisites"} {
		for _, tc := range []struct {
			name, amount, reason string
			balance              int64
		}{
			{"partial_balance", "1000000", ErrPermit2InsufficientBalance, 400_000},
			{"ceiling_covered", "1000000", "", 1_000_000},
			{"amount_mismatch", "300000", ErrPermit2AmountMismatch, 1_000_000},
		} {
			t.Run(path+"/"+tc.name, func(t *testing.T) {
				s, payload, requirements, facilCtx := newChargeSimulation(t, path)
				s.balance.SetInt64(tc.balance)
				requirements.Amount = tc.amount
				resp, err := NewUptoEvmScheme(s, nil).Verify(context.Background(), payload, requirements, facilCtx)
				var verifyErr *x402.VerifyError
				if tc.reason == "" {
					if err != nil || resp == nil || !resp.IsValid {
						t.Fatalf("want valid verification, got response=%+v err=%v", resp, err)
					}
				} else if !errors.As(err, &verifyErr) || verifyErr.InvalidReason != tc.reason {
					t.Fatalf("want %s, got err=%v", tc.reason, err)
				}
				if tc.reason == ErrPermit2AmountMismatch {
					if len(s.simulated) != 0 || s.multicalls != 0 {
						t.Fatal("amount mismatch reached simulation")
					}
				} else if !s.prerequisites && !slices.Equal(s.simulated, []int64{1_000_000}) {
					t.Fatalf("verify simulated %v, want ceiling", s.simulated)
				}
			})
		}
	}
}

func TestUptoZeroSettlementStillRejectsInvalidSignature(t *testing.T) {
	for _, path := range []string{"plain", "eip2612", "erc20_batch", "erc20_prerequisites"} {
		for _, wallet := range []string{"eoa", "contract_rejection", "contract_error"} {
			t.Run(path+"/"+wallet, func(t *testing.T) {
				s, payload, requirements, facilCtx := newChargeSimulation(t, path)
				requirements.Amount = "0"
				p, err := evm.UptoPermit2PayloadFromMap(payload.Payload)
				if err != nil {
					t.Fatal(err)
				}
				if wallet == "eoa" {
					// An EOA with the fixture's dummy payment signature cannot authenticate.
					s.getCodeByAddress = map[string][]byte{strings.ToLower(p.Permit2Authorization.From): {}}
				} else {
					s.signatureResult = [4]byte{}
					if wallet == "contract_error" {
						s.signatureError = errors.New("synthetic wallet read failure")
					}
				}
				_, err = NewUptoEvmScheme(s, &UptoEvmSchemeConfig{SimulateInSettle: true}).Settle(context.Background(), payload, requirements, facilCtx)
				var settleErr *x402.SettleError
				if !errors.As(err, &settleErr) || settleErr.ErrorReason != ErrPermit2InvalidSignature {
					t.Fatalf("want invalid signature, got %v", err)
				}
				if len(s.simulated) != 0 || s.multicalls != 0 || len(s.broadcast) != 0 {
					t.Fatal("invalid zero settlement reached simulation or broadcast")
				}
			})
		}
	}
}

func TestUptoSettlePrerequisitesStillCheckGas(t *testing.T) {
	s, payload, requirements, facilCtx := newChargeSimulation(t, "erc20_prerequisites")
	s.ethBalance.SetInt64(0)
	_, err := NewUptoEvmScheme(s, &UptoEvmSchemeConfig{SimulateInSettle: true}).Settle(context.Background(), payload, requirements, facilCtx)
	var settleErr *x402.SettleError
	if !errors.As(err, &settleErr) || settleErr.ErrorReason != ErrErc20ApprovalInsufficientEth || len(s.broadcast) != 0 {
		t.Fatalf("want insufficient gas without broadcast, got err=%v broadcasts=%v", err, s.broadcast)
	}
}
