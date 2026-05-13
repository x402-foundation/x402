package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
)

// wrapHTTPClient wraps a standard HTTP client with x402 payment handling
func wrapHTTPClient(x402Client *x402.X402Client) *http.Client {
	// Create x402 HTTP client wrapper
	httpClient := x402http.Newx402HTTPClient(x402Client)

	// Wrap standard HTTP client with payment handling
	return x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)
}

// extractPaymentResponse extracts settlement details from response headers
func extractPaymentResponse(headers http.Header) (*x402.SettleResponse, error) {
	// Try v2 header first
	paymentHeader := headers.Get("PAYMENT-RESPONSE")
	if paymentHeader == "" {
		// Try v1 header
		paymentHeader = headers.Get("X-PAYMENT-RESPONSE")
	}

	if paymentHeader == "" {
		return nil, nil
	}

	// Decode base64
	decoded, err := base64.StdEncoding.DecodeString(paymentHeader)
	if err != nil {
		return nil, err
	}

	// Parse settlement response
	var settleResp x402.SettleResponse
	if err := json.Unmarshal(decoded, &settleResp); err != nil {
		return nil, err
	}

	return &settleResp, nil
}
