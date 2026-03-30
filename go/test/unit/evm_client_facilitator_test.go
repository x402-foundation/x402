package unit_test

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/coinbase/x402/go/mechanisms/evm"
	evmclient "github.com/coinbase/x402/go/mechanisms/evm/exact/client"
	evmfacilitator "github.com/coinbase/x402/go/mechanisms/evm/exact/facilitator"
	evmv1facilitator "github.com/coinbase/x402/go/mechanisms/evm/exact/v1/facilitator"
	"github.com/coinbase/x402/go/types"
)

// =========================================================================
// Mock Signers for Unit Tests
// =========================================================================

// mockClientSigner implements evm.ClientEvmSigner for testing
type mockClientSigner struct {
	address   string
	signError error
}

func (m *mockClientSigner) Address() string {
	if m.address == "" {
		return "0x1234567890123456789012345678901234567890"
	}
	return m.address
}

func (m *mockClientSigner) SignTypedData(
	ctx context.Context,
	domain evm.TypedDataDomain,
	types map[string][]evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	if m.signError != nil {
		return nil, m.signError
	}
	// Return a valid 65-byte mock signature
	sig := make([]byte, 65)
	sig[64] = 27 // v value
	return sig, nil
}

func (m *mockClientSigner) ReadContract(
	ctx context.Context,
	address string,
	abi []byte,
	functionName string,
	args ...interface{},
) (interface{}, error) {
	switch functionName {
	case "nonces":
		return big.NewInt(0), nil
	case "allowance":
		return big.NewInt(0), nil
	default:
		return nil, fmt.Errorf("mock ReadContract: unsupported function %s", functionName)
	}
}

// mockFacilitatorSigner implements evm.FacilitatorEvmSigner for testing
type mockFacilitatorSigner struct {
	balance                *big.Int
	allowance              *big.Int
	chainID                *big.Int
	writeContractTxHash    string
	writeContractError     error
	sendTransactionError   error
	receiptStatus          uint64
	receiptError           error
	readContractError      error
	readContractFn         func(contractAddress string, abi []byte, functionName string, args ...interface{}) (interface{}, error)
	verifyTypedDataResult  bool
	verifyTypedDataError   error
	code                   []byte
	getCodeError           error
	authorizationStateUsed bool
	lastWriteFunctionName  string
}

func (m *mockFacilitatorSigner) GetAddresses() []string {
	return []string{"0xfacilitator1234567890123456789012345678"}
}

func (m *mockFacilitatorSigner) GetBalance(ctx context.Context, address, tokenAddress string) (*big.Int, error) {
	if m.balance == nil {
		return big.NewInt(1000000000000), nil // Default large balance
	}
	return m.balance, nil
}

func (m *mockFacilitatorSigner) GetChainID(ctx context.Context) (*big.Int, error) {
	if m.chainID == nil {
		return big.NewInt(84532), nil // Base Sepolia
	}
	return m.chainID, nil
}

func (m *mockFacilitatorSigner) GetCode(ctx context.Context, address string) ([]byte, error) {
	if m.getCodeError != nil {
		return nil, m.getCodeError
	}
	return m.code, nil
}

func (m *mockFacilitatorSigner) ReadContract(
	ctx context.Context,
	contractAddress string,
	abi []byte,
	functionName string,
	args ...interface{},
) (interface{}, error) {
	if m.readContractFn != nil {
		return m.readContractFn(contractAddress, abi, functionName, args...)
	}
	if m.readContractError != nil {
		return nil, m.readContractError
	}

	// Handle specific function calls
	switch functionName {
	case "allowance":
		if m.allowance == nil {
			return evm.MaxUint256(), nil // Default max allowance
		}
		return m.allowance, nil
	case "authorizationState":
		return m.authorizationStateUsed, nil
	case "isValidSignature":
		// EIP-1271 magic value
		return []byte{0x16, 0x26, 0xba, 0x7e}, nil
	default:
		return nil, fmt.Errorf("unsupported function: %s", functionName)
	}
}

func (m *mockFacilitatorSigner) WriteContract(
	ctx context.Context,
	contractAddress string,
	abi []byte,
	functionName string,
	args ...interface{},
) (string, error) {
	m.lastWriteFunctionName = functionName
	if m.writeContractError != nil {
		return "", m.writeContractError
	}
	if m.writeContractTxHash == "" {
		return "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", nil
	}
	return m.writeContractTxHash, nil
}

func (m *mockFacilitatorSigner) SendTransaction(ctx context.Context, to string, data []byte) (string, error) {
	if m.sendTransactionError != nil {
		return "", m.sendTransactionError
	}
	return "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", nil
}

func (m *mockFacilitatorSigner) WaitForTransactionReceipt(ctx context.Context, txHash string) (*evm.TransactionReceipt, error) {
	if m.receiptError != nil {
		return nil, m.receiptError
	}
	status := m.receiptStatus
	if status == 0 {
		status = evm.TxStatusSuccess
	}
	return &evm.TransactionReceipt{
		Status:      status,
		BlockNumber: 1,
		TxHash:      txHash,
	}, nil
}

func (m *mockFacilitatorSigner) VerifyTypedData(
	ctx context.Context,
	address string,
	domain evm.TypedDataDomain,
	types map[string][]evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
	signature []byte,
) (bool, error) {
	if m.verifyTypedDataError != nil {
		return false, m.verifyTypedDataError
	}
	return m.verifyTypedDataResult, nil
}

// =========================================================================
// Client Tests
// =========================================================================

// TestExactEvmSchemeScheme tests the Scheme() method
func TestExactEvmSchemeScheme(t *testing.T) {
	signer := &mockClientSigner{}
	client := evmclient.NewExactEvmScheme(signer, nil)

	if client.Scheme() != evm.SchemeExact {
		t.Errorf("Expected scheme %s, got %s", evm.SchemeExact, client.Scheme())
	}
}

// TestCreatePaymentPayloadEIP3009 tests EIP-3009 payload creation
func TestCreatePaymentPayloadEIP3009(t *testing.T) {
	ctx := context.Background()
	signer := &mockClientSigner{address: "0xClientAddress1234567890123456789012"}
	client := evmclient.NewExactEvmScheme(signer, nil)

	t.Run("Creates valid EIP-3009 payload", func(t *testing.T) {
		requirements := types.PaymentRequirements{
			Scheme:            evm.SchemeExact,
			Network:           "eip155:84532",
			Asset:             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Amount:            "1000000",
			PayTo:             "0x9876543210987654321098765432109876543210",
			MaxTimeoutSeconds: 300,
			Extra: map[string]interface{}{
				"name":    "USDC",
				"version": "2",
			},
		}

		payload, err := client.CreatePaymentPayload(ctx, requirements)
		if err != nil {
			t.Fatalf("Failed to create payload: %v", err)
		}

		if payload.X402Version != 2 {
			t.Errorf("Expected version 2, got %d", payload.X402Version)
		}

		// Should be EIP-3009 by default
		if evm.IsPermit2Payload(payload.Payload) {
			t.Error("Expected EIP-3009 payload, got Permit2")
		}

		if !evm.IsEIP3009Payload(payload.Payload) {
			t.Error("Expected EIP-3009 payload")
		}

		// Parse and verify
		eip3009Payload, err := evm.PayloadFromMap(payload.Payload)
		if err != nil {
			t.Fatalf("Failed to parse payload: %v", err)
		}

		if eip3009Payload.Authorization.From != signer.Address() {
			t.Errorf("From mismatch: expected %s, got %s", signer.Address(), eip3009Payload.Authorization.From)
		}

		if eip3009Payload.Authorization.Value != "1000000" {
			t.Errorf("Value mismatch: expected 1000000, got %s", eip3009Payload.Authorization.Value)
		}

		// Should have signature
		if eip3009Payload.Signature == "" {
			t.Error("Expected signature")
		}
	})

	t.Run("Fails for invalid network", func(t *testing.T) {
		requirements := types.PaymentRequirements{
			Scheme:  evm.SchemeExact,
			Network: "invalid:network",
			Asset:   "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Amount:  "1000000",
			PayTo:   "0x9876543210987654321098765432109876543210",
		}

		_, err := client.CreatePaymentPayload(ctx, requirements)
		if err == nil {
			t.Error("Expected error for invalid network")
		}
	})

	t.Run("Works with explicit asset address on any network", func(t *testing.T) {
		requirements := types.PaymentRequirements{
			Scheme:            evm.SchemeExact,
			Network:           "eip155:999999", // Arbitrary network
			Asset:             "0x1234567890123456789012345678901234567890",
			Amount:            "1000000",
			PayTo:             "0x9876543210987654321098765432109876543210",
			MaxTimeoutSeconds: 300,
			Extra: map[string]interface{}{
				"name":    "TestToken",
				"version": "1",
			},
		}

		payload, err := client.CreatePaymentPayload(ctx, requirements)
		if err != nil {
			t.Fatalf("Failed to create payload for arbitrary network: %v", err)
		}

		if payload.X402Version != 2 {
			t.Errorf("Expected version 2, got %d", payload.X402Version)
		}
	})
}

// TestCreatePaymentPayloadPermit2 tests Permit2 payload creation
func TestCreatePaymentPayloadPermit2(t *testing.T) {
	ctx := context.Background()
	signer := &mockClientSigner{address: "0xClientAddress1234567890123456789012"}
	client := evmclient.NewExactEvmScheme(signer, nil)

	t.Run("Creates valid Permit2 payload", func(t *testing.T) {
		requirements := types.PaymentRequirements{
			Scheme:            evm.SchemeExact,
			Network:           "eip155:84532",
			Asset:             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Amount:            "1000000",
			PayTo:             "0x9876543210987654321098765432109876543210",
			MaxTimeoutSeconds: 300,
			Extra: map[string]interface{}{
				"assetTransferMethod": "permit2",
			},
		}

		payload, err := client.CreatePaymentPayload(ctx, requirements)
		if err != nil {
			t.Fatalf("Failed to create payload: %v", err)
		}

		if payload.X402Version != 2 {
			t.Errorf("Expected version 2, got %d", payload.X402Version)
		}

		// Should be Permit2
		if !evm.IsPermit2Payload(payload.Payload) {
			t.Error("Expected Permit2 payload")
		}

		// Parse and verify
		permit2Payload, err := evm.Permit2PayloadFromMap(payload.Payload)
		if err != nil {
			t.Fatalf("Failed to parse payload: %v", err)
		}

		if permit2Payload.Permit2Authorization.From != signer.Address() {
			t.Errorf("From mismatch: expected %s, got %s", signer.Address(), permit2Payload.Permit2Authorization.From)
		}

		if permit2Payload.Permit2Authorization.Spender != evm.X402ExactPermit2ProxyAddress {
			t.Errorf("Spender mismatch: expected %s, got %s", evm.X402ExactPermit2ProxyAddress, permit2Payload.Permit2Authorization.Spender)
		}

		// Witness.To should match PayTo
		expectedTo := evm.NormalizeAddress(requirements.PayTo)
		if permit2Payload.Permit2Authorization.Witness.To != expectedTo {
			t.Errorf("Witness.To mismatch: expected %s, got %s", expectedTo, permit2Payload.Permit2Authorization.Witness.To)
		}

		// Should have signature
		if permit2Payload.Signature == "" {
			t.Error("Expected signature")
		}
	})

	t.Run("Routes based on assetTransferMethod", func(t *testing.T) {
		// EIP-3009 by default
		reqEIP3009 := types.PaymentRequirements{
			Scheme:            evm.SchemeExact,
			Network:           "eip155:84532",
			Asset:             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Amount:            "1000000",
			PayTo:             "0x9876543210987654321098765432109876543210",
			MaxTimeoutSeconds: 300,
		}

		payloadEIP3009, _ := client.CreatePaymentPayload(ctx, reqEIP3009)
		if !evm.IsEIP3009Payload(payloadEIP3009.Payload) {
			t.Error("Expected EIP-3009 when assetTransferMethod not specified")
		}

		// Explicit eip3009
		reqExplicitEIP3009 := types.PaymentRequirements{
			Scheme:            evm.SchemeExact,
			Network:           "eip155:84532",
			Asset:             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Amount:            "1000000",
			PayTo:             "0x9876543210987654321098765432109876543210",
			MaxTimeoutSeconds: 300,
			Extra: map[string]interface{}{
				"assetTransferMethod": "eip3009",
			},
		}

		payloadExplicitEIP3009, _ := client.CreatePaymentPayload(ctx, reqExplicitEIP3009)
		if !evm.IsEIP3009Payload(payloadExplicitEIP3009.Payload) {
			t.Error("Expected EIP-3009 when assetTransferMethod is eip3009")
		}

		// Permit2
		reqPermit2 := types.PaymentRequirements{
			Scheme:            evm.SchemeExact,
			Network:           "eip155:84532",
			Asset:             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Amount:            "1000000",
			PayTo:             "0x9876543210987654321098765432109876543210",
			MaxTimeoutSeconds: 300,
			Extra: map[string]interface{}{
				"assetTransferMethod": "permit2",
			},
		}

		payloadPermit2, _ := client.CreatePaymentPayload(ctx, reqPermit2)
		if !evm.IsPermit2Payload(payloadPermit2.Payload) {
			t.Error("Expected Permit2 when assetTransferMethod is permit2")
		}
	})
}

// TestGetPermit2AllowanceReadParams tests the helper function
func TestGetPermit2AllowanceReadParams(t *testing.T) {
	params := evmclient.Permit2AllowanceParams{
		TokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		OwnerAddress: "0x1234567890123456789012345678901234567890",
	}

	address, abi, functionName, args := evmclient.GetPermit2AllowanceReadParams(params)

	if address != evm.NormalizeAddress(params.TokenAddress) {
		t.Errorf("Address mismatch: %s", address)
	}

	if functionName != "allowance" {
		t.Errorf("Function name mismatch: %s", functionName)
	}

	if len(args) != 2 {
		t.Errorf("Expected 2 args, got %d", len(args))
	}

	// Second arg should be Permit2 address
	if args[1] != evm.PERMIT2Address {
		t.Errorf("Second arg should be Permit2 address, got %v", args[1])
	}

	// ABI should be valid
	if len(abi) == 0 {
		t.Error("Expected ABI to be non-empty")
	}
}

// TestCreatePermit2ApprovalTxData tests the approval helper
func TestCreatePermit2ApprovalTxData(t *testing.T) {
	tokenAddress := "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

	to, abi, functionName, args := evmclient.CreatePermit2ApprovalTxData(tokenAddress)

	if to != evm.NormalizeAddress(tokenAddress) {
		t.Errorf("To mismatch: %s", to)
	}

	if functionName != "approve" {
		t.Errorf("Function name mismatch: %s", functionName)
	}

	if len(args) != 2 {
		t.Errorf("Expected 2 args, got %d", len(args))
	}

	// First arg should be Permit2 address
	if args[0] != evm.PERMIT2Address {
		t.Errorf("First arg should be Permit2 address, got %v", args[0])
	}

	// Second arg should be max uint256
	maxUint, ok := args[1].(*big.Int)
	if !ok {
		t.Error("Second arg should be *big.Int")
	} else if maxUint.Cmp(evm.MaxUint256()) != 0 {
		t.Error("Second arg should be MaxUint256")
	}

	// ABI should be valid
	if len(abi) == 0 {
		t.Error("Expected ABI to be non-empty")
	}
}

// =========================================================================
// Facilitator Tests
// =========================================================================

// Helper function to create a mock signature (65 bytes hex)
func mockSignature65Bytes() string {
	return "0x" + strings.Repeat("00", 65)
}

type mockMulticallResult struct {
	Success    bool
	ReturnData []byte
}

func defaultEIP3009Requirements() types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:  evm.SchemeExact,
		Network: "eip155:84532",
		Asset:   "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		Amount:  "1000000",
		PayTo:   "0x9876543210987654321098765432109876543210",
		Extra: map[string]interface{}{
			"name":    "USDC",
			"version": "2",
		},
	}
}

func defaultEIP3009Payload(signature string) types.PaymentPayload {
	return types.PaymentPayload{
		X402Version: 2,
		Accepted: types.PaymentRequirements{
			Scheme:  evm.SchemeExact,
			Network: "eip155:84532",
		},
		Payload: map[string]interface{}{
			"signature": signature,
			"authorization": map[string]interface{}{
				"from":        "0x1234567890123456789012345678901234567890",
				"to":          "0x9876543210987654321098765432109876543210",
				"value":       "1000000",
				"validAfter":  "0",
				"validBefore": "99999999999",
				"nonce":       "0x0000000000000000000000000000000000000000000000000000000000000001",
			},
		},
	}
}

func defaultEIP3009RequirementsV1(t *testing.T) types.PaymentRequirementsV1 {
	t.Helper()

	extra, err := json.Marshal(map[string]interface{}{
		"name":    "USDC",
		"version": "2",
	})
	if err != nil {
		t.Fatalf("failed to marshal v1 extra: %v", err)
	}

	raw := json.RawMessage(extra)
	return types.PaymentRequirementsV1{
		Scheme:            evm.SchemeExact,
		Network:           "base-sepolia",
		MaxAmountRequired: "1000000",
		PayTo:             "0x9876543210987654321098765432109876543210",
		Asset:             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		Extra:             &raw,
	}
}

func defaultEIP3009PayloadV1(signature string) types.PaymentPayloadV1 {
	return types.PaymentPayloadV1{
		X402Version: 1,
		Scheme:      evm.SchemeExact,
		Network:     "base-sepolia",
		Payload:     defaultEIP3009Payload(signature).Payload,
	}
}

func packABIOutput(t *testing.T, abiBytes []byte, functionName string, values ...interface{}) []byte {
	t.Helper()

	contractABI, err := abi.JSON(strings.NewReader(string(abiBytes)))
	if err != nil {
		t.Fatalf("failed to parse ABI for %s: %v", functionName, err)
	}

	data, err := contractABI.Methods[functionName].Outputs.Pack(values...)
	if err != nil {
		t.Fatalf("failed to pack output for %s: %v", functionName, err)
	}

	return data
}

func wrapERC6492SignatureForTest(t *testing.T, factory common.Address, factoryData []byte, originalSig []byte) string {
	t.Helper()

	addressTy, err := abi.NewType("address", "", nil)
	if err != nil {
		t.Fatalf("failed to create address ABI type: %v", err)
	}
	bytesTy, err := abi.NewType("bytes", "", nil)
	if err != nil {
		t.Fatalf("failed to create bytes ABI type: %v", err)
	}

	arguments := abi.Arguments{
		{Type: addressTy},
		{Type: bytesTy},
		{Type: bytesTy},
	}

	packed, err := arguments.Pack(factory, factoryData, originalSig)
	if err != nil {
		t.Fatalf("failed to pack ERC-6492 signature: %v", err)
	}

	return "0x" + fmt.Sprintf("%x%x", packed, common.Hex2Bytes(evm.ERC6492MagicValue[2:]))
}

// TestVerifyPermit2InvalidInputs tests validation in VerifyPermit2
func TestVerifyPermit2InvalidInputs(t *testing.T) {
	ctx := context.Background()
	signer := &mockFacilitatorSigner{
		verifyTypedDataResult: true,
	}

	validPayload := types.PaymentPayload{
		X402Version: 2,
		Accepted: types.PaymentRequirements{
			Scheme:  evm.SchemeExact,
			Network: "eip155:84532",
		},
	}

	validRequirements := types.PaymentRequirements{
		Scheme:  evm.SchemeExact,
		Network: "eip155:84532",
		Asset:   "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		Amount:  "1000000",
		PayTo:   "0x9876543210987654321098765432109876543210",
	}

	t.Run("Rejects invalid spender", func(t *testing.T) {
		permit2Payload := &evm.ExactPermit2Payload{
			Signature: mockSignature65Bytes(),
			Permit2Authorization: evm.Permit2Authorization{
				From:    "0x1234567890123456789012345678901234567890",
				Spender: "0xWrongSpender12345678901234567890123456", // Wrong spender!
				Permitted: evm.Permit2TokenPermissions{
					Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
					Amount: "1000000",
				},
				Nonce:    "12345",
				Deadline: "9999999999",
				Witness:  defaultTestWitness(),
			},
		}

		_, err := evmfacilitator.VerifyPermit2(ctx, signer, validPayload, validRequirements, permit2Payload, nil, nil)
		if err == nil {
			t.Error("Expected error for invalid spender")
		}
	})

	t.Run("Rejects recipient mismatch", func(t *testing.T) {
		permit2Payload := &evm.ExactPermit2Payload{
			Signature: mockSignature65Bytes(),
			Permit2Authorization: evm.Permit2Authorization{
				From:    "0x1234567890123456789012345678901234567890",
				Spender: evm.X402ExactPermit2ProxyAddress,
				Permitted: evm.Permit2TokenPermissions{
					Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
					Amount: "1000000",
				},
				Nonce:    "12345",
				Deadline: "9999999999",
				Witness: evm.Permit2Witness{
					To:         "0xWrongRecipient23456789012345678901234567", // Wrong recipient!
					ValidAfter: "0",
				},
			},
		}

		_, err := evmfacilitator.VerifyPermit2(ctx, signer, validPayload, validRequirements, permit2Payload, nil, nil)
		if err == nil {
			t.Error("Expected error for recipient mismatch")
		}
	})

	t.Run("Rejects expired deadline", func(t *testing.T) {
		permit2Payload := &evm.ExactPermit2Payload{
			Signature: mockSignature65Bytes(),
			Permit2Authorization: evm.Permit2Authorization{
				From:    "0x1234567890123456789012345678901234567890",
				Spender: evm.X402ExactPermit2ProxyAddress,
				Permitted: evm.Permit2TokenPermissions{
					Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
					Amount: "1000000",
				},
				Nonce:    "12345",
				Deadline: "1", // Expired!
				Witness:  defaultTestWitness(),
			},
		}

		_, err := evmfacilitator.VerifyPermit2(ctx, signer, validPayload, validRequirements, permit2Payload, nil, nil)
		if err == nil {
			t.Error("Expected error for expired deadline")
		}
	})

	t.Run("Rejects not-yet-valid payment", func(t *testing.T) {
		permit2Payload := &evm.ExactPermit2Payload{
			Signature: mockSignature65Bytes(),
			Permit2Authorization: evm.Permit2Authorization{
				From:    "0x1234567890123456789012345678901234567890",
				Spender: evm.X402ExactPermit2ProxyAddress,
				Permitted: evm.Permit2TokenPermissions{
					Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
					Amount: "1000000",
				},
				Nonce:    "12345",
				Deadline: "9999999999",
				Witness: evm.Permit2Witness{
					To:         "0x9876543210987654321098765432109876543210",
					ValidAfter: "9999999999", // Far in the future!
				},
			},
		}

		_, err := evmfacilitator.VerifyPermit2(ctx, signer, validPayload, validRequirements, permit2Payload, nil, nil)
		if err == nil {
			t.Error("Expected error for not-yet-valid payment")
		}
	})

	t.Run("Rejects insufficient amount", func(t *testing.T) {
		permit2Payload := &evm.ExactPermit2Payload{
			Signature: mockSignature65Bytes(),
			Permit2Authorization: evm.Permit2Authorization{
				From:    "0x1234567890123456789012345678901234567890",
				Spender: evm.X402ExactPermit2ProxyAddress,
				Permitted: evm.Permit2TokenPermissions{
					Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
					Amount: "100", // Less than required 1000000!
				},
				Nonce:    "12345",
				Deadline: "9999999999",
				Witness:  defaultTestWitness(),
			},
		}

		_, err := evmfacilitator.VerifyPermit2(ctx, signer, validPayload, validRequirements, permit2Payload, nil, nil)
		if err == nil {
			t.Error("Expected error for insufficient amount")
		}
	})

	t.Run("Rejects token mismatch", func(t *testing.T) {
		permit2Payload := &evm.ExactPermit2Payload{
			Signature: mockSignature65Bytes(),
			Permit2Authorization: evm.Permit2Authorization{
				From:    "0x1234567890123456789012345678901234567890",
				Spender: evm.X402ExactPermit2ProxyAddress,
				Permitted: evm.Permit2TokenPermissions{
					Token:  "0xWrongToken90123456789012345678901234567890", // Wrong token!
					Amount: "1000000",
				},
				Nonce:    "12345",
				Deadline: "9999999999",
				Witness:  defaultTestWitness(),
			},
		}

		_, err := evmfacilitator.VerifyPermit2(ctx, signer, validPayload, validRequirements, permit2Payload, nil, nil)
		if err == nil {
			t.Error("Expected error for token mismatch")
		}
	})

	t.Run("Rejects invalid deadline format", func(t *testing.T) {
		permit2Payload := &evm.ExactPermit2Payload{
			Signature: mockSignature65Bytes(),
			Permit2Authorization: evm.Permit2Authorization{
				From:    "0x1234567890123456789012345678901234567890",
				Spender: evm.X402ExactPermit2ProxyAddress,
				Permitted: evm.Permit2TokenPermissions{
					Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
					Amount: "1000000",
				},
				Nonce:    "12345",
				Deadline: "not_a_number", // Invalid!
				Witness:  defaultTestWitness(),
			},
		}

		_, err := evmfacilitator.VerifyPermit2(ctx, signer, validPayload, validRequirements, permit2Payload, nil, nil)
		if err == nil {
			t.Error("Expected error for invalid deadline format")
		}
	})

	t.Run("Rejects scheme mismatch", func(t *testing.T) {
		wrongSchemePayload := types.PaymentPayload{
			X402Version: 2,
			Accepted: types.PaymentRequirements{
				Scheme:  "wrong", // Wrong scheme!
				Network: "eip155:84532",
			},
		}

		permit2Payload := &evm.ExactPermit2Payload{
			Signature: mockSignature65Bytes(),
			Permit2Authorization: evm.Permit2Authorization{
				From:    "0x1234567890123456789012345678901234567890",
				Spender: evm.X402ExactPermit2ProxyAddress,
				Permitted: evm.Permit2TokenPermissions{
					Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
					Amount: "1000000",
				},
				Nonce:    "12345",
				Deadline: "9999999999",
				Witness:  defaultTestWitness(),
			},
		}

		_, err := evmfacilitator.VerifyPermit2(ctx, signer, wrongSchemePayload, validRequirements, permit2Payload, nil, nil)
		if err == nil {
			t.Error("Expected error for scheme mismatch")
		}
	})

	t.Run("Rejects network mismatch", func(t *testing.T) {
		wrongNetworkPayload := types.PaymentPayload{
			X402Version: 2,
			Accepted: types.PaymentRequirements{
				Scheme:  evm.SchemeExact,
				Network: "eip155:8453", // Different network!
			},
		}

		permit2Payload := &evm.ExactPermit2Payload{
			Signature: mockSignature65Bytes(),
			Permit2Authorization: evm.Permit2Authorization{
				From:    "0x1234567890123456789012345678901234567890",
				Spender: evm.X402ExactPermit2ProxyAddress,
				Permitted: evm.Permit2TokenPermissions{
					Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
					Amount: "1000000",
				},
				Nonce:    "12345",
				Deadline: "9999999999",
				Witness:  defaultTestWitness(),
			},
		}

		_, err := evmfacilitator.VerifyPermit2(ctx, signer, wrongNetworkPayload, validRequirements, permit2Payload, nil, nil)
		if err == nil {
			t.Error("Expected error for network mismatch")
		}
	})
}

// TestVerifyEIP3009TimingValidation tests validAfter/validBefore timing checks in EIP-3009 verification
func TestVerifyEIP3009TimingValidation(t *testing.T) {
	ctx := context.Background()
	signer := &mockFacilitatorSigner{
		verifyTypedDataResult: true,
	}
	scheme := evmfacilitator.NewExactEvmScheme(signer, nil)

	makePayload := func(validAfter, validBefore string) types.PaymentPayload {
		return types.PaymentPayload{
			X402Version: 2,
			Accepted: types.PaymentRequirements{
				Scheme:  evm.SchemeExact,
				Network: "eip155:84532",
			},
			Payload: map[string]interface{}{
				"signature": mockSignature65Bytes(),
				"authorization": map[string]interface{}{
					"from":        "0x1234567890123456789012345678901234567890",
					"to":          "0x9876543210987654321098765432109876543210",
					"value":       "1000000",
					"validAfter":  validAfter,
					"validBefore": validBefore,
					"nonce":       "0x0000000000000000000000000000000000000000000000000000000000000001",
				},
			},
		}
	}

	requirements := types.PaymentRequirements{
		Scheme:  evm.SchemeExact,
		Network: "eip155:84532",
		Asset:   "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		Amount:  "1000000",
		PayTo:   "0x9876543210987654321098765432109876543210",
	}

	t.Run("Rejects validAfter in the future", func(t *testing.T) {
		payload := makePayload("9999999999", "99999999999")
		_, err := scheme.Verify(ctx, payload, requirements, nil)
		if err == nil {
			t.Fatal("Expected error for validAfter in the future")
		}
		if !strings.Contains(err.Error(), evmfacilitator.ErrValidAfterInFuture) {
			t.Errorf("Expected error to contain %q, got: %s", evmfacilitator.ErrValidAfterInFuture, err.Error())
		}
	})

	t.Run("Rejects expired validBefore", func(t *testing.T) {
		payload := makePayload("0", "1")
		_, err := scheme.Verify(ctx, payload, requirements, nil)
		if err == nil {
			t.Fatal("Expected error for expired validBefore")
		}
		if !strings.Contains(err.Error(), evmfacilitator.ErrValidBeforeExpired) {
			t.Errorf("Expected error to contain %q, got: %s", evmfacilitator.ErrValidBeforeExpired, err.Error())
		}
	})

	t.Run("Accepts valid timing window", func(t *testing.T) {
		payload := makePayload("0", "99999999999")
		_, err := scheme.Verify(ctx, payload, requirements, nil)
		// Should not fail with a timing error (may fail on nonce/signature checks, which is expected)
		if err != nil {
			if strings.Contains(err.Error(), evmfacilitator.ErrValidAfterInFuture) {
				t.Errorf("Should not reject valid timing window with validAfter error")
			}
			if strings.Contains(err.Error(), evmfacilitator.ErrValidBeforeExpired) {
				t.Errorf("Should not reject valid timing window with validBefore error")
			}
		}
	})
}

func TestVerifyEIP3009RejectsOverpayment(t *testing.T) {
	ctx := context.Background()
	requirements := defaultEIP3009Requirements()
	payload := defaultEIP3009Payload(mockSignature65Bytes())
	payload.Payload["authorization"].(map[string]interface{})["value"] = "1000001"

	signer := &mockFacilitatorSigner{
		verifyTypedDataResult: true,
		readContractFn: func(contractAddress string, abiBytes []byte, functionName string, args ...interface{}) (interface{}, error) {
			if functionName == evm.FunctionTransferWithAuthorization {
				return nil, nil
			}
			return nil, fmt.Errorf("unsupported function: %s", functionName)
		},
	}
	scheme := evmfacilitator.NewExactEvmScheme(signer, nil)

	_, err := scheme.Verify(ctx, payload, requirements, nil)
	if err == nil {
		t.Fatal("expected overpayment mismatch error")
	}
	if !strings.Contains(err.Error(), evmfacilitator.ErrAuthorizationValueMismatch) {
		t.Fatalf("expected %q, got %v", evmfacilitator.ErrAuthorizationValueMismatch, err)
	}
}

func TestVerifyEIP3009V1RejectsOverpayment(t *testing.T) {
	ctx := context.Background()
	requirements := defaultEIP3009RequirementsV1(t)
	payload := defaultEIP3009PayloadV1(mockSignature65Bytes())
	payload.Payload["authorization"].(map[string]interface{})["value"] = "1000001"

	signer := &mockFacilitatorSigner{
		verifyTypedDataResult: true,
		readContractFn: func(contractAddress string, abiBytes []byte, functionName string, args ...interface{}) (interface{}, error) {
			if functionName == evm.FunctionTransferWithAuthorization {
				return nil, nil
			}
			return nil, fmt.Errorf("unsupported function: %s", functionName)
		},
	}
	scheme := evmv1facilitator.NewExactEvmSchemeV1(signer, nil)

	_, err := scheme.Verify(ctx, payload, requirements, nil)
	if err == nil {
		t.Fatal("expected overpayment mismatch error")
	}
	if !strings.Contains(err.Error(), evmv1facilitator.ErrAuthorizationValueMismatch) {
		t.Fatalf("expected %q, got %v", evmv1facilitator.ErrAuthorizationValueMismatch, err)
	}
}

func TestVerifyEIP3009SimulationParity(t *testing.T) {
	ctx := context.Background()
	requirements := defaultEIP3009Requirements()

	t.Run("Rejects wrong token name from simulation diagnostics", func(t *testing.T) {
		factory := common.HexToAddress("0x1111111111111111111111111111111111111111")
		payload := defaultEIP3009Payload("0x")
		payload.Payload["signature"] = wrapERC6492SignatureForTest(t, factory, []byte{0xde, 0xad}, make([]byte, 65))

		multicallCount := 0
		signer := &mockFacilitatorSigner{
			readContractFn: func(contractAddress string, abiBytes []byte, functionName string, args ...interface{}) (interface{}, error) {
				if functionName != evm.FunctionTryAggregate {
					return nil, fmt.Errorf("unsupported function: %s", functionName)
				}
				multicallCount++
				if multicallCount == 1 {
					return []mockMulticallResult{
						{Success: true, ReturnData: []byte{}},
						{Success: false, ReturnData: []byte{}},
					}, nil
				}
				return []mockMulticallResult{
					{Success: true, ReturnData: packABIOutput(t, evm.ERC20BalanceOfABI, "balanceOf", big.NewInt(1_000_000))},
					{Success: true, ReturnData: packABIOutput(t, evm.ERC20NameABI, "name", "Wrong Name")},
					{Success: true, ReturnData: packABIOutput(t, evm.ERC20VersionABI, "version", "2")},
					{Success: true, ReturnData: packABIOutput(t, evm.AuthorizationStateABI, evm.FunctionAuthorizationState, false)},
				}, nil
			},
		}
		scheme := evmfacilitator.NewExactEvmScheme(signer, nil)

		_, err := scheme.Verify(ctx, payload, requirements, nil)
		if err == nil {
			t.Fatal("expected token name mismatch")
		}
		if !strings.Contains(err.Error(), evmfacilitator.ErrEip3009TokenNameMismatch) {
			t.Fatalf("expected %q, got %v", evmfacilitator.ErrEip3009TokenNameMismatch, err)
		}
	})

	t.Run("Rejects wrong token version from simulation diagnostics", func(t *testing.T) {
		factory := common.HexToAddress("0x1111111111111111111111111111111111111111")
		payload := defaultEIP3009Payload("0x")
		payload.Payload["signature"] = wrapERC6492SignatureForTest(t, factory, []byte{0xde, 0xad}, make([]byte, 65))

		multicallCount := 0
		signer := &mockFacilitatorSigner{
			readContractFn: func(contractAddress string, abiBytes []byte, functionName string, args ...interface{}) (interface{}, error) {
				if functionName != evm.FunctionTryAggregate {
					return nil, fmt.Errorf("unsupported function: %s", functionName)
				}
				multicallCount++
				if multicallCount == 1 {
					return []mockMulticallResult{
						{Success: true, ReturnData: []byte{}},
						{Success: false, ReturnData: []byte{}},
					}, nil
				}
				return []mockMulticallResult{
					{Success: true, ReturnData: packABIOutput(t, evm.ERC20BalanceOfABI, "balanceOf", big.NewInt(1_000_000))},
					{Success: true, ReturnData: packABIOutput(t, evm.ERC20NameABI, "name", "USDC")},
					{Success: true, ReturnData: packABIOutput(t, evm.ERC20VersionABI, "version", "999")},
					{Success: true, ReturnData: packABIOutput(t, evm.AuthorizationStateABI, evm.FunctionAuthorizationState, false)},
				}, nil
			},
		}
		scheme := evmfacilitator.NewExactEvmScheme(signer, nil)

		_, err := scheme.Verify(ctx, payload, requirements, nil)
		if err == nil {
			t.Fatal("expected token version mismatch")
		}
		if !strings.Contains(err.Error(), evmfacilitator.ErrEip3009TokenVersionMismatch) {
			t.Fatalf("expected %q, got %v", evmfacilitator.ErrEip3009TokenVersionMismatch, err)
		}
	})

	t.Run("Accepts deployed smart wallet when simulation succeeds", func(t *testing.T) {
		signer := &mockFacilitatorSigner{
			code: []byte{0x60, 0x80},
			readContractFn: func(contractAddress string, abiBytes []byte, functionName string, args ...interface{}) (interface{}, error) {
				switch functionName {
				case "isValidSignature":
					return []byte{0x16, 0x26, 0xba, 0x7e}, nil
				case evm.FunctionTransferWithAuthorization:
					return nil, nil
				default:
					return nil, fmt.Errorf("unsupported function: %s", functionName)
				}
			},
		}
		scheme := evmfacilitator.NewExactEvmScheme(signer, nil)

		verifyResp, err := scheme.Verify(ctx, defaultEIP3009Payload(mockSignature65Bytes()), requirements, nil)
		if err != nil {
			t.Fatalf("expected verification success, got %v", err)
		}
		if !verifyResp.IsValid {
			t.Fatal("expected valid verification response")
		}
	})

	t.Run("Rejects undeployed ERC-6492 when deploy+transfer simulation fails", func(t *testing.T) {
		factory := common.HexToAddress("0x1111111111111111111111111111111111111111")
		payload := defaultEIP3009Payload("0x")
		payload.Payload["signature"] = wrapERC6492SignatureForTest(t, factory, []byte{0xde, 0xad}, make([]byte, 65))

		multicallCount := 0
		signer := &mockFacilitatorSigner{
			readContractFn: func(contractAddress string, abiBytes []byte, functionName string, args ...interface{}) (interface{}, error) {
				if functionName != evm.FunctionTryAggregate {
					return nil, fmt.Errorf("unsupported function: %s", functionName)
				}
				multicallCount++
				if multicallCount == 1 {
					return []mockMulticallResult{
						{Success: true, ReturnData: []byte{}},
						{Success: false, ReturnData: []byte{}},
					}, nil
				}
				return []mockMulticallResult{
					{Success: true, ReturnData: packABIOutput(t, evm.ERC20BalanceOfABI, "balanceOf", big.NewInt(1_000_000))},
					{Success: true, ReturnData: packABIOutput(t, evm.ERC20NameABI, "name", "USDC")},
					{Success: true, ReturnData: packABIOutput(t, evm.ERC20VersionABI, "version", "2")},
					{Success: true, ReturnData: packABIOutput(t, evm.AuthorizationStateABI, evm.FunctionAuthorizationState, false)},
				}, nil
			},
		}
		scheme := evmfacilitator.NewExactEvmScheme(signer, nil)

		_, err := scheme.Verify(ctx, payload, requirements, nil)
		if err == nil {
			t.Fatal("expected simulation failure")
		}
		if !strings.Contains(err.Error(), evmfacilitator.ErrEip3009SimulationFailed) {
			t.Fatalf("expected %q, got %v", evmfacilitator.ErrEip3009SimulationFailed, err)
		}
	})

	t.Run("Accepts undeployed ERC-6492 when deploy+transfer simulation succeeds", func(t *testing.T) {
		factory := common.HexToAddress("0x2222222222222222222222222222222222222222")
		payload := defaultEIP3009Payload("0x")
		payload.Payload["signature"] = wrapERC6492SignatureForTest(t, factory, []byte{0xbe, 0xef}, make([]byte, 65))

		signer := &mockFacilitatorSigner{
			readContractFn: func(contractAddress string, abiBytes []byte, functionName string, args ...interface{}) (interface{}, error) {
				if functionName != evm.FunctionTryAggregate {
					return nil, fmt.Errorf("unsupported function: %s", functionName)
				}
				return []mockMulticallResult{
					{Success: true, ReturnData: []byte{}},
					{Success: true, ReturnData: []byte{}},
				}, nil
			},
		}
		scheme := evmfacilitator.NewExactEvmScheme(signer, nil)

		verifyResp, err := scheme.Verify(ctx, payload, requirements, nil)
		if err != nil {
			t.Fatalf("expected verification success, got %v", err)
		}
		if !verifyResp.IsValid {
			t.Fatal("expected valid verification response")
		}
	})
}

func TestSettleEIP3009SimulateInSettleToggle(t *testing.T) {
	ctx := context.Background()
	requirements := defaultEIP3009Requirements()
	payload := defaultEIP3009Payload(mockSignature65Bytes())

	runCase := func(simulateInSettle bool) int {
		simulations := 0
		signer := &mockFacilitatorSigner{
			code: []byte{0x60, 0x80},
			readContractFn: func(contractAddress string, abiBytes []byte, functionName string, args ...interface{}) (interface{}, error) {
				switch functionName {
				case "isValidSignature":
					return []byte{0x16, 0x26, 0xba, 0x7e}, nil
				case evm.FunctionTransferWithAuthorization:
					simulations++
					return nil, nil
				default:
					return nil, fmt.Errorf("unsupported function: %s", functionName)
				}
			},
		}
		scheme := evmfacilitator.NewExactEvmScheme(signer, &evmfacilitator.ExactEvmSchemeConfig{
			SimulateInSettle: simulateInSettle,
		})

		if _, err := scheme.Verify(ctx, payload, requirements, nil); err != nil {
			t.Fatalf("verify failed: %v", err)
		}
		if _, err := scheme.Settle(ctx, payload, requirements, nil); err != nil {
			t.Fatalf("settle failed: %v", err)
		}

		return simulations
	}

	if got := runCase(false); got != 1 {
		t.Fatalf("expected 1 simulation when SimulateInSettle=false, got %d", got)
	}
	if got := runCase(true); got != 2 {
		t.Fatalf("expected 2 simulations when SimulateInSettle=true, got %d", got)
	}
}

func TestVerifyEIP3009V1UsesSimulationDiagnostics(t *testing.T) {
	ctx := context.Background()
	requirements := defaultEIP3009RequirementsV1(t)

	factory := common.HexToAddress("0x1111111111111111111111111111111111111111")
	payload := defaultEIP3009PayloadV1("0x")
	payload.Payload["signature"] = wrapERC6492SignatureForTest(t, factory, []byte{0xde, 0xad}, make([]byte, 65))

	multicallCount := 0
	signer := &mockFacilitatorSigner{
		readContractFn: func(contractAddress string, abiBytes []byte, functionName string, args ...interface{}) (interface{}, error) {
			if functionName != evm.FunctionTryAggregate {
				return nil, fmt.Errorf("unsupported function: %s", functionName)
			}
			multicallCount++
			if multicallCount == 1 {
				return []mockMulticallResult{
					{Success: true, ReturnData: []byte{}},
					{Success: false, ReturnData: []byte{}},
				}, nil
			}
			return []mockMulticallResult{
				{Success: true, ReturnData: packABIOutput(t, evm.ERC20BalanceOfABI, "balanceOf", big.NewInt(1_000_000))},
				{Success: true, ReturnData: packABIOutput(t, evm.ERC20NameABI, "name", "Wrong Name")},
				{Success: true, ReturnData: packABIOutput(t, evm.ERC20VersionABI, "version", "2")},
				{Success: true, ReturnData: packABIOutput(t, evm.AuthorizationStateABI, evm.FunctionAuthorizationState, false)},
			}, nil
		},
	}
	scheme := evmv1facilitator.NewExactEvmSchemeV1(signer, nil)

	_, err := scheme.Verify(ctx, payload, requirements, nil)
	if err == nil {
		t.Fatal("expected token name mismatch")
	}
	if !strings.Contains(err.Error(), evmfacilitator.ErrEip3009TokenNameMismatch) {
		t.Fatalf("expected %q, got %v", evmfacilitator.ErrEip3009TokenNameMismatch, err)
	}
}

// TestExactEvmFacilitatorScheme tests the scheme initialization
func TestExactEvmFacilitatorScheme(t *testing.T) {
	signer := &mockFacilitatorSigner{}

	t.Run("Creates scheme without config", func(t *testing.T) {
		scheme := evmfacilitator.NewExactEvmScheme(signer, nil)
		if scheme == nil {
			t.Error("Expected scheme to be created")
		}
	})

	t.Run("Creates scheme with config", func(t *testing.T) {
		config := &evmfacilitator.ExactEvmSchemeConfig{
			DeployERC4337WithEIP6492: true,
		}
		scheme := evmfacilitator.NewExactEvmScheme(signer, config)
		if scheme == nil {
			t.Error("Expected scheme to be created")
		}
	})
}

// =========================================================================
// EIP-2612 Gas Sponsoring Tests
// =========================================================================

// TestCreatePaymentPayloadWithExtensions_EIP2612 tests that the client creates
// EIP-2612 extension data when the server advertises the extension and
// Permit2 allowance is insufficient.
func TestCreatePaymentPayloadWithExtensions_EIP2612(t *testing.T) {
	ctx := context.Background()

	t.Run("Creates EIP-2612 extension when server advertises and allowance is 0", func(t *testing.T) {
		signer := &mockClientSigner{address: "0xClientAddress1234567890123456789012"}
		client := evmclient.NewExactEvmScheme(signer, nil)

		requirements := types.PaymentRequirements{
			Scheme:            evm.SchemeExact,
			Network:           "eip155:84532",
			Asset:             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Amount:            "1000000",
			PayTo:             "0x9876543210987654321098765432109876543210",
			MaxTimeoutSeconds: 300,
			Extra: map[string]interface{}{
				"assetTransferMethod": "permit2",
				"name":                "USDC",
				"version":             "2",
			},
		}

		// Server advertises eip2612GasSponsoring extension
		extensions := map[string]interface{}{
			"eip2612GasSponsoring": map[string]interface{}{
				"info":   map[string]interface{}{},
				"schema": map[string]interface{}{},
			},
		}

		payload, err := client.CreatePaymentPayloadWithExtensions(ctx, requirements, extensions)
		if err != nil {
			t.Fatalf("Failed to create payload: %v", err)
		}

		// Should have EIP-2612 extension in the payload
		if payload.Extensions == nil {
			t.Fatal("Expected extensions to be present")
		}

		if _, ok := payload.Extensions["eip2612GasSponsoring"]; !ok {
			t.Error("Expected eip2612GasSponsoring extension in payload")
		}
	})

	t.Run("No extension when server does not advertise eip2612GasSponsoring", func(t *testing.T) {
		signer := &mockClientSigner{address: "0xClientAddress1234567890123456789012"}
		client := evmclient.NewExactEvmScheme(signer, nil)

		requirements := types.PaymentRequirements{
			Scheme:            evm.SchemeExact,
			Network:           "eip155:84532",
			Asset:             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Amount:            "1000000",
			PayTo:             "0x9876543210987654321098765432109876543210",
			MaxTimeoutSeconds: 300,
			Extra: map[string]interface{}{
				"assetTransferMethod": "permit2",
				"name":                "USDC",
				"version":             "2",
			},
		}

		// No extensions advertised
		payload, err := client.CreatePaymentPayloadWithExtensions(ctx, requirements, nil)
		if err != nil {
			t.Fatalf("Failed to create payload: %v", err)
		}

		// Should NOT have extensions
		if payload.Extensions != nil {
			t.Error("Expected no extensions when server doesn't advertise")
		}
	})

	t.Run("No extension when token metadata missing", func(t *testing.T) {
		signer := &mockClientSigner{address: "0xClientAddress1234567890123456789012"}
		client := evmclient.NewExactEvmScheme(signer, nil)

		requirements := types.PaymentRequirements{
			Scheme:            evm.SchemeExact,
			Network:           "eip155:84532",
			Asset:             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Amount:            "1000000",
			PayTo:             "0x9876543210987654321098765432109876543210",
			MaxTimeoutSeconds: 300,
			Extra: map[string]interface{}{
				"assetTransferMethod": "permit2",
				// Missing name and version
			},
		}

		extensions := map[string]interface{}{
			"eip2612GasSponsoring": map[string]interface{}{
				"info":   map[string]interface{}{},
				"schema": map[string]interface{}{},
			},
		}

		payload, err := client.CreatePaymentPayloadWithExtensions(ctx, requirements, extensions)
		if err != nil {
			t.Fatalf("Failed to create payload: %v", err)
		}

		// Should NOT have extensions (token metadata missing)
		if payload.Extensions != nil {
			t.Error("Expected no extensions when token metadata is missing")
		}
	})
}

// signedPermit2TestData generates a valid Permit2 payload with a real ECDSA signature
// for use in tests that require passing signature verification.
func signedPermit2TestData(t *testing.T) (*evm.ExactPermit2Payload, string) {
	t.Helper()

	// Generate a real key pair
	privateKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("Failed to generate key: %v", err)
	}
	address := crypto.PubkeyToAddress(privateKey.PublicKey).Hex()

	authorization := evm.Permit2Authorization{
		From:    address,
		Spender: evm.X402ExactPermit2ProxyAddress,
		Permitted: evm.Permit2TokenPermissions{
			Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Amount: "1000000",
		},
		Nonce:    "12345",
		Deadline: "9999999999",
		Witness:  defaultTestWitness(),
	}

	// Compute the EIP-712 hash and sign it
	hashBytes, err := evm.HashPermit2Authorization(authorization, big.NewInt(84532))
	if err != nil {
		t.Fatalf("Failed to hash: %v", err)
	}

	sig, err := crypto.Sign(hashBytes, privateKey)
	if err != nil {
		t.Fatalf("Failed to sign: %v", err)
	}
	// Adjust v from 0/1 to 27/28
	if sig[64] < 27 {
		sig[64] += 27
	}

	sigHex := "0x" + fmt.Sprintf("%x", sig)

	return &evm.ExactPermit2Payload{
		Signature:            sigHex,
		Permit2Authorization: authorization,
	}, address
}

// TestSettlePermit2_EIP2612Routing tests that the facilitator routes to the
// correct settlement function based on EIP-2612 extension presence.
func TestSettlePermit2_EIP2612Routing(t *testing.T) {
	ctx := context.Background()

	t.Run("Calls settleWithPermit when EIP-2612 extension present", func(t *testing.T) {
		permit2Payload, payerAddress := signedPermit2TestData(t)

		signer := &mockFacilitatorSigner{
			verifyTypedDataResult: true,
		}

		validRequirements := types.PaymentRequirements{
			Scheme:  evm.SchemeExact,
			Network: "eip155:84532",
			Asset:   "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Amount:  "1000000",
			PayTo:   "0x9876543210987654321098765432109876543210",
		}

		// Allowance = 0 forces EIP-2612 path
		signer.allowance = big.NewInt(0)

		payload := types.PaymentPayload{
			X402Version: 2,
			Accepted: types.PaymentRequirements{
				Scheme:  evm.SchemeExact,
				Network: "eip155:84532",
			},
			Extensions: map[string]interface{}{
				"eip2612GasSponsoring": map[string]interface{}{
					"info": map[string]interface{}{
						"from":      payerAddress,
						"asset":     "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
						"spender":   evm.PERMIT2Address,
						"amount":    "1000000", // Must match Permit2 permitted.amount exactly
						"nonce":     "0",
						"deadline":  "9999999999",
						"signature": mockSignature65Bytes(),
						"version":   "1",
					},
				},
			},
		}

		_, err := evmfacilitator.SettlePermit2(ctx, signer, payload, validRequirements, permit2Payload, nil, nil)
		if err != nil {
			t.Fatalf("Unexpected error: %v", err)
		}

		if signer.lastWriteFunctionName != evm.FunctionSettleWithPermit {
			t.Errorf("Expected function %s, got %s", evm.FunctionSettleWithPermit, signer.lastWriteFunctionName)
		}
	})

	t.Run("Calls settle when no EIP-2612 extension", func(t *testing.T) {
		permit2Payload, _ := signedPermit2TestData(t)

		signer := &mockFacilitatorSigner{
			verifyTypedDataResult: true,
		}

		validRequirements := types.PaymentRequirements{
			Scheme:  evm.SchemeExact,
			Network: "eip155:84532",
			Asset:   "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Amount:  "1000000",
			PayTo:   "0x9876543210987654321098765432109876543210",
		}

		payload := types.PaymentPayload{
			X402Version: 2,
			Accepted: types.PaymentRequirements{
				Scheme:  evm.SchemeExact,
				Network: "eip155:84532",
			},
			// No extensions
		}

		_, err := evmfacilitator.SettlePermit2(ctx, signer, payload, validRequirements, permit2Payload, nil, nil)
		if err != nil {
			t.Fatalf("Unexpected error: %v", err)
		}

		if signer.lastWriteFunctionName != evm.FunctionSettle {
			t.Errorf("Expected function %s, got %s", evm.FunctionSettle, signer.lastWriteFunctionName)
		}
	})
}

// TestSettlePermit2_ContractRevertErrors tests that parsePermit2Error maps
// contract revert strings to the correct named error constants.
func TestSettlePermit2_ContractRevertErrors(t *testing.T) {
	ctx := context.Background()

	validRequirements := types.PaymentRequirements{
		Scheme:  evm.SchemeExact,
		Network: "eip155:84532",
		Asset:   "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		Amount:  "1000000",
		PayTo:   "0x9876543210987654321098765432109876543210",
	}

	// signedPermit2TestData creates a valid payload with real ECDSA signature
	permit2Payload, _ := signedPermit2TestData(t)

	testCases := []struct {
		name           string
		revertMessage  string
		expectedReason string
	}{
		{
			name:           "Permit2612AmountMismatch maps to permit2_2612_amount_mismatch",
			revertMessage:  "execution reverted: Permit2612AmountMismatch()",
			expectedReason: evmfacilitator.ErrPermit2612AmountMismatch,
		},
		{
			name:           "InvalidAmount maps to permit2_invalid_amount",
			revertMessage:  "execution reverted: InvalidAmount()",
			expectedReason: evmfacilitator.ErrPermit2InvalidAmount,
		},
		{
			name:           "InvalidDestination maps to permit2_invalid_destination",
			revertMessage:  "execution reverted: InvalidDestination()",
			expectedReason: evmfacilitator.ErrPermit2InvalidDestination,
		},
		{
			name:           "InvalidOwner maps to permit2_invalid_owner",
			revertMessage:  "execution reverted: InvalidOwner()",
			expectedReason: evmfacilitator.ErrPermit2InvalidOwner,
		},
		{
			name:           "PaymentTooEarly maps to permit2_payment_too_early",
			revertMessage:  "execution reverted: PaymentTooEarly()",
			expectedReason: evmfacilitator.ErrPermit2PaymentTooEarly,
		},
		{
			name:           "InvalidSignature maps to invalid_permit2_signature",
			revertMessage:  "execution reverted: InvalidSignature()",
			expectedReason: evmfacilitator.ErrPermit2InvalidSignature,
		},
		{
			name:           "SignatureExpired maps to invalid_permit2_signature",
			revertMessage:  "execution reverted: SignatureExpired()",
			expectedReason: evmfacilitator.ErrPermit2InvalidSignature,
		},
		{
			name:           "InvalidNonce maps to permit2_invalid_nonce",
			revertMessage:  "execution reverted: InvalidNonce()",
			expectedReason: evmfacilitator.ErrPermit2InvalidNonce,
		},
		{
			name:           "Unknown revert maps to failed_to_execute_transfer",
			revertMessage:  "execution reverted: SomeUnknownError()",
			expectedReason: evmfacilitator.ErrFailedToExecuteTransfer,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			signer := &mockFacilitatorSigner{
				verifyTypedDataResult: true,
				writeContractError:    fmt.Errorf("%s", tc.revertMessage),
			}

			payload := types.PaymentPayload{
				X402Version: 2,
				Accepted: types.PaymentRequirements{
					Scheme:  evm.SchemeExact,
					Network: "eip155:84532",
				},
			}

			_, err := evmfacilitator.SettlePermit2(ctx, signer, payload, validRequirements, permit2Payload, nil, nil)
			if err == nil {
				t.Fatal("Expected error from SettlePermit2")
			}

			if !strings.Contains(err.Error(), tc.expectedReason) {
				t.Errorf("Expected error to contain %q, got: %s", tc.expectedReason, err.Error())
			}
		})
	}
}
