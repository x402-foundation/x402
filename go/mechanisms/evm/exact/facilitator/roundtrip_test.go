package facilitator

import (
	"context"
	"math/big"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// These tests pin the RPC round trips verify and settle make, so a regression that reintroduces
// a sequential call or a duplicate eth_getCode fails here rather than quietly costing a round
// trip. Concurrency is asserted by a happens-before rendezvous, not by elapsed time.

const (
	roundTripPayer = "0x00000000000000000000000000000000000000aa"
	roundTripPayTo = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0"
	roundTripAsset = "0x00000000000000000000000000000000000000bb"
)

// roundTripSigner counts calls per RPC method and can hold a GetCode open until the transfer
// simulation's eth_call arrives.
type roundTripSigner struct {
	mu           sync.Mutex
	getCodeCalls map[string]int
	readCalls    map[string]int

	codeByAddress map[string][]byte

	// blockGetCodeFor makes GetCode for that address wait until the transfer simulation starts.
	blockGetCodeFor string
	// blockTimeout bounds that wait so a sequential implementation fails the assertion rather
	// than deadlocking the test.
	blockTimeout time.Duration

	simulationStarted      chan struct{}
	signalSimulationOnce   sync.Once
	getCodeGaveUpOnWaiting bool
}

func newRoundTripSigner(codeByAddress map[string][]byte) *roundTripSigner {
	return &roundTripSigner{
		getCodeCalls:      map[string]int{},
		readCalls:         map[string]int{},
		codeByAddress:     codeByAddress,
		blockTimeout:      2 * time.Second,
		simulationStarted: make(chan struct{}),
	}
}

func (s *roundTripSigner) getCodeCount(address string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getCodeCalls[strings.ToLower(address)]
}

func (s *roundTripSigner) readCount(functionName string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readCalls[functionName]
}

func (s *roundTripSigner) gaveUpWaiting() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getCodeGaveUpOnWaiting
}

func (s *roundTripSigner) GetAddresses() []string { return []string{"0xFac11"} }

func (s *roundTripSigner) GetCode(_ context.Context, address string) ([]byte, error) {
	normalized := strings.ToLower(address)

	s.mu.Lock()
	s.getCodeCalls[normalized]++
	s.mu.Unlock()

	if s.blockGetCodeFor != "" && normalized == strings.ToLower(s.blockGetCodeFor) {
		select {
		case <-s.simulationStarted:
		case <-time.After(s.blockTimeout):
			s.mu.Lock()
			s.getCodeGaveUpOnWaiting = true
			s.mu.Unlock()
		}
	}

	return s.codeByAddress[normalized], nil
}

func (s *roundTripSigner) ReadContract(
	_ context.Context,
	_ string,
	_ []byte,
	functionName string,
	_ ...interface{},
) (interface{}, error) {
	s.mu.Lock()
	s.readCalls[functionName]++
	s.mu.Unlock()

	switch functionName {
	case "isValidSignature":
		// EIP-1271 magic value, so the deployed smart wallet accepts the signature.
		return []byte{0x16, 0x26, 0xba, 0x7e}, nil
	case evm.FunctionTransferWithAuthorization, evm.FunctionSettle:
		// The EIP-3009 and Permit2 transfer simulations respectively.
		s.signalSimulationOnce.Do(func() { close(s.simulationStarted) })
		return nil, nil
	default:
		return nil, nil
	}
}

func (s *roundTripSigner) VerifyTypedData(
	_ context.Context,
	_ string,
	_ evm.TypedDataDomain,
	_ map[string][]evm.TypedDataField,
	_ string,
	_ map[string]interface{},
	_ []byte,
) (bool, error) {
	return false, nil
}

func (s *roundTripSigner) WriteContract(
	_ context.Context,
	_ string,
	_ []byte,
	_ string,
	_ []byte,
	_ ...interface{},
) (string, error) {
	return "0x" + strings.Repeat("ab", 32), nil
}

func (s *roundTripSigner) SendTransaction(_ context.Context, _ string, _ []byte) (string, error) {
	return "0x" + strings.Repeat("cd", 32), nil
}

func (s *roundTripSigner) WaitForTransactionReceipt(_ context.Context, txHash string) (*evm.TransactionReceipt, error) {
	return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
}

func (s *roundTripSigner) GetBalance(_ context.Context, _ string, _ string) (*big.Int, error) {
	return big.NewInt(1_000_000_000), nil
}

func (s *roundTripSigner) GetChainID(_ context.Context) (*big.Int, error) {
	return big.NewInt(84532), nil
}

// deployedSmartWalletPayload builds an EIP-3009 payment from a deployed smart-wallet payer: the
// signature is not 65 bytes, so classification routes to EIP-1271 and the simulation takes the
// bytes-signature transferWithAuthorization overload.
func deployedSmartWalletPayload() (types.PaymentPayload, types.PaymentRequirements) {
	payload := &evm.ExactEIP3009Payload{
		Signature: "0x" + strings.Repeat("cc", 66),
		Authorization: evm.ExactEIP3009Authorization{
			From:        roundTripPayer,
			To:          roundTripPayTo,
			Value:       "1000000",
			ValidAfter:  "0",
			ValidBefore: "99999999999",
			Nonce:       "0x" + strings.Repeat("00", 32),
		},
	}
	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:84532",
		Amount:  "1000000",
		Asset:   roundTripAsset,
		PayTo:   roundTripPayTo,
		Extra:   map[string]interface{}{"name": "USDC", "version": "2"},
	}
	return types.PaymentPayload{X402Version: 2, Payload: payload.ToMap(), Accepted: requirements}, requirements
}

func deployedSmartWalletSigner() *roundTripSigner {
	return newRoundTripSigner(map[string][]byte{
		strings.ToLower(roundTripAsset): {0x60, 0x60},
		strings.ToLower(roundTripPayer): {0x60, 0x60},
	})
}

// With EnableParallelVerifySimulation set, verify must issue the simulation without waiting for
// the payer's eth_getCode, which holds until that eth_call arrives.
func TestVerifyEIP3009_SimulationRunsConcurrentlyWithClassification(t *testing.T) {
	evm.ResetAssetContractCache()

	payload, requirements := deployedSmartWalletPayload()
	signer := deployedSmartWalletSigner()
	signer.blockGetCodeFor = roundTripPayer

	scheme := NewExactEvmScheme(signer, &ExactEvmSchemeConfig{EnableParallelVerifySimulation: true})
	if _, err := scheme.Verify(context.Background(), payload, requirements, nil); err != nil {
		t.Fatalf("expected verify to succeed, got: %v", err)
	}

	if signer.gaveUpWaiting() {
		t.Fatal("payer eth_getCode completed before the transfer simulation was issued: " +
			"the simulation is running sequentially after classification")
	}
	if got := signer.readCount(evm.FunctionTransferWithAuthorization); got != 1 {
		t.Fatalf("expected exactly 1 transfer simulation, got %d", got)
	}
}

// Control for the test above: an unconfigured scheme must keep the sequential order, so a mock
// that signalled the rendezvous early cannot make that assertion vacuous.
func TestVerifyEIP3009_ParallelSimulationIsOptIn(t *testing.T) {
	evm.ResetAssetContractCache()

	payload, requirements := deployedSmartWalletPayload()
	signer := deployedSmartWalletSigner()
	signer.blockGetCodeFor = roundTripPayer
	signer.blockTimeout = 150 * time.Millisecond

	scheme := NewExactEvmScheme(signer, nil)
	if _, err := scheme.Verify(context.Background(), payload, requirements, nil); err != nil {
		t.Fatalf("expected verify to succeed, got: %v", err)
	}

	if !signer.gaveUpWaiting() {
		t.Fatal("expected the transfer simulation to wait for classification unless " +
			"EnableParallelVerifySimulation is set")
	}
}

// Permit2's standard settle() simulation must likewise start before the payer's eth_getCode
// resolves. The gas-sponsoring branches are excluded from the head start and absent here.
func TestVerifyPermit2_SimulationRunsConcurrentlyWithSignatureCheck(t *testing.T) {
	evm.ResetAssetContractCache()

	payload, requirements, permit2Payload := plainPermit2Payload()
	signer := newRoundTripSigner(map[string][]byte{
		strings.ToLower(testToken): {0x60, 0x60},
		strings.ToLower(testPayer): {0x60, 0x60}, // deployed, so the signature check falls through
	})
	signer.blockGetCodeFor = testPayer

	opts := &VerifyPermit2Options{EnableParallelSimulation: true}
	_, err := VerifyPermit2(context.Background(), signer, payload, requirements, permit2Payload, nil, opts)
	if err != nil {
		t.Fatalf("expected verify to succeed, got: %v", err)
	}

	if signer.gaveUpWaiting() {
		t.Fatal("payer eth_getCode completed before the settle simulation was issued: " +
			"the simulation is running sequentially after the signature check")
	}
	if got := signer.readCount(evm.FunctionSettle); got != 1 {
		t.Fatalf("expected exactly 1 settle simulation, got %d", got)
	}
}

// The control for the Permit2 test above: nil options must keep the sequential order.
func TestVerifyPermit2_ParallelSimulationIsOptIn(t *testing.T) {
	evm.ResetAssetContractCache()

	payload, requirements, permit2Payload := plainPermit2Payload()
	signer := newRoundTripSigner(map[string][]byte{
		strings.ToLower(testToken): {0x60, 0x60},
		strings.ToLower(testPayer): {0x60, 0x60},
	})
	signer.blockGetCodeFor = testPayer
	signer.blockTimeout = 150 * time.Millisecond

	_, err := VerifyPermit2(context.Background(), signer, payload, requirements, permit2Payload, nil, nil)
	if err != nil {
		t.Fatalf("expected verify to succeed, got: %v", err)
	}

	if !signer.gaveUpWaiting() {
		t.Fatal("expected the settle simulation to wait for the signature check unless " +
			"EnableParallelSimulation is set")
	}
}

// The asset check is cached across payments; the payer's code is not, being mutable under
// ERC-6492.
func TestVerifyEIP3009_AssetContractCheckIsCachedButPayerCodeIsNot(t *testing.T) {
	evm.ResetAssetContractCache()

	payload, requirements := deployedSmartWalletPayload()
	signer := deployedSmartWalletSigner()
	scheme := NewExactEvmScheme(signer, nil)

	for attempt := 1; attempt <= 3; attempt++ {
		if _, err := scheme.Verify(context.Background(), payload, requirements, nil); err != nil {
			t.Fatalf("verify %d failed: %v", attempt, err)
		}
	}

	if got := signer.getCodeCount(roundTripAsset); got != 1 {
		t.Fatalf("expected the asset eth_getCode to be cached after the first verify, got %d calls", got)
	}
	if got := signer.getCodeCount(roundTripPayer); got != 3 {
		t.Fatalf("expected one payer eth_getCode per verify (never cached), got %d calls", got)
	}
}

// The same address can hold bytecode on one chain and nothing on another, so a hit on one
// network must not answer for another.
func TestValidateAssetIsContract_CacheIsScopedPerNetwork(t *testing.T) {
	evm.ResetAssetContractCache()

	payload, requirements := deployedSmartWalletPayload()
	signer := deployedSmartWalletSigner()
	scheme := NewExactEvmScheme(signer, nil)

	if _, err := scheme.Verify(context.Background(), payload, requirements, nil); err != nil {
		t.Fatalf("verify on the first network failed: %v", err)
	}

	const otherNetwork = "eip155:8453"
	requirements.Network = otherNetwork
	payload.Accepted.Network = otherNetwork

	if _, err := scheme.Verify(context.Background(), payload, requirements, nil); err != nil {
		t.Fatalf("verify on the second network failed: %v", err)
	}

	if got := signer.getCodeCount(roundTripAsset); got != 2 {
		t.Fatalf("expected the asset to be re-checked on a different network, got %d calls", got)
	}
}

// Settle's ERC-6492 branch must decide whether to deploy from the code lookup verify already
// performed, not a second eth_getCode for the same payer.
func TestSettleEIP3009_ReusesVerifyPayerCodeOnErc6492Path(t *testing.T) {
	evm.ResetAssetContractCache()

	const factory = "0xca11bde05977b3631167028862be2a173976ca11"
	payload, requirements := counterfactualErc6492Payload(t)
	payer := payload.Payload["authorization"].(map[string]interface{})["from"].(string)

	signer := newRoundTripSigner(map[string][]byte{
		strings.ToLower(requirements.Asset): {0x60, 0x60}, // asset is deployed
		strings.ToLower(payer):              {},           // payer is counterfactual
	})
	scheme := NewExactEvmScheme(signer, &ExactEvmSchemeConfig{
		EIP6492AllowedFactories: []string{factory},
	})

	resp, err := scheme.Settle(context.Background(), payload, requirements, nil)
	if err != nil {
		t.Fatalf("expected settle to succeed, got: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected resp.Success = true, got %+v", resp)
	}

	if got := signer.getCodeCount(payer); got != 1 {
		t.Fatalf("expected a single payer eth_getCode across verify and settle, got %d calls", got)
	}
}

// Guards the premise the concurrency rests on: the simulation branches only on the locally
// parsed ERC-6492 wrapper, so it cannot depend on CodeDeployed, which is known only after
// eth_getCode. Were that to change, starting it before classification would be incorrect.
func TestSimulateEIP3009Transfer_IgnoresCodeDeployed(t *testing.T) {
	parsed, err := ParseEIP3009Authorization(evm.ExactEIP3009Authorization{
		From:        roundTripPayer,
		To:          roundTripPayTo,
		Value:       "1000000",
		ValidAfter:  "0",
		ValidBefore: "99999999999",
		Nonce:       "0x" + strings.Repeat("00", 32),
	})
	if err != nil {
		t.Fatalf("failed to parse authorization: %v", err)
	}

	innerSignature := common.FromHex("0x" + strings.Repeat("cc", 66))
	for _, codeDeployed := range []bool{false, true} {
		signer := newRoundTripSigner(nil)
		sigData := &evm.ERC6492SignatureData{InnerSignature: innerSignature, CodeDeployed: codeDeployed}

		ok, err := SimulateEIP3009Transfer(context.Background(), signer, roundTripAsset, parsed, sigData)
		if err != nil {
			t.Fatalf("simulation with CodeDeployed=%v failed: %v", codeDeployed, err)
		}
		if !ok {
			t.Fatalf("simulation with CodeDeployed=%v reported failure", codeDeployed)
		}
		if got := signer.readCount(evm.FunctionTransferWithAuthorization); got != 1 {
			t.Fatalf("CodeDeployed=%v: expected 1 transfer call, got %d", codeDeployed, got)
		}
	}
}
