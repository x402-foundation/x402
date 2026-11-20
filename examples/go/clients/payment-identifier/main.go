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
	"sync"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/paymentidentifier"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	exactevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/client"
	uptoevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/upto/client"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
)

// Payment Identifier client example.
//
// The example makes one logical purchase. paymentIdentifierExtension appends a
// new payment identifier when the server declares the extension, and the x402
// HTTP client creates a fresh payment credential for that request.
//
// PaymentCreationContext has Ctx, Version, and SelectedRequirements. It has no
// Extensions field, so OnBeforePaymentCreation cannot carry the identifier.
// The scheme receives PaymentPayloadContext (server extensions and the spend
// cap). This extension appends the identifier after the scheme returns.
// main calls the HTTP client once. The SDK still sends its unpaid probe and
// one payment retry. This client does not cache PAYMENT-SIGNATURE for a later
// purchase, and it does not establish exactly-once effects.

// paymentIdentifierExtension is an example client extension. A nil nextID mints
// a distinct identifier on every payload. It does not store a payment header.
type paymentIdentifierExtension struct {
	mu     sync.Mutex
	nextID func() string
	lastID string
}

func (e *paymentIdentifierExtension) Key() string {
	return paymentidentifier.PAYMENT_IDENTIFIER
}

func (e *paymentIdentifierExtension) EnrichPaymentPayload(
	_ context.Context,
	payload x402.PaymentPayload,
	required x402.PaymentRequired,
) (x402.PaymentPayload, error) {
	extensions := cloneExtensions(payload.Extensions)
	if !paymentidentifier.IsPaymentIdentifierExtension(extensions[paymentidentifier.PAYMENT_IDENTIFIER]) &&
		required.Extensions != nil {
		if declared, ok := required.Extensions[paymentidentifier.PAYMENT_IDENTIFIER]; ok {
			extensions[paymentidentifier.PAYMENT_IDENTIFIER] = declared
		}
	}
	if !paymentidentifier.IsPaymentIdentifierExtension(extensions[paymentidentifier.PAYMENT_IDENTIFIER]) {
		return payload, nil
	}

	id := e.mint()
	if err := paymentidentifier.AppendPaymentIdentifierToExtensions(extensions, id); err != nil {
		return payload, err
	}
	payload.Extensions = extensions
	e.mu.Lock()
	e.lastID = id
	e.mu.Unlock()
	return payload, nil
}

func (e *paymentIdentifierExtension) mint() string {
	e.mu.Lock()
	next := e.nextID
	e.mu.Unlock()
	if next != nil {
		return next()
	}
	return paymentidentifier.GeneratePaymentID("")
}

func (e *paymentIdentifierExtension) lastPaymentID() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.lastID
}

func cloneExtensions(in map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func main() {
	_ = godotenv.Load()

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

	evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
	if err != nil {
		fmt.Printf("Failed to create signer: %v\n", err)
		os.Exit(1)
	}

	identifier := &paymentIdentifierExtension{}
	client := x402.Newx402Client().
		Register("eip155:*", exactevm.NewExactEvmScheme(evmSigner, nil)).
		Register("eip155:*", uptoevm.NewUptoEvmScheme(evmSigner, nil)).
		RegisterExtension(identifier)

	// WrapHTTPClientWithPayment uses this client's Transport when one is set.
	httpClient := x402http.WrapHTTPClientWithPayment(
		&http.Client{},
		x402http.Newx402HTTPClient(client),
	)

	fmt.Println("One logical purchase")
	fmt.Printf("Making request to: %s\n", serverURL)
	fmt.Println("The SDK creates a fresh payment credential for this request.")
	fmt.Println("A new payment identifier is added only if the server advertises the extension.")
	fmt.Println("The SDK sends one unpaid probe and one payment retry. It does not cache that credential.")

	start := time.Now()
	respBody, httpResp, err := makeRequest(ctx, httpClient, serverURL)
	duration := time.Since(start)
	if err != nil {
		fmt.Printf("Request failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Response (%v): %s\n", duration, respBody)
	if id := identifier.lastPaymentID(); id != "" {
		fmt.Printf("Payment ID: %s\n", id)
	} else {
		fmt.Println("Payment ID: none (server did not advertise payment-identifier)")
	}
	printPaymentDetails(httpResp)
}

func makeRequest(ctx context.Context, client *http.Client, url string) (string, *http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(`{"item": "widget"}`))
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
	fmt.Println("Payment details:")
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
