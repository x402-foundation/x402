package facilitator

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"math/big"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// mockFacSigner is a FacilitatorEvmSigner whose chain reads and writes are scripted per test.
type mockFacSigner struct {
	addresses []string

	paymentStateHasCollected bool
	paymentStateCapturable   *big.Int
	paymentStateRefundable   *big.Int
	paymentStateErr          error
	// stalePaymentStateReads serves the empty pre-collect state this many times, then the fields above.
	stalePaymentStateReads int

	simulateErr map[string]error // escrow function name -> forced simulation error

	writeTx          string
	writeErr         map[string]error // escrow function name -> forced write error
	writtenFunctions []string
	afterWrite       func(function string)

	receipt    *evm.TransactionReceipt
	receiptErr error

	multicallSuccess bool

	code                   []byte
	isValidSignatureResult interface{}
	stateReads             int
	readFroms              []string
	writeFroms             []string

	readFunctions []string
	tokenBalance  *big.Int            // balanceOf through ReadContract
	balances      map[string]*big.Int // balanceOf inside a multicall, by lowercase account
	tokenStore    string

	simulateCalls func(from string, calls []SimulatedCall) ([]SimulatedCallResult, error)
	writeTarget   string
	writeGas      uint64
}

func newMockFacSigner(addresses ...string) *mockFacSigner {
	txHash := "0x" + strings.Repeat("de", 32)
	return &mockFacSigner{
		addresses:        addresses,
		simulateErr:      map[string]error{},
		writeErr:         map[string]error{},
		writeTx:          txHash,
		receipt:          &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash},
		multicallSuccess: true,
		balances:         map[string]*big.Int{},
	}
}

func (m *mockFacSigner) GetAddresses() []string { return m.addresses }

func (m *mockFacSigner) GetCode(_ context.Context, _ string) ([]byte, error) { return m.code, nil }

func init() { collectedReadDelay = time.Millisecond }

// packArgs ABI-encodes args as the real signer does, so a wrongly typed argument fails the test.
func packArgs(abiJSON []byte, function string, args []interface{}) error {
	parsed, err := abi.JSON(bytes.NewReader(abiJSON))
	if err != nil {
		return err
	}
	if _, err := parsed.Pack(function, args...); err != nil {
		return fmt.Errorf("failed to pack method call: %w", err)
	}
	return nil
}

func (m *mockFacSigner) ReadContract(_ context.Context, _ string, abiJSON []byte, functionName string, args ...interface{}) (interface{}, error) {
	if err := packArgs(abiJSON, functionName, args); err != nil {
		return nil, err
	}
	if functionName == "tryAggregate" {
		return m.tryAggregate(args)
	}
	if functionName == "isValidSignature" {
		return m.isValidSignatureResult, nil
	}
	m.readFunctions = append(m.readFunctions, functionName)
	switch functionName {
	case "balanceOf":
		return m.tokenBalance, nil
	case "getTokenStore":
		return common.HexToAddress(m.tokenStore), nil
	}
	if err := m.simulateErr[functionName]; err != nil {
		return nil, err
	}
	return nil, nil
}

// ReadContractFrom records the simulated sender so tests can assert it is the operator.
func (m *mockFacSigner) ReadContractFrom(ctx context.Context, from, address string, abiJSON []byte, functionName string, args ...interface{}) (interface{}, error) {
	m.readFroms = append(m.readFroms, from)
	return m.ReadContract(ctx, address, abiJSON, functionName, args...)
}

// WriteContractFrom records the sender so tests can assert it is the operator.
func (m *mockFacSigner) WriteContractFrom(ctx context.Context, from, target string, abiJSON []byte, function string, dataSuffix []byte, args ...interface{}) (string, error) {
	m.writeFroms = append(m.writeFroms, from)
	return m.WriteContract(ctx, target, abiJSON, function, dataSuffix, args...)
}

func (m *mockFacSigner) VerifyTypedData(context.Context, string, evm.TypedDataDomain, map[string][]evm.TypedDataField, string, map[string]interface{}, []byte) (bool, error) {
	return false, nil
}

func (m *mockFacSigner) WriteContract(_ context.Context, target string, abiJSON []byte, function string, _ []byte, args ...interface{}) (string, error) {
	m.writeTarget = target
	if err := packArgs(abiJSON, function, args); err != nil {
		return "", err
	}
	m.writtenFunctions = append(m.writtenFunctions, function)
	if err := m.writeErr[function]; err != nil {
		return "", err
	}
	if m.afterWrite != nil {
		m.afterWrite(function)
	}
	return m.writeTx, nil
}

// WriteContractWithGas makes the mock a GasLimitWriter.
func (m *mockFacSigner) WriteContractWithGas(ctx context.Context, target string, abiJSON []byte, function string, dataSuffix []byte, gas uint64, args ...interface{}) (string, error) {
	m.writeGas = gas
	return m.WriteContract(ctx, target, abiJSON, function, dataSuffix, args...)
}

// SimulateCalls makes the mock a CallSimulator.
func (m *mockFacSigner) SimulateCalls(_ context.Context, from string, calls []SimulatedCall) ([]SimulatedCallResult, error) {
	return m.simulateCalls(from, calls)
}

func (m *mockFacSigner) SendTransaction(context.Context, string, []byte) (string, error) {
	return m.writeTx, nil
}

func (m *mockFacSigner) WaitForTransactionReceipt(context.Context, string) (*evm.TransactionReceipt, error) {
	if m.receiptErr != nil {
		return nil, m.receiptErr
	}
	return m.receipt, nil
}

func (m *mockFacSigner) GetBalance(context.Context, string, string) (*big.Int, error) {
	return big.NewInt(0), nil
}

func (m *mockFacSigner) GetChainID(context.Context) (*big.Int, error) { return big.NewInt(84532), nil }

type aggregateResult = struct {
	Success    bool
	ReturnData []byte
}

// tryAggregate answers a Multicall3 batch: paymentState calls return the encoded state,
// any other call (a factory deploy) succeeds or fails per multicallSuccess.
func (m *mockFacSigner) tryAggregate(args []interface{}) (interface{}, error) {
	m.stateReads++
	if m.paymentStateErr != nil {
		return nil, m.paymentStateErr
	}
	escrow, err := abi.JSON(bytes.NewReader(authcapture.EscrowABIForDeployment(authcapture.ResolveAuthCaptureDeployment(""))))
	if err != nil {
		return nil, err
	}
	erc20, err := abi.JSON(bytes.NewReader(evm.ERC20BalanceOfABI))
	if err != nil {
		return nil, err
	}
	calls := reflect.ValueOf(args[1])
	results := make([]aggregateResult, calls.Len())
	for i := range results {
		callData := calls.Index(i).FieldByName("CallData").Bytes()
		if bytes.HasPrefix(callData, escrow.Methods["paymentState"].ID) {
			collected := m.paymentStateHasCollected
			capturable, refundable := m.paymentStateCapturable, m.paymentStateRefundable
			if m.stalePaymentStateReads > 0 {
				m.stalePaymentStateReads--
				collected = false
				capturable, refundable = big.NewInt(0), big.NewInt(0)
			}
			returnData, err := escrow.Methods["paymentState"].Outputs.Pack(collected, capturable, refundable)
			if err != nil {
				return nil, err
			}
			results[i] = aggregateResult{Success: true, ReturnData: returnData}
			continue
		}
		if bytes.HasPrefix(callData, erc20.Methods["balanceOf"].ID) {
			account := strings.ToLower(common.BytesToAddress(callData[len(callData)-20:]).Hex())
			balance := m.balances[account]
			if balance == nil {
				balance = new(big.Int)
			}
			returnData, err := erc20.Methods["balanceOf"].Outputs.Pack(balance)
			if err != nil {
				return nil, err
			}
			results[i] = aggregateResult{Success: true, ReturnData: returnData}
			continue
		}
		results[i] = aggregateResult{Success: m.multicallSuccess}
	}
	return results, nil
}

// revertError mimics a JSON-RPC error that carries revert data.
type revertError struct{ data string }

func (e revertError) Error() string          { return "execution reverted" }
func (e revertError) ErrorData() interface{} { return e.data }

// escrowRevert returns the RPC error for an AuthCaptureEscrow custom error with args.
func escrowRevert(t *testing.T, name string, args ...interface{}) error {
	t.Helper()
	deployment := authcapture.ResolveAuthCaptureDeployment("")
	contractABI, err := escrowABI(deployment)
	require.NoError(t, err)
	abiErr, ok := contractABI.Errors[name]
	require.True(t, ok, "escrow ABI declares %s", name)
	packed, err := abiErr.Inputs.Pack(args...)
	require.NoError(t, err)
	return revertError{data: "0x" + hex.EncodeToString(append(abiErr.ID.Bytes()[:4], packed...))}
}

var (
	facCaptureAuthorizer = "0x" + strings.Repeat("c", 40)
	facFeeRecipient      = "0x" + strings.Repeat("3", 40)
	facPayTo             = "0x" + strings.Repeat("2", 40)
	facAsset             = "0x" + strings.Repeat("a", 40)
)

var allowAllCustomOperators = []OperatorAllowlistEntry{{Address: OperatorAddressWildcard, OperatorType: authcapture.OperatorTypeCustom}}

const (
	facNetwork = "eip155:84532"
	facAmount  = "1000000"
)

func newKeySigner(t *testing.T) evm.ClientEvmSigner {
	t.Helper()
	key, err := crypto.GenerateKey()
	require.NoError(t, err)
	signer, err := evmsigners.NewClientSignerFromPrivateKey(hexutil.Encode(crypto.FromECDSA(key)))
	require.NoError(t, err)
	return signer
}

func facBaseRequirements(captureAuthorizer string, extraOverrides map[string]interface{}) types.PaymentRequirements {
	future := time.Now().Unix() + 86400
	extra := map[string]interface{}{
		"name":              "USDC",
		"version":           "2",
		"captureAuthorizer": captureAuthorizer,
		"feeRecipient":      facFeeRecipient,
		"minFeeBps":         float64(0),
		"maxFeeBps":         float64(100),
		"captureDeadline":   float64(future),
		"refundDeadline":    float64(future + 86400),
	}
	for k, v := range extraOverrides {
		extra[k] = v
	}
	return types.PaymentRequirements{
		Scheme:            authcapture.SchemeAuthCapture,
		Network:           facNetwork,
		Amount:            facAmount,
		Asset:             facAsset,
		PayTo:             facPayTo,
		MaxTimeoutSeconds: 3600,
		Extra:             extra,
	}
}

func newScheme(signer *mockFacSigner, config AuthCaptureEvmSchemeConfig) *AuthCaptureEvmScheme {
	// The constructor rejects a captureAuthorizer the signer does not hold.
	for _, address := range signer.addresses {
		if strings.EqualFold(address, facCaptureAuthorizer) {
			config.CaptureAuthorizer = facCaptureAuthorizer
		}
	}
	return NewAuthCaptureEvmScheme(signer, config)
}

// collectOpts tunes buildCollectPayload; zero values give a valid payload.
type collectOpts struct {
	validAfter  uint64
	validBefore int64 // absolute unix seconds; default now+3600
}

// buildCollectPayload builds a real-signature collect payload for the method in requirements.extra.
func buildCollectPayload(t *testing.T, requirements types.PaymentRequirements, payer evm.ClientEvmSigner, opts collectOpts) types.PaymentPayload {
	t.Helper()
	extra, deployment, err := authcapture.ParseAuthCaptureExtra(requirements)
	require.NoError(t, err)
	chainID, err := evm.GetEvmChainId(requirements.Network)
	require.NoError(t, err)

	validBefore := opts.validBefore
	if validBefore == 0 {
		validBefore = time.Now().Unix() + 3600
	}
	saltNonce, salt := "", "0x"+strings.Repeat("0", 64)
	if authcapture.IsSaltBindingOn(extra) {
		saltNonce = "0x01"
		salt, err = authcapture.DeriveBoundSalt(authcapture.ExtraAddress(extra.ReceiverAuthorizer), authcapture.ExtraAddress(extra.Policy), saltNonce)
		require.NoError(t, err)
	}

	paymentInfo := authcapture.ReconstructPaymentInfo(payer.Address(), uint64(validBefore), salt, requirements, extra)
	nonceHex, err := authcapture.ComputePayerAgnosticPaymentInfoHash(chainID, paymentInfo, deployment.Escrow)
	require.NoError(t, err)

	wire := map[string]interface{}{"salt": salt}
	var signature []byte
	if extra.AssetTransferMethod == methodPermit2 {
		nonce, err := authcapture.NonceHexToDecimalString(nonceHex)
		require.NoError(t, err)
		permit := authcapture.Permit2Authorization{
			From:      payer.Address(),
			Permitted: authcapture.Permit2TokenPermissions{Token: requirements.Asset, Amount: requirements.Amount},
			Spender:   deployment.Permit2Collector,
			Nonce:     nonce,
			Deadline:  strconv.FormatInt(validBefore, 10),
		}
		signature, err = authcapture.SignPermit2(context.Background(), payer, permit, chainID)
		require.NoError(t, err)
		wire["permit2Authorization"] = map[string]interface{}{
			"from":      permit.From,
			"permitted": map[string]interface{}{"token": permit.Permitted.Token, "amount": permit.Permitted.Amount},
			"spender":   permit.Spender,
			"nonce":     permit.Nonce,
			"deadline":  permit.Deadline,
		}
	} else {
		authorization := authcapture.Eip3009Authorization{
			From:        payer.Address(),
			To:          deployment.EIP3009Collector,
			Value:       requirements.Amount,
			ValidAfter:  strconv.FormatUint(opts.validAfter, 10),
			ValidBefore: strconv.FormatInt(validBefore, 10),
			Nonce:       nonceHex,
		}
		signature, err = authcapture.SignERC3009(context.Background(), payer, authorization, extra, requirements.Asset, chainID)
		require.NoError(t, err)
		wire["authorization"] = map[string]interface{}{
			"from":        authorization.From,
			"to":          authorization.To,
			"value":       authorization.Value,
			"validAfter":  authorization.ValidAfter,
			"validBefore": authorization.ValidBefore,
			"nonce":       authorization.Nonce,
		}
	}
	wire["signature"] = evm.BytesToHex(signature)
	if saltNonce != "" {
		wire["saltNonce"] = saltNonce
	}
	return types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: wire}
}

func assertVerifyReason(t *testing.T, err error, reason string) {
	t.Helper()
	require.Error(t, err)
	ve := &x402.VerifyError{}
	require.ErrorAs(t, err, &ve)
	assert.Equal(t, reason, ve.InvalidReason)
}

func assertSettleReason(t *testing.T, err error, reason string) {
	t.Helper()
	require.Error(t, err)
	se := &x402.SettleError{}
	require.ErrorAs(t, err, &se)
	assert.Equal(t, reason, se.ErrorReason)
}

// lifecycleFixture is a capture/void test setup: requirements with a real receiverAuthorizer
// and a matching PaymentInfo the mock reports as collected.
type lifecycleFixture struct {
	requirements types.PaymentRequirements
	extra        authcapture.AuthCaptureExtra
	deployment   authcapture.AuthCaptureDeployment
	chainID      *big.Int
	paymentInfo  authcapture.PaymentInfoStruct
	receiver     evm.ClientEvmSigner
	saltNonce    string
	paymentHash  string
}

func newLifecycleFixture(t *testing.T, extraOverrides map[string]interface{}) lifecycleFixture {
	t.Helper()
	receiver := newKeySigner(t)
	overrides := map[string]interface{}{"receiverAuthorizer": receiver.Address()}
	for k, v := range extraOverrides {
		overrides[k] = v
	}
	requirements := facBaseRequirements(facCaptureAuthorizer, overrides)
	extra, deployment, err := authcapture.ParseAuthCaptureExtra(requirements)
	require.NoError(t, err)

	saltNonce := "0x01"
	salt, err := authcapture.DeriveBoundSalt(receiver.Address(), authcapture.ExtraAddress(""), saltNonce)
	require.NoError(t, err)

	paymentInfo := authcapture.ReconstructPaymentInfo(newKeySigner(t).Address(), extra.CaptureDeadline-1, salt, requirements, extra)
	chainID, err := evm.GetEvmChainId(requirements.Network)
	require.NoError(t, err)
	paymentHash, err := authcapture.ComputePaymentInfoHash(chainID, paymentInfo, paymentInfo.Payer, deployment.Escrow)
	require.NoError(t, err)

	return lifecycleFixture{
		requirements: requirements,
		extra:        extra,
		deployment:   deployment,
		chainID:      chainID,
		paymentInfo:  paymentInfo,
		receiver:     receiver,
		saltNonce:    saltNonce,
		paymentHash:  paymentHash,
	}
}

func (fx lifecycleFixture) signer() *mockFacSigner {
	signer := newMockFacSigner(fx.extra.CaptureAuthorizer)
	signer.paymentStateHasCollected = true
	signer.paymentStateCapturable, _ = new(big.Int).SetString(fx.paymentInfo.MaxAmount, 10)
	signer.paymentStateRefundable = big.NewInt(0)
	return signer
}

func (fx lifecycleFixture) payload(wire map[string]interface{}) types.PaymentPayload {
	return types.PaymentPayload{X402Version: 2, Accepted: fx.requirements, Payload: wire}
}

func (fx lifecycleFixture) voidSignature(t *testing.T) string {
	t.Helper()
	sig, err := authcapture.SignVoid(context.Background(), fx.receiver, fx.extra.CaptureAuthorizer, fx.chainID, fx.paymentHash)
	require.NoError(t, err)
	return evm.BytesToHex(sig)
}

// captureOpts tunes buildCapture; zero values capture the full hold with the default fee.
type captureOpts struct {
	amount             string
	expectedCapturable string
	feeBps             *uint16  // v1.0 fee; nil selects the deployment default
	feeAmount          *big.Int // v1.1 fee; nil selects the deployment default
	withVoid           bool
	feeReceiver        string
}

func (fx lifecycleFixture) buildCapture(t *testing.T, opts captureOpts) map[string]interface{} {
	t.Helper()
	if opts.amount == "" {
		opts.amount = fx.paymentInfo.MaxAmount
	}
	if opts.expectedCapturable == "" {
		opts.expectedCapturable = fx.paymentInfo.MaxAmount
	}
	if opts.feeReceiver == "" {
		opts.feeReceiver = fx.extra.FeeRecipient
	}
	amount, _ := new(big.Int).SetString(opts.amount, 10)
	expectedCapturable, _ := new(big.Int).SetString(opts.expectedCapturable, 10)

	fee := authcapture.DefaultCaptureFee(&fx.deployment, amount, fx.extra.MinFeeBps)
	if opts.feeBps != nil {
		fee = authcapture.CaptureFee{Bps: opts.feeBps}
	}
	if opts.feeAmount != nil {
		fee = authcapture.CaptureFee{Amount: opts.feeAmount}
	}
	signature, err := authcapture.SignCapture(context.Background(), fx.receiver, &fx.deployment, fx.extra.CaptureAuthorizer, fx.chainID,
		authcapture.CaptureParams{
			PaymentInfoHash:    fx.paymentHash,
			Amount:             amount,
			Fee:                fee,
			FeeReceiver:        opts.feeReceiver,
			ExpectedCapturable: expectedCapturable,
			ExpectedRefundable: big.NewInt(0),
		})
	require.NoError(t, err)

	paymentInfo, err := fx.paymentInfo.ToWireMap()
	require.NoError(t, err)
	wire := map[string]interface{}{
		"type":                     "capture",
		"paymentInfo":              paymentInfo,
		"saltNonce":                fx.saltNonce,
		"amount":                   opts.amount,
		"feeReceiver":              opts.feeReceiver,
		"expectedCapturableAmount": opts.expectedCapturable,
		"expectedRefundableAmount": "0",
		"authorizerSignature":      evm.BytesToHex(signature),
	}
	fee.AddToWire(wire)
	if opts.withVoid {
		wire["voidAuthorizerSignature"] = fx.voidSignature(t)
	}
	return wire
}

func (fx lifecycleFixture) buildVoid(t *testing.T) map[string]interface{} {
	t.Helper()
	paymentInfo, err := fx.paymentInfo.ToWireMap()
	require.NoError(t, err)
	return map[string]interface{}{
		"type":                "void",
		"paymentInfo":         paymentInfo,
		"saltNonce":           fx.saltNonce,
		"authorizerSignature": fx.voidSignature(t),
	}
}
