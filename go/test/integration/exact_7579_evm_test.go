package integration_test

import (
	"context"
	"os"
	"strings"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	exactevmclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/client"
	exactevmfacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/facilitator"
	exactevmserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/server"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// TestExact7579EvmIntegration exercises the full exact/EIP-3009 flow with a deployed
// Biconomy Nexus (ERC-7579) account that requires ERC-7739 nested signing + validator prefix.
func TestExact7579EvmIntegration(t *testing.T) {
	ownerKey := os.Getenv("EVM_CLIENT_7579_OWNER_PRIVATE_KEY")
	acctAddr := os.Getenv("EVM_CLIENT_7579_ADDRESS")
	validator := os.Getenv("EVM_CLIENT_7579_VALIDATOR")
	facil := os.Getenv("EVM_FACILITATOR_PRIVATE_KEY")
	rs := os.Getenv("EVM_RESOURCE_SERVER_ADDRESS")
	if ownerKey == "" || acctAddr == "" || facil == "" || rs == "" {
		t.Skip("EVM_CLIENT_7579_OWNER_PRIVATE_KEY / EVM_CLIENT_7579_ADDRESS / EVM_FACILITATOR_PRIVATE_KEY / EVM_RESOURCE_SERVER_ADDRESS required")
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

	client := x402.Newx402Client()
	client.Register(matrixNetwork, exactevmclient.NewExactEvmScheme(nexusSigner, nil))

	facilitator := x402.Newx402Facilitator()
	facilitator.Register([]x402.Network{matrixNetwork},
		exactevmfacilitator.NewExactEvmScheme(facilitatorSigner, nil))

	facilClient := &localEvmFacilitatorClient{facilitator: facilitator}
	server := x402.Newx402ResourceServer(x402.WithFacilitatorClient(facilClient))
	server.Register(matrixNetwork, exactevmserver.NewExactEvmScheme())
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("server init: %v", err)
	}

	resource := &types.ResourceInfo{URL: "https://test.x402.org", Description: "exact-7579-biconomy-nexus"}
	accepts := buildMatrixAccepts(rs)
	resp := server.CreatePaymentRequiredResponse(accepts, resource, "", nil)

	selected, err := client.SelectPaymentRequirements(accepts)
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	payload, err := client.CreatePaymentPayload(ctx, selected, resource, resp.Extensions)
	if err != nil {
		t.Fatalf("create payload: %v", err)
	}

	accepted := server.FindMatchingRequirements(accepts, payload)
	if accepted == nil {
		t.Fatalf("no matching requirements")
	}

	verifyResp, err := server.VerifyPayment(ctx, payload, *accepted)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !verifyResp.IsValid {
		t.Fatalf("verify failed: %s", verifyResp.InvalidReason)
	}

	settleResp, err := server.SettlePayment(ctx, payload, *accepted, nil)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if !settleResp.Success {
		t.Fatalf("settle failed: %s", settleResp.ErrorReason)
	}
	if !strings.EqualFold(settleResp.Payer, acctAddr) {
		t.Fatalf("payer %s != nexus account %s", settleResp.Payer, acctAddr)
	}
	t.Logf("exact/7579 ✅ tx=%s payer=%s", settleResp.Transaction, settleResp.Payer)
}
