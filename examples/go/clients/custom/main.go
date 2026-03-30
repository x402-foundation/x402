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
	"github.com/coinbase/x402/go/types"
	evm "github.com/coinbase/x402/go/mechanisms/evm/exact/client"
	evmsigners "github.com/coinbase/x402/go/signers/evm"
	"github.com/joho/godotenv"
)

/**
 * Custom Client Implementation - Direct x402 Integration
 *
 * This example demonstrates how to implement x402 payment handling manually
 * WITHOUT using the pre-built HTTP client wrapper. It shows the implementation
 * details of how to handle 402 responses and create payments directly.
 *
 * This is useful when you:
 * - Want to understand how x402 works under the hood
 * - Need to integrate with a custom HTTP client or framework
 * - Want full control over the payment flow
 * - Are building a custom transport layer
 *
 * The flow:
 * 1. Make initial HTTP request
 * 2. Detect 402 Payment Required response
 * 3. Extract payment requirements from response
 * 4. Create payment using x402 core package
 * 5. Retry request with payment header
 * 6. Handle successful response
 */

func main() {
	// Load .env file if it exists
	if err := godotenv.Load(); err != nil {
		fmt.Println("No .env file found, using environment variables")
	}

	// Get configuration
	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		fmt.Println("❌ EVM_PRIVATE_KEY environment variable is required")
		os.Exit(1)
	}

	url := os.Getenv("SERVER_URL")
	if url == "" {
		url = "http://localhost:4021/weather"
	}

	// Create context
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Create x402 client (core package)
	evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
	if err != nil {
		fmt.Printf("❌ Failed to create signer: %v\n", err)
		os.Exit(1)
	}

	x402Client := x402.Newx402Client().
		Register("eip155:*", evm.NewExactEvmScheme(evmSigner, nil))

	// Make the request with custom payment handling
	fmt.Println("🔧 Using custom payment implementation (no wrapper)\n")

	resp, err := makeRequestWithPayment(ctx, x402Client, url)
	if resp != nil {
		defer resp.Body.Close()
	}
	if err != nil {
		fmt.Printf("❌ Request failed: %v\n", err)
		if resp != nil {
			displayPaymentDetails(resp)
		}
		os.Exit(1)
	}

	// Read and display response
	var responseData interface{}
	if err := json.NewDecoder(resp.Body).Decode(&responseData); err != nil {
		fmt.Printf("❌ Failed to decode response: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("\n✅ Response body:")
	prettyJSON, _ := json.MarshalIndent(responseData, "  ", "  ")
	fmt.Printf("  %s\n", string(prettyJSON))

	displayPaymentDetails(resp)
}

// displayPaymentDetails extracts and prints payment settlement from response headers.
// Payment-response header is sent on both success and error.
func displayPaymentDetails(resp *http.Response) {
	paymentHeader := resp.Header.Get("PAYMENT-RESPONSE")
	if paymentHeader == "" {
		paymentHeader = resp.Header.Get("X-PAYMENT-RESPONSE")
	}
	if paymentHeader == "" {
		return
	}
	settleResp, err := extractSettlementResponse(paymentHeader)
	if err != nil {
		return
	}
	fmt.Println("\n💰 Payment Settlement Details:")
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

// makeRequestWithPayment implements the complete payment flow manually
func makeRequestWithPayment(ctx context.Context, x402Client *x402.X402Client, url string) (*http.Response, error) {
	// ========================================================================
	// Step 1: Make initial request
	// ========================================================================
	fmt.Println("📤 Step 1: Making initial request...")
	fmt.Printf("   URL: %s\n\n", url)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}

	// ========================================================================
	// Step 2: Check if payment is required
	// ========================================================================
	if resp.StatusCode != http.StatusPaymentRequired {
		fmt.Printf("✅ Step 2: No payment required (status: %d)\n", resp.StatusCode)
		return resp, nil
	}

	fmt.Println("💳 Step 2: Payment required (402 response)")
	defer resp.Body.Close()

	// ========================================================================
	// Step 3: Extract payment requirements
	// ========================================================================
	fmt.Println("🔍 Step 3: Extracting payment requirements...")

	// Read response headers and body
	headers := extractHeaders(resp.Header)
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Detect which protocol version (v1 or v2)
	version, err := detectVersion(headers, body)
	if err != nil {
		return nil, fmt.Errorf("failed to detect payment version: %w", err)
	}

	fmt.Printf("   Detected protocol version: v%d\n", version)

	// Extract payment requirements based on version
	var paymentRequirements types.PaymentRequirements
	var resource *types.ResourceInfo
	var extensions map[string]interface{}

	if version == 2 {
		paymentRequirements, resource, extensions, err = extractV2Requirements(headers, body)
	} else {
		paymentRequirements, err = extractV1Requirements(body)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to extract payment requirements: %w", err)
	}

	fmt.Printf("   Network: %s\n", paymentRequirements.Network)
	fmt.Printf("   Scheme: %s\n", paymentRequirements.Scheme)
	fmt.Printf("   Amount: %+v\n\n", paymentRequirements.Amount)

	// ========================================================================
	// Step 4: Create payment payload
	// ========================================================================
	fmt.Println("💰 Step 4: Creating payment payload...")

	var payloadBytes []byte
	if version == 2 {
		// V2 payment creation
		payload, err := x402Client.CreatePaymentPayload(ctx, paymentRequirements, resource, extensions)
		if err != nil {
			return nil, fmt.Errorf("failed to create V2 payment: %w", err)
		}
		payloadBytes, err = json.Marshal(payload)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal V2 payload: %w", err)
		}
	} else {
		// V1 payment creation
		requirementsV1 := types.PaymentRequirementsV1{
			Scheme:            paymentRequirements.Scheme,
			Network:           paymentRequirements.Network,
			PayTo:             paymentRequirements.PayTo,
			MaxAmountRequired: paymentRequirements.Amount,
			Asset:             paymentRequirements.Asset,
			MaxTimeoutSeconds: paymentRequirements.MaxTimeoutSeconds,
		}
		payload, err := x402Client.CreatePaymentPayloadV1(ctx, requirementsV1)
		if err != nil {
			return nil, fmt.Errorf("failed to create V1 payment: %w", err)
		}
		payloadBytes, err = json.Marshal(payload)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal V1 payload: %w", err)
		}
	}

	fmt.Printf("   Created payload: %d bytes\n\n", len(payloadBytes))

	// ========================================================================
	// Step 5: Retry request with payment
	// ========================================================================
	fmt.Println("🔄 Step 5: Retrying request with payment...")

	// Encode payment as base64 and add to header
	encodedPayment := base64.StdEncoding.EncodeToString(payloadBytes)
	
	// Create new request with payment header
	retryReq, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create retry request: %w", err)
	}

	// Add payment header (v2 uses PAYMENT-SIGNATURE, v1 uses X-PAYMENT)
	if version == 2 {
		retryReq.Header.Set("PAYMENT-SIGNATURE", encodedPayment)
		fmt.Println("   Added PAYMENT-SIGNATURE header")
	} else {
		retryReq.Header.Set("X-PAYMENT", encodedPayment)
		fmt.Println("   Added X-PAYMENT header")
	}

	// Make the retry request
	retryResp, err := client.Do(retryReq)
	if err != nil {
		return nil, fmt.Errorf("retry request failed: %w", err)
	}

	fmt.Printf("   Response status: %d\n", retryResp.StatusCode)

	// ========================================================================
	// Step 6: Verify success
	// ========================================================================
	if retryResp.StatusCode >= 400 {
		errorBody, _ := io.ReadAll(retryResp.Body)
		return retryResp, fmt.Errorf("payment failed: status %d, body: %s", retryResp.StatusCode, string(errorBody))
	}

	fmt.Println("✅ Step 6: Payment successful!\n")

	return retryResp, nil
}

// ============================================================================
// Helper Functions for Manual Implementation
// ============================================================================

// extractHeaders converts http.Header to map[string]string
func extractHeaders(h http.Header) map[string]string {
	headers := make(map[string]string)
	for k, v := range h {
		if len(v) > 0 {
			headers[k] = v[0]
		}
	}
	return headers
}

// detectVersion detects whether the server is using v1 or v2 protocol
func detectVersion(headers map[string]string, body []byte) (int, error) {
	// Normalize headers to uppercase for comparison
	normalizedHeaders := make(map[string]string)
	for k, v := range headers {
		normalizedHeaders[strings.ToUpper(k)] = v
	}

	// V2 uses PAYMENT-REQUIRED header
	if _, exists := normalizedHeaders["PAYMENT-REQUIRED"]; exists {
		return 2, nil
	}

	// V1 uses body with x402Version field
	if len(body) > 0 {
		var versionCheck struct {
			X402Version int `json:"x402Version"`
		}
		if err := json.Unmarshal(body, &versionCheck); err == nil {
			if versionCheck.X402Version == 1 {
				return 1, nil
			}
		}
	}

	return 0, fmt.Errorf("could not detect x402 version from response")
}

// extractV2Requirements extracts payment requirements from V2 response
func extractV2Requirements(headers map[string]string, body []byte) (types.PaymentRequirements, *types.ResourceInfo, map[string]interface{}, error) {
	// Normalize headers
	normalizedHeaders := make(map[string]string)
	for k, v := range headers {
		normalizedHeaders[strings.ToUpper(k)] = v
	}

	// Get PAYMENT-REQUIRED header
	headerValue, exists := normalizedHeaders["PAYMENT-REQUIRED"]
	if !exists {
		return types.PaymentRequirements{}, nil, nil, fmt.Errorf("PAYMENT-REQUIRED header not found")
	}

	// Decode base64 header
	decoded, err := base64.StdEncoding.DecodeString(headerValue)
	if err != nil {
		return types.PaymentRequirements{}, nil, nil, fmt.Errorf("invalid base64 encoding: %w", err)
	}

	// Parse payment required structure
	var paymentRequired types.PaymentRequired
	if err := json.Unmarshal(decoded, &paymentRequired); err != nil {
		return types.PaymentRequirements{}, nil, nil, fmt.Errorf("invalid payment required JSON: %w", err)
	}

	// Select first acceptable payment requirement
	// In a real implementation, you might want to choose based on preference
	if len(paymentRequired.Accepts) == 0 {
		return types.PaymentRequirements{}, nil, nil, fmt.Errorf("no payment requirements offered")
	}

	selectedRequirement := paymentRequired.Accepts[0]

	return selectedRequirement, paymentRequired.Resource, paymentRequired.Extensions, nil
}

// extractV1Requirements extracts payment requirements from V1 response body
func extractV1Requirements(body []byte) (types.PaymentRequirements, error) {
	var paymentRequiredV1 types.PaymentRequiredV1
	if err := json.Unmarshal(body, &paymentRequiredV1); err != nil {
		return types.PaymentRequirements{}, fmt.Errorf("invalid V1 payment required JSON: %w", err)
	}

	// Select first acceptable payment requirement
	if len(paymentRequiredV1.Accepts) == 0 {
		return types.PaymentRequirements{}, fmt.Errorf("no payment requirements offered")
	}

	selected := paymentRequiredV1.Accepts[0]

	// Convert V1 requirements to common format
	return types.PaymentRequirements{
		Scheme:            selected.Scheme,
		Network:           selected.Network,
		PayTo:             selected.PayTo,
		Amount:            selected.MaxAmountRequired,
		Asset:             selected.Asset,
		MaxTimeoutSeconds: selected.MaxTimeoutSeconds,
	}, nil
}

// extractSettlementResponse extracts settlement details from response header
func extractSettlementResponse(headerValue string) (x402.SettleResponse, error) {
	// Decode base64 header
	decoded, err := base64.StdEncoding.DecodeString(headerValue)
	if err != nil {
		return x402.SettleResponse{}, fmt.Errorf("invalid base64 encoding: %w", err)
	}

	// Parse settlement response
	var settleResp x402.SettleResponse
	if err := json.Unmarshal(decoded, &settleResp); err != nil {
		return x402.SettleResponse{}, fmt.Errorf("invalid settlement response JSON: %w", err)
	}

	return settleResp, nil
}

