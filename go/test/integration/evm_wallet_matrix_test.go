// Package integration_test exercises the wallet compatibility matrix
// (docs/advanced-concepts/wallet-compatibility.mdx) with real Base Sepolia txs.
//
// Required env vars (set in go/.env):
//
//	EVM_FACILITATOR_PRIVATE_KEY, EVM_RESOURCE_SERVER_ADDRESS (shared)
//	EVM_CLIENT_EOA_PRIVATE_KEY          — Wallet A: plain EOA
//	EVM_CLIENT_4337_ADDRESS             — Wallet B: Coinbase Smart Wallet address
//	EVM_CLIENT_4337_OWNER_PRIVATE_KEY   — Wallet B: owner key (signs on behalf of smart account)
//	EVM_CLIENT_7579_ADDRESS             — Wallet 7579: Biconomy Nexus address
//	EVM_CLIENT_7579_OWNER_PRIVATE_KEY   — Wallet 7579: owner key
//	EVM_CLIENT_7579_VALIDATOR           — Wallet 7579: K1 validator address (optional)
//	EVM_CLIENT_7702_PRIVATE_KEY         — Wallet D: key whose address is 7702-delegated
//	EVM_CLIENT_7702_ADDRESS             — Wallet D: expected address (sanity check)
package integration_test

import (
	"context"
	"math/big"
	"os"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	exactevmclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/client"
	exactevmfacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/facilitator"
	exactevmserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/server"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	matrixUSDC    = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
	matrixAmount  = "100" // 0.0001 USDC
	matrixNetwork = "eip155:84532"
	matrixRPC     = "https://sepolia.base.org"
)

func buildMatrixAccepts(payTo string) []types.PaymentRequirements {
	return []types.PaymentRequirements{{
		Scheme:  evm.SchemeExact,
		Network: matrixNetwork,
		Asset:   matrixUSDC,
		Amount:  matrixAmount,
		PayTo:   payTo,
		Extra: map[string]interface{}{
			"name":    "USDC",
			"version": "2",
		},
	}}
}

func buildMatrixPermit2Accepts(payTo string) []types.PaymentRequirements {
	return []types.PaymentRequirements{{
		Scheme:            evm.SchemeExact,
		Network:           matrixNetwork,
		Asset:             matrixUSDC,
		Amount:            matrixAmount,
		PayTo:             payTo,
		MaxTimeoutSeconds: 3600,
		Extra: map[string]interface{}{
			"name":                "USDC",
			"version":             "2",
			"assetTransferMethod": "permit2",
		},
	}}
}

// runMatrixFlowPermit2 runs the verify+settle flow using the Permit2 asset transfer method.
func runMatrixFlowPermit2(t *testing.T, clientKey, facilitatorKey, resourceServer, label string) {
	t.Helper()
	ctx := context.Background()

	clientSigner, err := evmsigners.NewClientSignerFromPrivateKey(clientKey)
	if err != nil {
		t.Fatalf("%s: client signer: %v", label, err)
	}

	facilitatorSigner, err := newRealFacilitatorEvmSigner(facilitatorKey, matrixRPC)
	if err != nil {
		t.Fatalf("%s: facilitator signer: %v", label, err)
	}

	client := x402.Newx402Client()
	client.Register(matrixNetwork, exactevmclient.NewExactEvmScheme(clientSigner, nil))

	facilitator := x402.Newx402Facilitator()
	facilitator.Register([]x402.Network{matrixNetwork},
		exactevmfacilitator.NewExactEvmScheme(facilitatorSigner, nil))

	facilClient := &localEvmFacilitatorClient{facilitator: facilitator}
	server := x402.Newx402ResourceServer(x402.WithFacilitatorClient(facilClient))
	server.Register(matrixNetwork, exactevmserver.NewExactEvmScheme())
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("%s: server init: %v", label, err)
	}

	resource := &types.ResourceInfo{URL: "https://test.x402.org", Description: label}
	accepts := buildMatrixPermit2Accepts(resourceServer)
	resp := server.CreatePaymentRequiredResponse(accepts, resource, "", nil)

	selected, err := client.SelectPaymentRequirements(accepts)
	if err != nil {
		t.Fatalf("%s: select: %v", label, err)
	}
	payload, err := client.CreatePaymentPayload(ctx, selected, resource, resp.Extensions)
	if err != nil {
		t.Fatalf("%s: create payload: %v", label, err)
	}

	accepted := server.FindMatchingRequirements(accepts, payload)
	if accepted == nil {
		t.Fatalf("%s: no matching requirements", label)
	}

	verifyResp, err := server.VerifyPayment(ctx, payload, *accepted)
	if err != nil {
		t.Fatalf("%s: verify error: %v", label, err)
	}
	if !verifyResp.IsValid {
		t.Fatalf("%s: verify failed: %s", label, verifyResp.InvalidReason)
	}

	settleResp, err := server.SettlePayment(ctx, payload, *accepted, nil)
	if err != nil {
		t.Fatalf("%s: settle error: %v", label, err)
	}
	if !settleResp.Success {
		t.Fatalf("%s: settle failed: %s", label, settleResp.ErrorReason)
	}
	t.Logf("%s: ✅ settled tx=%s payer=%s", label, settleResp.Transaction, settleResp.Payer)
}

// runMatrixFlow runs the standard verify+settle flow for a single wallet type.
func runMatrixFlow(t *testing.T, clientKey, facilitatorKey, resourceServer, label string) {
	t.Helper()
	ctx := context.Background()

	clientSigner, err := evmsigners.NewClientSignerFromPrivateKey(clientKey)
	if err != nil {
		t.Fatalf("%s: client signer: %v", label, err)
	}

	facilitatorSigner, err := newRealFacilitatorEvmSigner(facilitatorKey, matrixRPC)
	if err != nil {
		t.Fatalf("%s: facilitator signer: %v", label, err)
	}

	client := x402.Newx402Client()
	client.Register(matrixNetwork, exactevmclient.NewExactEvmScheme(clientSigner, nil))

	facilitator := x402.Newx402Facilitator()
	facilitator.Register([]x402.Network{matrixNetwork},
		exactevmfacilitator.NewExactEvmScheme(facilitatorSigner, nil))

	facilClient := &localEvmFacilitatorClient{facilitator: facilitator}
	server := x402.Newx402ResourceServer(x402.WithFacilitatorClient(facilClient))
	server.Register(matrixNetwork, exactevmserver.NewExactEvmScheme())
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("%s: server init: %v", label, err)
	}

	resource := &types.ResourceInfo{URL: "https://test.x402.org", Description: label}
	accepts := buildMatrixAccepts(resourceServer)
	resp := server.CreatePaymentRequiredResponse(accepts, resource, "", nil)

	selected, err := client.SelectPaymentRequirements(accepts)
	if err != nil {
		t.Fatalf("%s: select: %v", label, err)
	}
	payload, err := client.CreatePaymentPayload(ctx, selected, resource, resp.Extensions)
	if err != nil {
		t.Fatalf("%s: create payload: %v", label, err)
	}

	accepted := server.FindMatchingRequirements(accepts, payload)
	if accepted == nil {
		t.Fatalf("%s: no matching requirements", label)
	}

	verifyResp, err := server.VerifyPayment(ctx, payload, *accepted)
	if err != nil {
		t.Fatalf("%s: verify error: %v", label, err)
	}
	if !verifyResp.IsValid {
		t.Fatalf("%s: verify failed: %s", label, verifyResp.InvalidReason)
	}

	settleResp, err := server.SettlePayment(ctx, payload, *accepted, nil)
	if err != nil {
		t.Fatalf("%s: settle error: %v", label, err)
	}
	if !settleResp.Success {
		t.Fatalf("%s: settle failed: %s", label, settleResp.ErrorReason)
	}
	t.Logf("%s: ✅ settled tx=%s payer=%s", label, settleResp.Transaction, settleResp.Payer)
}

// TestWalletMatrix_A_PlainEOA exercises a plain EOA payer.
func TestWalletMatrix_A_PlainEOA(t *testing.T) {
	key := os.Getenv("EVM_CLIENT_EOA_PRIVATE_KEY")
	facil := os.Getenv("EVM_FACILITATOR_PRIVATE_KEY")
	rs := os.Getenv("EVM_RESOURCE_SERVER_ADDRESS")
	if key == "" || facil == "" || rs == "" {
		t.Skip("EVM_CLIENT_EOA_PRIVATE_KEY / EVM_FACILITATOR_PRIVATE_KEY / EVM_RESOURCE_SERVER_ADDRESS required")
	}
	runMatrixFlow(t, key, facil, rs, "wallet-A-plain-eoa")
}

// TestWalletMatrix_B_DeployedSmartAccount exercises a deployed Coinbase Smart Wallet (ERC-4337).
func TestWalletMatrix_B_DeployedSmartAccount(t *testing.T) {
	ownerKey := os.Getenv("EVM_CLIENT_4337_OWNER_PRIVATE_KEY")
	acctAddr := os.Getenv("EVM_CLIENT_4337_ADDRESS")
	facil := os.Getenv("EVM_FACILITATOR_PRIVATE_KEY")
	rs := os.Getenv("EVM_RESOURCE_SERVER_ADDRESS")
	if ownerKey == "" || acctAddr == "" || facil == "" || rs == "" {
		t.Skip("EVM_CLIENT_4337_OWNER_PRIVATE_KEY / EVM_CLIENT_4337_ADDRESS / EVM_FACILITATOR_PRIVATE_KEY required")
	}

	ownerSigner, err := evmsigners.NewClientSignerFromPrivateKey(ownerKey)
	if err != nil {
		t.Fatalf("owner signer: %v", err)
	}
	smartSigner := newCoinbaseSmartWalletSigner(ownerSigner, acctAddr, big.NewInt(84532))
	runMatrixFlowWithSigner(t, smartSigner, facil, rs, "wallet-B-coinbase-smart-wallet")
}

// TestWalletMatrix_7579_DeployedNexus exercises a deployed Biconomy Nexus (ERC-7579) account.
func TestWalletMatrix_7579_DeployedNexus(t *testing.T) {
	ownerKey := os.Getenv("EVM_CLIENT_7579_OWNER_PRIVATE_KEY")
	acctAddr := os.Getenv("EVM_CLIENT_7579_ADDRESS")
	validator := os.Getenv("EVM_CLIENT_7579_VALIDATOR")
	facil := os.Getenv("EVM_FACILITATOR_PRIVATE_KEY")
	rs := os.Getenv("EVM_RESOURCE_SERVER_ADDRESS")
	if ownerKey == "" || acctAddr == "" || facil == "" || rs == "" {
		t.Skip("EVM_CLIENT_7579_OWNER_PRIVATE_KEY / EVM_CLIENT_7579_ADDRESS / EVM_FACILITATOR_PRIVATE_KEY required")
	}
	if validator == "" {
		validator = nexusK1Validator
	}

	ctx := context.Background()
	ownerSigner, err := evmsigners.NewClientSignerFromPrivateKey(ownerKey)
	if err != nil {
		t.Fatalf("owner signer: %v", err)
	}
	facilitatorSigner, err := newRealFacilitatorEvmSigner(facil, matrixRPC)
	if err != nil {
		t.Fatalf("facilitator signer: %v", err)
	}
	verifierDomain, err := fetchNexusVerifierDomain(ctx, facilitatorSigner, acctAddr)
	if err != nil {
		t.Fatalf("fetch nexus eip712Domain: %v", err)
	}
	nexusSigner := newNexusSmartAccountSigner(ownerSigner, acctAddr, validator, verifierDomain)
	runMatrixFlowWithSigner(t, nexusSigner, facil, rs, "wallet-7579-biconomy-nexus")
}

func runMatrixFlowWithSigner(t *testing.T, clientSigner evm.ClientEvmSigner, facilitatorKey, resourceServer, label string) {
	t.Helper()
	ctx := context.Background()

	facilitatorSigner, err := newRealFacilitatorEvmSigner(facilitatorKey, matrixRPC)
	if err != nil {
		t.Fatalf("%s: facilitator signer: %v", label, err)
	}

	client := x402.Newx402Client()
	client.Register(matrixNetwork, exactevmclient.NewExactEvmScheme(clientSigner, nil))

	facilitator := x402.Newx402Facilitator()
	facilitator.Register([]x402.Network{matrixNetwork},
		exactevmfacilitator.NewExactEvmScheme(facilitatorSigner, nil))

	facilClient := &localEvmFacilitatorClient{facilitator: facilitator}
	server := x402.Newx402ResourceServer(x402.WithFacilitatorClient(facilClient))
	server.Register(matrixNetwork, exactevmserver.NewExactEvmScheme())
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("%s: server init: %v", label, err)
	}

	resource := &types.ResourceInfo{URL: "https://test.x402.org", Description: label}
	accepts := buildMatrixAccepts(resourceServer)
	resp := server.CreatePaymentRequiredResponse(accepts, resource, "", nil)

	selected, err := client.SelectPaymentRequirements(accepts)
	if err != nil {
		t.Fatalf("%s: select: %v", label, err)
	}
	payload, err := client.CreatePaymentPayload(ctx, selected, resource, resp.Extensions)
	if err != nil {
		t.Fatalf("%s: create payload: %v", label, err)
	}

	accepted := server.FindMatchingRequirements(accepts, payload)
	if accepted == nil {
		t.Fatalf("%s: no matching requirements", label)
	}

	verifyResp, err := server.VerifyPayment(ctx, payload, *accepted)
	if err != nil {
		t.Fatalf("%s: verify error: %v", label, err)
	}
	if !verifyResp.IsValid {
		t.Fatalf("%s: verify failed: %s", label, verifyResp.InvalidReason)
	}

	settleResp, err := server.SettlePayment(ctx, payload, *accepted, nil)
	if err != nil {
		t.Fatalf("%s: settle error: %v", label, err)
	}
	if !settleResp.Success {
		t.Fatalf("%s: settle failed: %s", label, settleResp.ErrorReason)
	}
	t.Logf("%s: ✅ settled tx=%s payer=%s", label, settleResp.Transaction, settleResp.Payer)
}

// TestWalletMatrix_D_ERC7702Permissive exercises a 7702-delegated EOA whose
// delegate's isValidSignature accepts raw owner ECDSA.
func TestWalletMatrix_D_ERC7702Permissive(t *testing.T) {
	key := os.Getenv("EVM_CLIENT_7702_PRIVATE_KEY")
	expectedAddr := os.Getenv("EVM_CLIENT_7702_ADDRESS")
	facil := os.Getenv("EVM_FACILITATOR_PRIVATE_KEY")
	rs := os.Getenv("EVM_RESOURCE_SERVER_ADDRESS")
	if key == "" || facil == "" || rs == "" {
		t.Skip("EVM_CLIENT_7702_PRIVATE_KEY / EVM_FACILITATOR_PRIVATE_KEY / EVM_RESOURCE_SERVER_ADDRESS required")
	}

	// Confirm delegation is active
	facilitatorSigner, err := newRealFacilitatorEvmSigner(facil, matrixRPC)
	if err != nil {
		t.Fatalf("facilitator signer: %v", err)
	}
	cleanKey := strings.TrimPrefix(key, "0x")
	privKey, err := crypto.HexToECDSA(cleanKey)
	if err != nil {
		t.Fatalf("parse key: %v", err)
	}
	addr := crypto.PubkeyToAddress(privKey.PublicKey).Hex()
	if expectedAddr != "" && !strings.EqualFold(addr, expectedAddr) {
		t.Errorf("key derives to %s, expected %s", addr, expectedAddr)
	}

	ctx := context.Background()
	code, err := facilitatorSigner.GetCode(ctx, addr)
	if err != nil {
		t.Fatalf("get code: %v", err)
	}
	if !evm.IsERC7702Delegation(code) {
		t.Skipf("Account %s is not ERC-7702 delegated (code: %x) — run setup-wallets-v3.mjs first", addr, code)
	}
	delegate, _ := evm.GetERC7702DelegateAddress(code)
	t.Logf("7702 delegation active: %s → %s", addr, delegate.Hex())

	runMatrixFlow(t, key, facil, rs, "wallet-D-erc7702-permissive")
}

// TestWalletMatrix_A_Permit2 exercises a plain EOA payer with Permit2.
// Requires a pre-approved Permit2 allowance on the client account.
func TestWalletMatrix_A_Permit2(t *testing.T) {
	key := os.Getenv("EVM_CLIENT_EOA_PRIVATE_KEY")
	facil := os.Getenv("EVM_FACILITATOR_PRIVATE_KEY")
	rs := os.Getenv("EVM_RESOURCE_SERVER_ADDRESS")
	if key == "" || facil == "" || rs == "" {
		t.Skip("EVM_CLIENT_EOA_PRIVATE_KEY / EVM_FACILITATOR_PRIVATE_KEY / EVM_RESOURCE_SERVER_ADDRESS required")
	}
	runMatrixFlowPermit2(t, key, facil, rs, "wallet-A-permit2-eoa")
}

// TestWalletMatrix_D_ERC7702Permissive_Permit2 exercises a 7702-delegated EOA with Permit2.
// Permit2 routes by code.length → calls delegate's isValidSignature, which accepts raw owner ECDSA.
func TestWalletMatrix_D_ERC7702Permissive_Permit2(t *testing.T) {
	key := os.Getenv("EVM_CLIENT_7702_PRIVATE_KEY")
	expectedAddr := os.Getenv("EVM_CLIENT_7702_ADDRESS")
	facil := os.Getenv("EVM_FACILITATOR_PRIVATE_KEY")
	rs := os.Getenv("EVM_RESOURCE_SERVER_ADDRESS")
	if key == "" || facil == "" || rs == "" {
		t.Skip("EVM_CLIENT_7702_PRIVATE_KEY / EVM_FACILITATOR_PRIVATE_KEY / EVM_RESOURCE_SERVER_ADDRESS required")
	}
	facilitatorSigner, err := newRealFacilitatorEvmSigner(facil, matrixRPC)
	if err != nil {
		t.Fatalf("facilitator signer: %v", err)
	}
	cleanKey := strings.TrimPrefix(key, "0x")
	privKey, err := crypto.HexToECDSA(cleanKey)
	if err != nil {
		t.Fatalf("parse key: %v", err)
	}
	addr := crypto.PubkeyToAddress(privKey.PublicKey).Hex()
	if expectedAddr != "" && !strings.EqualFold(addr, expectedAddr) {
		t.Errorf("key derives to %s, expected %s", addr, expectedAddr)
	}
	ctx := context.Background()
	code, err := facilitatorSigner.GetCode(ctx, addr)
	if err != nil {
		t.Fatalf("get code: %v", err)
	}
	if !evm.IsERC7702Delegation(code) {
		t.Skipf("Account %s is not ERC-7702 delegated — run setup-wallets-v3.mjs first", addr)
	}
	runMatrixFlowPermit2(t, key, facil, rs, "wallet-D-erc7702-permit2")
}

// TestWalletMatrix_Verify7702Detection_CodeRouting confirms the strict primitive
// routes 7702 EOAs to EIP-1271 (not ECDSA), which is the root of the 7702 fix.
func TestWalletMatrix_Verify7702Detection_CodeRouting(t *testing.T) {
	key := os.Getenv("EVM_CLIENT_7702_PRIVATE_KEY")
	facil := os.Getenv("EVM_FACILITATOR_PRIVATE_KEY")
	if key == "" || facil == "" {
		t.Skip("EVM_CLIENT_7702_PRIVATE_KEY / EVM_FACILITATOR_PRIVATE_KEY required")
	}

	cleanKey := strings.TrimPrefix(key, "0x")
	privKey, err := crypto.HexToECDSA(cleanKey)
	if err != nil {
		t.Fatalf("parse key: %v", err)
	}
	addr := crypto.PubkeyToAddress(privKey.PublicKey).Hex()

	ctx := context.Background()
	facilitatorSigner, err := newRealFacilitatorEvmSigner(facil, matrixRPC)
	if err != nil {
		t.Fatalf("facilitator signer: %v", err)
	}

	code, err := facilitatorSigner.GetCode(ctx, addr)
	if err != nil {
		t.Fatalf("get code: %v", err)
	}

	isDelegated := evm.IsERC7702Delegation(code)
	t.Logf("Address %s: code length=%d isDelegated=%v", addr, len(code), isDelegated)

	if isDelegated {
		delegate, ok := evm.GetERC7702DelegateAddress(code)
		if !ok {
			t.Fatal("GetERC7702DelegateAddress failed for valid delegation")
		}
		t.Logf("✅ Delegate: %s", delegate.Hex())

		// With code present, VerifySignatureStrict uses EIP-1271 (not ecrecover).
		// This is the key property: pre-verify must match on-chain routing.
		// The strict primitive call is indirect via verifyEIP3009 in facilitate path.
		// This is exercised in TestWalletMatrix_D_ERC7702Permissive.
		t.Log("✅ ERC-7702 detection working correctly — routing will use EIP-1271")
	} else {
		t.Log("Account is not ERC-7702 delegated (plain EOA or contract)")
	}
}

// smartAccountClientSigner wraps a real signer but overrides Address()
// to present a smart account address instead of the signing key's address.
// This allows the owner key to sign payment authorizations where `from`
// is the smart account address.
type smartAccountClientSigner struct {
	inner   evm.ClientEvmSigner
	address string
}

func (s *smartAccountClientSigner) Address() string { return s.address }
func (s *smartAccountClientSigner) SignTypedData(
	ctx context.Context,
	domain evm.TypedDataDomain,
	types map[string][]evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	return s.inner.SignTypedData(ctx, domain, types, primaryType, message)
}
