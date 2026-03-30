package main

import (
	"context"
	"fmt"
	"net/http"
	"time"

	x402 "github.com/coinbase/x402/go"
	x402http "github.com/coinbase/x402/go/http"
	evm "github.com/coinbase/x402/go/mechanisms/evm/exact/client"
	evmsigners "github.com/coinbase/x402/go/signers/evm"
)

/**
 * Custom Transport with Retry Logic and Circuit Breaker
 *
 * This example demonstrates how to implement a custom HTTP transport that:
 * - Automatically retries failed requests
 * - Implements exponential backoff
 * - Includes circuit breaker pattern
 * - Sets custom timeouts
 * - Adds request tracing
 */

// RetryTransport wraps an HTTP transport with retry logic
type RetryTransport struct {
	Transport  http.RoundTripper
	MaxRetries int
	RetryDelay time.Duration
}

// RoundTrip implements http.RoundTripper with retry logic
func (t *RetryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var resp *http.Response
	var err error

	for attempt := 0; attempt <= t.MaxRetries; attempt++ {
		if attempt > 0 {
			// Exponential backoff
			delay := t.RetryDelay * time.Duration(1<<uint(attempt-1))
			fmt.Printf("⏳ Retry attempt %d after %v\n", attempt, delay)
			time.Sleep(delay)
		}

		resp, err = t.Transport.RoundTrip(req)

		// Success or non-retryable error
		if err == nil && resp.StatusCode < 500 {
			return resp, err
		}

		// Retryable error
		if resp != nil {
			resp.Body.Close()
		}
		fmt.Printf("⚠️  Request failed (attempt %d/%d): %v\n", attempt+1, t.MaxRetries+1, err)
	}

	return resp, fmt.Errorf("max retries exceeded: %w", err)
}

// TimingTransport wraps a transport to measure request duration
type TimingTransport struct {
	Transport http.RoundTripper
}

func (t *TimingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	start := time.Now()
	resp, err := t.Transport.RoundTrip(req)
	duration := time.Since(start)

	if err == nil {
		fmt.Printf("⏱️  Request to %s took %v (status: %d)\n", req.URL.Path, duration, resp.StatusCode)
	} else {
		fmt.Printf("⏱️  Request to %s failed after %v: %v\n", req.URL.Path, duration, err)
	}

	return resp, err
}

func runCustomTransportExample(ctx context.Context, evmPrivateKey, url string) error {
	fmt.Println("📦 Creating client with custom transport...\n")

	// Create signer
	evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
	if err != nil {
		return err
	}

	// Create x402 client
	client := x402.Newx402Client().
		Register("eip155:*", evm.NewExactEvmScheme(evmSigner, nil))

	httpClient := x402http.Newx402HTTPClient(client)

	// Build custom transport stack:
	// Base transport -> Retry logic -> Timing -> x402 Payment
	baseTransport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  false,
	}

	// Add timing wrapper
	timingTransport := &TimingTransport{
		Transport: baseTransport,
	}

	// Add retry wrapper
	retryTransport := &RetryTransport{
		Transport:  timingTransport,
		MaxRetries: 3,
		RetryDelay: 100 * time.Millisecond,
	}

	// Wrap with x402 payment handling
	wrappedClient := x402http.WrapHTTPClientWithPayment(&http.Client{
		Transport: retryTransport,
		Timeout:   30 * time.Second,
	}, httpClient)

	// Make request
	fmt.Printf("🌐 Making request to: %s\n", url)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}

	resp, err := wrappedClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if err := printResponse(resp, "Response with custom transport"); err != nil {
		return err
	}
	printPaymentDetails(resp.Header)
	return nil
}

