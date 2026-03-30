package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/extensions/paymentidentifier"
	x402http "github.com/coinbase/x402/go/http"
	evm "github.com/coinbase/x402/go/mechanisms/evm/exact/client"
	evmsigners "github.com/coinbase/x402/go/signers/evm"
	"github.com/joho/godotenv"
)

/**
 * Payment Identifier Client Example
 *
 * This demonstrates how to use the payment-identifier extension on the client side.
 * The extension allows clients to provide a unique idempotency key for payment requests.
 *
 * Key concepts:
 * - Check if server requires payment identifier from PaymentRequired response
 * - Append a payment identifier using AppendPaymentIdentifierToExtensions()
 * - Use GeneratePaymentID() for automatic ID generation or provide custom IDs
 *
 * Use cases:
 * - Retry failed requests without duplicate charges
 * - Ensure exactly-once processing semantics
 * - Track payments across multiple request attempts
 */

// PaymentIdentifierTransport wraps the x402 payment transport to inject
// a payment identifier into the extensions before payment processing.
//
// On the first request it intercepts the 402 response, appends the payment ID
// to extensions, and lets the PaymentRoundTripper create and sign a payment.
// It then caches the resulting PAYMENT-SIGNATURE header so that subsequent
// requests replay the exact same signed payload — a true retry.
type PaymentIdentifierTransport struct {
	Inner                http.RoundTripper
	PaymentID            string
	cachedPaymentHeader  string // PAYMENT-SIGNATURE from the first successful attempt
}

func (t *PaymentIdentifierTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Retry path: if we already have a cached payment header and this is a
	// fresh request (no header set by PaymentRoundTripper yet), inject it
	// directly so the server sees the exact same signed payload.
	if t.cachedPaymentHeader != "" && req.Header.Get("PAYMENT-SIGNATURE") == "" {
		fmt.Println("  Replaying cached payment header (true retry)")
		retryReq := req.Clone(req.Context())
		retryReq.Header.Set("PAYMENT-SIGNATURE", t.cachedPaymentHeader)
		if req.GetBody != nil {
			if body, err := req.GetBody(); err == nil {
				retryReq.Body = body
			}
		}
		return http.DefaultTransport.RoundTrip(retryReq)
	}

	// Cache the payment header when the PaymentRoundTripper retries with one.
	if header := req.Header.Get("PAYMENT-SIGNATURE"); header != "" {
		t.cachedPaymentHeader = header
	}

	// Make the initial request ourselves to check for 402
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		return nil, err
	}

	// If not 402, return as-is
	if resp.StatusCode != http.StatusPaymentRequired {
		return resp, nil
	}

	// Intercept the Payment-Required header and inject the payment identifier
	prHeader := resp.Header.Get("Payment-Required")
	if prHeader != "" {
		decoded, err := base64.StdEncoding.DecodeString(prHeader)
		if err == nil {
			var paymentRequired x402.PaymentRequired
			if err := json.Unmarshal(decoded, &paymentRequired); err == nil {
				if paymentRequired.Extensions == nil {
					paymentRequired.Extensions = make(map[string]interface{})
				}

				// Check if server declared payment-identifier extension
				if _, ok := paymentRequired.Extensions[paymentidentifier.PAYMENT_IDENTIFIER]; ok {
					required := paymentidentifier.IsPaymentIdentifierRequired(paymentRequired.Extensions[paymentidentifier.PAYMENT_IDENTIFIER])
					fmt.Printf("  Payment identifier required by server: %v\n", required)

					// Append payment identifier to extensions
					if err := paymentidentifier.AppendPaymentIdentifierToExtensions(paymentRequired.Extensions, t.PaymentID); err != nil {
						fmt.Printf("  Warning: failed to append payment identifier: %v\n", err)
					} else {
						fmt.Printf("  Added payment ID: %s\n\n", t.PaymentID)
					}

					// Re-encode the modified header
					modified, err := json.Marshal(paymentRequired)
					if err == nil {
						resp.Header.Set("Payment-Required", base64.StdEncoding.EncodeToString(modified))
					}
				} else {
					fmt.Println("  Server does not support payment-identifier extension")
				}
			}
		}
	}

	// Return the modified 402 so the PaymentRoundTripper creates the payment
	return resp, nil
}

func main() {
	godotenv.Load()

	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		fmt.Println("EVM_PRIVATE_KEY environment variable is required")
		os.Exit(1)
	}

	serverURL := os.Getenv("SERVER_URL")
	if serverURL == "" {
		serverURL = "http://localhost:4021/order"
	}

	ctx := context.Background()

	// Create signer from private key
	evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
	if err != nil {
		fmt.Printf("Failed to create signer: %v\n", err)
		os.Exit(1)
	}

	// Create client with scheme registration
	client := x402.Newx402Client().
		Register("eip155:*", evm.NewExactEvmScheme(evmSigner, nil))

	// Generate a unique payment ID for this session
	paymentID := paymentidentifier.GeneratePaymentID("")
	fmt.Printf("Generated Payment ID: %s\n\n", paymentID)

	// Create HTTP client with payment identifier injection.
	// The PaymentIdentifierTransport intercepts the 402 response to inject
	// the payment identifier into extensions before the payment flow runs.
	httpClient := x402http.Newx402HTTPClient(client)
	wrappedClient := x402http.WrapHTTPClientWithPayment(
		&http.Client{
			Transport: &PaymentIdentifierTransport{
				PaymentID: paymentID,
			},
		},
		httpClient,
	)

	// First request - will process payment
	fmt.Println("First Request (with payment ID)")
	fmt.Printf("Making request to: %s\n\n", serverURL)

	startTime1 := time.Now()
	resp1, httpResp1, err := makeRequest(ctx, wrappedClient, serverURL)
	duration1 := time.Since(startTime1)
	if err != nil {
		fmt.Printf("Request failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Response (%v): %s\n", duration1, resp1)
	printPaymentDetails(httpResp1)

	// Second request - replay the same signed payment (true retry)
	fmt.Println("\nSecond Request (retry with cached payment)")
	fmt.Printf("Making request to: %s\n", serverURL)
	fmt.Println("Expected: Server returns cached response (same ID, same payload)")

	startTime2 := time.Now()
	resp2, httpResp2, err := makeRequest(ctx, wrappedClient, serverURL)
	duration2 := time.Since(startTime2)
	if err != nil {
		fmt.Printf("Request failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Response (%v): %s\n", duration2, resp2)
	printPaymentDetails(httpResp2)

	// Summary
	fmt.Println("Summary")
	fmt.Printf("  Payment ID: %s\n", paymentID)
	fmt.Printf("  First request:  %v\n", duration1)
	fmt.Printf("  Second request: %v\n", duration2)
}

func makeRequest(ctx context.Context, client *http.Client, url string) (string, *http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", url, strings.NewReader(`{"item": "widget"}`))
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", resp, err
	}

	return string(body), resp, nil
}

// printPaymentDetails extracts and prints payment settlement from response headers.
func printPaymentDetails(resp *http.Response) {
	paymentHeader := resp.Header.Get("PAYMENT-RESPONSE")
	if paymentHeader == "" {
		paymentHeader = resp.Header.Get("X-PAYMENT-RESPONSE")
	}
	if paymentHeader == "" {
		return
	}
	decoded, err := base64.StdEncoding.DecodeString(paymentHeader)
	if err != nil {
		return
	}
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
