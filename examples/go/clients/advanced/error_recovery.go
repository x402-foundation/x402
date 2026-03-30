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
 * Advanced Error Recovery Example
 *
 * This example demonstrates sophisticated error handling strategies:
 * - Automatic recovery from payment creation failures
 * - Custom error classification
 * - Fallback payment methods
 * - Detailed error logging and metrics
 */

type ErrorRecoveryClient struct {
	client          *x402.X402Client
	fallbackEnabled bool
	attemptCount    int
}

func runErrorRecoveryExample(ctx context.Context, evmPrivateKey, url string) error {
	fmt.Println("🛡️  Creating client with advanced error recovery...\n")

	// Create signer
	evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
	if err != nil {
		return err
	}

	// Create x402 client with comprehensive error handling
	client := x402.Newx402Client().
		Register("eip155:*", evm.NewExactEvmScheme(evmSigner, nil))

	// Recovery counter
	recoveryAttempts := 0
	successfulRecoveries := 0

	// OnBeforePaymentCreation: Pre-flight validation
	client.OnBeforePaymentCreation(func(ctx x402.PaymentCreationContext) (*x402.BeforePaymentCreationHookResult, error) {
		fmt.Printf("🔍 [Pre-flight] Validating payment requirements...\n")
		fmt.Printf("   Network: %s, Scheme: %s\n", ctx.SelectedRequirements.GetNetwork(), ctx.SelectedRequirements.GetScheme())

		// Could implement custom validation logic here
		// For example, check if user has sufficient balance before creating payment

		return nil, nil // Continue
	})

	// OnPaymentCreationFailure: Advanced error recovery
	client.OnPaymentCreationFailure(func(ctx x402.PaymentCreationFailureContext) (*x402.PaymentCreationFailureHookResult, error) {
		recoveryAttempts++
		fmt.Printf("❌ [Error Recovery] Payment creation failed (attempt %d)\n", recoveryAttempts)
		fmt.Printf("   Error: %v\n", ctx.Error)
		fmt.Printf("   Network: %s\n", ctx.SelectedRequirements.GetNetwork())
		fmt.Printf("   Scheme: %s\n", ctx.SelectedRequirements.GetScheme())

		// Classify error type
		errorType := classifyError(ctx.Error)
		fmt.Printf("   Error type: %s\n", errorType)

		// Recovery strategy based on error type
		switch errorType {
		case "network":
			fmt.Println("   🔄 Network error - will retry automatically")
			return nil, nil // Let retry logic handle it

		case "insufficient_balance":
			fmt.Println("   💰 Insufficient balance - cannot recover")
			return nil, ctx.Error // Propagate error

		case "signing_error":
			fmt.Println("   🔑 Signing error - attempting recovery...")
			// In a real scenario, you might try with a different signer or method
			successfulRecoveries++
			return nil, nil

		default:
			fmt.Println("   ⚠️  Unknown error - will not recover")
			return nil, ctx.Error
		}
	})

	// OnAfterPaymentCreation: Success logging
	client.OnAfterPaymentCreation(func(ctx x402.PaymentCreatedContext) error {
		fmt.Printf("✅ [Success] Payment created\n")
		if recoveryAttempts > 0 {
			fmt.Printf("   Recovered after %d attempts\n", recoveryAttempts)
		}
		return nil
	})

	// Wrap HTTP client
	httpClient := x402http.Newx402HTTPClient(client)
	wrappedClient := x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)

	// Make request
	fmt.Printf("\n🌐 Making request to: %s\n\n", url)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}

	resp, err := wrappedClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed after recovery attempts: %w", err)
	}
	defer resp.Body.Close()

	// Print statistics
	fmt.Printf("\n📊 Error Recovery Statistics:\n")
	fmt.Printf("   Total recovery attempts: %d\n", recoveryAttempts)
	fmt.Printf("   Successful recoveries: %d\n", successfulRecoveries)
	fmt.Printf("   Final status: %d\n\n", resp.StatusCode)

	if err := printResponse(resp, "Response after error recovery"); err != nil {
		return err
	}
	printPaymentDetails(resp.Header)
	return nil
}

// classifyError categorizes errors for targeted recovery strategies
func classifyError(err error) string {
	if err == nil {
		return "none"
	}

	errMsg := err.Error()

	// Simple classification - in production, use more sophisticated logic
	switch {
	case contains(errMsg, "network", "timeout", "connection"):
		return "network"
	case contains(errMsg, "balance", "funds"):
		return "insufficient_balance"
	case contains(errMsg, "sign", "signature"):
		return "signing_error"
	case contains(errMsg, "invalid", "malformed"):
		return "validation_error"
	default:
		return "unknown"
	}
}

// contains checks if the error message contains any of the keywords
func contains(msg string, keywords ...string) bool {
	for _, keyword := range keywords {
		if len(msg) > 0 && len(keyword) > 0 {
			// Simple substring check - in production use better matching
			for i := 0; i <= len(msg)-len(keyword); i++ {
				if msg[i:i+len(keyword)] == keyword {
					return true
				}
			}
		}
	}
	return false
}

