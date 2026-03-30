package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	x402 "github.com/coinbase/x402/go"
	"github.com/joho/godotenv"
)

/**
 * Main example runner for Go HTTP client demonstrations.
 *
 * This example shows how to use the x402 Go HTTP client to make requests
 * to resource servers that require payment. Different client creation
 * patterns can be selected via CLI argument:
 *
 * - builder-pattern: Basic builder pattern with Register()
 * - mechanism-helper-registration: Using mechanism helpers for clean registration
 *
 * Usage:
 *   go run . builder-pattern
 *   go run . mechanism-helper-registration
 */

func main() {
	// Load .env file if it exists
	if err := godotenv.Load(); err != nil {
		fmt.Println("No .env file found, using environment variables")
	}

	pattern := "builder-pattern"
	if len(os.Args) > 1 {
		pattern = os.Args[1]
	}

	fmt.Printf("\nRunning example: %s\n\n", pattern)

	// Get configuration
	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		fmt.Println("❌ EVM_PRIVATE_KEY environment variable is required")
		os.Exit(1)
	}

	svmPrivateKey := os.Getenv("SVM_PRIVATE_KEY")

	url := os.Getenv("SERVER_URL")
	if url == "" {
		url = "http://localhost:4021/weather"
	}

	// Create client based on pattern
	var client *x402.X402Client
	var err error

	switch pattern {
	case "builder-pattern":
		client, err = createBuilderPatternClient(evmPrivateKey, svmPrivateKey)
	case "mechanism-helper-registration":
		client, err = createMechanismHelperRegistrationClient(evmPrivateKey, svmPrivateKey)
	default:
		fmt.Printf("❌ Unknown pattern: %s\n", pattern)
		fmt.Println("Available patterns: builder-pattern, mechanism-helper-registration")
		os.Exit(1)
	}

	if err != nil {
		fmt.Printf("❌ Failed to create client: %v\n", err)
		os.Exit(1)
	}

	// Make the request
	if err := makeRequest(client, url); err != nil {
		fmt.Printf("❌ Request failed: %v\n", err)
		os.Exit(1)
	}
}

// makeRequest performs an HTTP GET request with payment handling
func makeRequest(client *x402.X402Client, url string) error {
	httpClient := wrapHTTPClient(client)

	fmt.Printf("Making request to: %s\n\n", url)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	// Read response body
	var responseData interface{}
	if err := json.NewDecoder(resp.Body).Decode(&responseData); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}

	fmt.Println("✅ Response body:")
	prettyJSON, _ := json.MarshalIndent(responseData, "  ", "  ")
	fmt.Printf("  %s\n", string(prettyJSON))

	// Extract payment response from headers if present
	paymentHeader := resp.Header.Get("PAYMENT-RESPONSE")
	if paymentHeader == "" {
		paymentHeader = resp.Header.Get("X-PAYMENT-RESPONSE")
	}

	if paymentHeader != "" {
		fmt.Println("\n💰 Payment Details:")
		settleResp, err := extractPaymentResponse(resp.Header)
		if err == nil {
			fmt.Printf("  Success: %v\n", settleResp.Success)
			if settleResp.ErrorReason != "" {
				fmt.Printf("  ErrorReason: %s\n", settleResp.ErrorReason)
			}
			if settleResp.Transaction != "" {
				fmt.Printf("  Transaction: %s\n", settleResp.Transaction)
			}
			fmt.Printf("  Network: %s\n", settleResp.Network)
			fmt.Printf("  Payer: %s\n", settleResp.Payer)
		}
	}

	return nil
}

