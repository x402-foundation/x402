package integration_test

import (
	"context"
	"os"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/hedera"
	hederaclient "github.com/x402-foundation/x402/go/v2/mechanisms/hedera/exact/client"
	hederafacil "github.com/x402-foundation/x402/go/v2/mechanisms/hedera/exact/facilitator"
	hederaserver "github.com/x402-foundation/x402/go/v2/mechanisms/hedera/exact/server"
	"github.com/x402-foundation/x402/go/v2/types"
)

// TestHederaExactIntegrationV2 exercises client → verify → settle on Hedera testnet.
// Skips unless all required HEDERA_* credentials are present.
func TestHederaExactIntegrationV2(t *testing.T) {
	clientAccountID := os.Getenv("HEDERA_CLIENT_ACCOUNT_ID")
	clientPrivateKey := os.Getenv("HEDERA_CLIENT_PRIVATE_KEY")
	facilitatorAccountID := os.Getenv("HEDERA_FACILITATOR_ACCOUNT_ID")
	facilitatorPrivateKey := os.Getenv("HEDERA_FACILITATOR_PRIVATE_KEY")
	resourceServerAccountID := os.Getenv("HEDERA_RESOURCE_SERVER_ACCOUNT_ID")

	if clientAccountID == "" || clientPrivateKey == "" ||
		facilitatorAccountID == "" || facilitatorPrivateKey == "" ||
		resourceServerAccountID == "" {
		t.Skip("Skipping Hedera integration test: HEDERA_CLIENT_ACCOUNT_ID, HEDERA_CLIENT_PRIVATE_KEY, HEDERA_FACILITATOR_ACCOUNT_ID, HEDERA_FACILITATOR_PRIVATE_KEY, and HEDERA_RESOURCE_SERVER_ACCOUNT_ID must be set")
	}

	network := os.Getenv("HEDERA_NETWORK")
	if network == "" {
		network = hedera.HederaTestnetCAIP2
	}
	asset := os.Getenv("HEDERA_ASSET")
	if asset == "" {
		asset = hedera.HBARAssetID
	}
	amount := os.Getenv("HEDERA_AMOUNT")
	if amount == "" {
		amount = "1" // 1 tinybar by default
	}

	ctx := context.Background()

	clientSigner, err := hedera.NewPrivateKeyClientSigner(clientAccountID, clientPrivateKey, network)
	if err != nil {
		t.Fatalf("client signer: %v", err)
	}
	facSigner, err := hedera.NewPrivateKeyFacilitatorSigner(hedera.SignerConfig{
		Operators: []hedera.OperatorCredentials{{
			AccountID:  facilitatorAccountID,
			PrivateKey: facilitatorPrivateKey,
		}},
	})
	if err != nil {
		t.Fatalf("facilitator signer: %v", err)
	}

	xClient := x402.Newx402Client()
	xClient.Register(x402.Network(network), hederaclient.NewExactHederaScheme(clientSigner))

	xFacilitator := x402.Newx402Facilitator()
	xFacilitator.Register([]x402.Network{x402.Network(network)}, hederafacil.NewExactHederaScheme(facSigner))

	xServer := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(&localHederaFacilitatorClient{facilitator: xFacilitator}),
	)
	xServer.Register(x402.Network(network), hederaserver.NewExactHederaScheme())
	if err := xServer.Initialize(ctx); err != nil {
		t.Fatalf("server init: %v", err)
	}

	requirements := types.PaymentRequirements{
		Scheme:            hedera.SchemeExact,
		Network:           network,
		Asset:             asset,
		Amount:            amount,
		PayTo:             resourceServerAccountID,
		MaxTimeoutSeconds: 180,
		Extra: map[string]interface{}{
			"feePayer": facilitatorAccountID,
		},
	}

	payload, err := hederaclient.NewExactHederaScheme(clientSigner).CreatePaymentPayload(ctx, requirements, x402.PaymentPayloadContext{})
	if err != nil {
		t.Fatalf("create payload: %v", err)
	}

	verifyResp, err := hederafacil.NewExactHederaScheme(facSigner).Verify(ctx, payload, requirements, nil)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !verifyResp.IsValid {
		t.Fatalf("verify invalid: %+v", verifyResp)
	}
	if verifyResp.Payer != clientAccountID {
		t.Fatalf("payer=%s want %s", verifyResp.Payer, clientAccountID)
	}

	settleResp, err := hederafacil.NewExactHederaScheme(facSigner).Settle(ctx, payload, requirements, nil)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if !settleResp.Success {
		t.Fatalf("settle failed: %+v", settleResp)
	}
	if settleResp.Transaction == "" {
		t.Fatal("expected transaction id")
	}
	t.Logf("settled tx=%s payer=%s", settleResp.Transaction, settleResp.Payer)
}

type localHederaFacilitatorClient struct {
	facilitator *x402.X402Facilitator
}

func (l *localHederaFacilitatorClient) Verify(ctx context.Context, payload, requirements []byte) (*x402.VerifyResponse, error) {
	return l.facilitator.Verify(ctx, payload, requirements)
}

func (l *localHederaFacilitatorClient) Settle(ctx context.Context, payload, requirements []byte) (*x402.SettleResponse, error) {
	return l.facilitator.Settle(ctx, payload, requirements)
}

func (l *localHederaFacilitatorClient) GetSupported(context.Context) (x402.SupportedResponse, error) {
	return l.facilitator.GetSupported(), nil
}
