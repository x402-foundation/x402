package main

import (
	"context"
	"fmt"
	"net/http"

	x402 "github.com/coinbase/x402/go"
	x402http "github.com/coinbase/x402/go/http"
	evm "github.com/coinbase/x402/go/mechanisms/evm/exact/client"
	evmsigners "github.com/coinbase/x402/go/signers/evm"
)

/**
 * Hooks Example
 *
 * This demonstrates how to register hooks for payment creation lifecycle events.
 * Hooks allow you to add custom logic at different stages:
 * - OnBeforePaymentCreation: Called before payment creation starts, can abort
 * - OnAfterPaymentCreation: Called after successful payment creation
 * - OnPaymentCreationFailure: Called when payment creation fails, can recover
 *
 * This is an advanced feature useful for:
 * - Logging payment events for debugging and monitoring
 * - Custom validation before allowing payments
 * - Error recovery strategies
 * - Metrics and analytics collection
 */

func runHooksExample(ctx context.Context, evmPrivateKey, url string) error {
	fmt.Println("🔧 Creating client with payment lifecycle hooks...\n")

	// Create signer from private key
	evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
	if err != nil {
		return err
	}

	// Create client with scheme registration
	client := x402.Newx402Client().
		Register("eip155:*", evm.NewExactEvmScheme(evmSigner, nil))

	// Register lifecycle hooks

	// OnBeforePaymentCreation: Called before payment is created
	// Use this for logging, validation, or aborting payment creation
	client.OnBeforePaymentCreation(func(ctx x402.PaymentCreationContext) (*x402.BeforePaymentCreationHookResult, error) {
		fmt.Printf("🔍 [BeforePaymentCreation] Creating payment for:\n")
		fmt.Printf("   Network: %s\n", ctx.SelectedRequirements.GetNetwork())
		fmt.Printf("   Scheme: %s\n", ctx.SelectedRequirements.GetScheme())
		fmt.Println()

		// You can abort payment creation by returning:
		// return &x402.BeforePaymentCreationHookResult{
		//     Abort: true,
		//     Reason: "Payment not allowed for this resource",
		// }, nil

		return nil, nil // Continue with payment creation
	})

	// OnAfterPaymentCreation: Called after payment is successfully created
	// Use this for logging, metrics, or other side effects
	client.OnAfterPaymentCreation(func(ctx x402.PaymentCreatedContext) error {
		fmt.Printf("✅ [AfterPaymentCreation] Payment created successfully\n")
		fmt.Printf("   Version: %d\n", ctx.Version)
		fmt.Println()

		// Perform side effects like logging to database, sending metrics, etc.
		// Errors here are logged but don't fail the payment

		return nil
	})

	// OnPaymentCreationFailure: Called when payment creation fails
	// Use this for error recovery or alternative payment methods
	client.OnPaymentCreationFailure(func(ctx x402.PaymentCreationFailureContext) (*x402.PaymentCreationFailureHookResult, error) {
		fmt.Printf("❌ [OnPaymentCreationFailure] Payment creation failed: %v\n", ctx.Error)
		fmt.Println()

		// You could attempt to recover by providing an alternative payload:
		// return &x402.PaymentCreationFailureHookResult{
		//     Recovered: true,
		//     Payload: alternativePayload,
		// }, nil

		return nil, nil // Don't recover, let it fail
	})

	// Create HTTP client wrapper
	httpClient := x402http.Newx402HTTPClient(client)
	wrappedClient := x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)

	// Make request to trigger hooks
	fmt.Printf("🌐 Making request to: %s\n\n", url)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}

	resp, err := wrappedClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	fmt.Println("✅ Request completed successfully with hooks\n")

	if err := printResponse(resp, "Response with hooks"); err != nil {
		return err
	}
	printPaymentDetails(resp.Header)
	return nil
}

