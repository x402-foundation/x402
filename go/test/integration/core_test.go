package integration_test

import (
	"context"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/test/mocks/cash"
	"github.com/x402-foundation/x402/go/types"
)

// TestCoreIntegration tests the integration between x402Client, x402ResourceServer, and x402Facilitator
func TestCoreIntegration(t *testing.T) {
	t.Run("Cash Flow - x402Client / x402ResourceServer / x402Facilitator", func(t *testing.T) {
		ctx := context.Background()

		// Setup client with cash scheme
		client := x402.Newx402Client()
		client.Register("x402:cash", cash.NewSchemeNetworkClient("John"))

		// Setup facilitator with cash scheme
		facilitator := x402.Newx402Facilitator()
		facilitator.Register([]x402.Network{"x402:cash"}, cash.NewSchemeNetworkFacilitator())

		// Create facilitator client wrapper
		facilitatorClient := cash.NewFacilitatorClient(facilitator)

		// Setup resource server (V2 only)
		server := x402.Newx402ResourceServer(
			x402.WithFacilitatorClient(facilitatorClient),
		)
		server.Register("x402:cash", cash.NewSchemeNetworkServer())

		// Initialize server to populate facilitator clients
		err := server.Initialize(ctx)
		if err != nil {
			t.Fatalf("Failed to initialize server: %v", err)
		}

		// Server - builds PaymentRequired response (V2)
		accepts := []types.PaymentRequirements{
			cash.BuildPaymentRequirements("Company Co.", "USD", "1"),
		}
		resource := &types.ResourceInfo{
			URL:         "https://company.co",
			Description: "Company Co. resource",
			MimeType:    "application/json",
		}
		paymentRequiredResponse := server.CreatePaymentRequiredResponse(accepts, resource, "", nil)

		// Client - selects payment requirement (V2 typed)
		selected, err := client.SelectPaymentRequirements(accepts)
		if err != nil {
			t.Fatalf("Failed to select payment requirements: %v", err)
		}

		// Client - creates payment payload (V2 typed)
		payload, err := client.CreatePaymentPayload(ctx, selected, resource, paymentRequiredResponse.Extensions)
		if err != nil {
			t.Fatalf("Failed to create payment payload: %v", err)
		}

		// Server - finds matching requirements (typed)
		accepted := server.FindMatchingRequirements(accepts, payload)
		if accepted == nil {
			t.Fatal("No matching payment requirements found")
		}

		// Server - verifies payment (typed)
		verifyResponse, err := server.VerifyPayment(ctx, payload, *accepted)
		if err != nil {
			t.Fatalf("Failed to verify payment: %v", err)
		}

		if !verifyResponse.IsValid {
			t.Fatalf("Payment verification failed: %s", verifyResponse.InvalidReason)
		}

		// Server does work here...

		// Server - settles payment (typed)
		settleResponse, err := server.SettlePayment(ctx, payload, *accepted, nil)
		if err != nil {
			t.Fatalf("Failed to settle payment: %v", err)
		}

		if !settleResponse.Success {
			t.Fatalf("Payment settlement failed: %s", settleResponse.ErrorReason)
		}

		// Verify the transaction message
		expectedTransaction := "John transferred 1 USD to Company Co."
		if settleResponse.Transaction != expectedTransaction {
			t.Errorf("Expected transaction '%s', got '%s'", expectedTransaction, settleResponse.Transaction)
		}
	})
}
