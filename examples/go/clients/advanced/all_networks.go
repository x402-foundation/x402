package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	exactevm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/client"
	uptoevm "github.com/x402-foundation/x402/go/mechanisms/evm/upto/client"
	exactsvm "github.com/x402-foundation/x402/go/mechanisms/svm/exact/client"
	evmsigners "github.com/x402-foundation/x402/go/signers/evm"
	svmsigners "github.com/x402-foundation/x402/go/signers/svm"
)

/**
 * All Networks Client Example
 *
 * Demonstrates how to create a client that supports all available networks with
 * optional chain configuration via environment variables.
 *
 * New chain support should be added here in alphabetic order by network prefix
 * (e.g., "eip155" before "solana").
 */

func runAllNetworksExample(ctx context.Context, evmPrivateKey, svmPrivateKey, url string) error {
	fmt.Println("📦 Creating client with all available networks...\n")

	// Create x402 client
	client := x402.Newx402Client()

	// Register EVM scheme if private key is provided
	if evmPrivateKey != "" {
		evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
		if err != nil {
			return fmt.Errorf("failed to create EVM signer: %w", err)
		}
		client.Register("eip155:*", exactevm.NewExactEvmScheme(evmSigner, nil))
		client.Register("eip155:*", uptoevm.NewUptoEvmScheme(evmSigner, nil))
		fmt.Printf("✅ Registered EVM networks (eip155:*) — exact + upto\n")
	}

	// Register SVM scheme if private key is provided
	if svmPrivateKey != "" {
		svmSigner, err := svmsigners.NewClientSignerFromPrivateKey(svmPrivateKey)
		if err != nil {
			return fmt.Errorf("failed to create SVM signer: %w", err)
		}
		client.Register("solana:*", exactsvm.NewExactSvmScheme(svmSigner))
		fmt.Printf("✅ Registered SVM networks (solana:*)\n")
	}

	// Wrap HTTP client with payment handling
	httpClient := x402http.Newx402HTTPClient(client)
	wrappedClient := x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)

	fmt.Printf("\n🌐 Making request to: %s\n\n", url)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	start := time.Now()
	resp, err := wrappedClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	printDuration(start, "Request")
	if err := printResponse(resp, "Response with all networks"); err != nil {
		return err
	}

	// Extract and print payment details from headers
	printPaymentDetails(resp.Header)

	return nil
}

// printPaymentDetails extracts and prints payment settlement details from response headers
func printPaymentDetails(headers http.Header) {
	// Try v2 header first, then v1
	paymentHeader := headers.Get("PAYMENT-RESPONSE")
	if paymentHeader == "" {
		paymentHeader = headers.Get("X-PAYMENT-RESPONSE")
	}

	if paymentHeader == "" {
		return
	}

	// Decode base64
	decoded, err := base64.StdEncoding.DecodeString(paymentHeader)
	if err != nil {
		return
	}

	// Parse settlement response
	var settleResp x402.SettleResponse
	if err := json.Unmarshal(decoded, &settleResp); err != nil {
		return
	}

	fmt.Println("💰 Payment Details:")
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
