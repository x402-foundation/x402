//go:build mcp

// Package integration_test contains integration tests for MCP transport with real EVM transactions.
// These tests verify the complete MCP payment flow using:
// - Real MCP SDK transport (github.com/modelcontextprotocol/go-sdk/mcp)
// - Real EVM blockchain transactions on Base Sepolia (NO mocks for x402 protocol)
// - Real x402 payment processing (NO mocks for payment verification or settlement)
//
// To run these tests, ensure the MCP SDK is installed:
//
//	go get github.com/modelcontextprotocol/go-sdk/mcp
//	go mod tidy
//
// Then run tests with the mcp build tag:
//
//	go test -tags=mcp ./test/integration
//
// Required environment variables:
// - EVM_CLIENT_PRIVATE_KEY: Private key for the client wallet (payer)
// - EVM_FACILITATOR_PRIVATE_KEY: Private key for the facilitator wallet (settles payments)
//
// These tests make REAL blockchain transactions on Base Sepolia testnet.
// All x402 payment operations (verification, settlement) use real blockchain calls.
package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/mcp"
	evmclient "github.com/coinbase/x402/go/mechanisms/evm/exact/client"
	evmfacilitator "github.com/coinbase/x402/go/mechanisms/evm/exact/facilitator"
	evmserver "github.com/coinbase/x402/go/mechanisms/evm/exact/server"
	evmsigners "github.com/coinbase/x402/go/signers/evm"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	TEST_NETWORK = "eip155:84532"                               // Base Sepolia
	TEST_ASSET   = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" // USDC on Base Sepolia
	TEST_PRICE   = "1000"                                       // 0.001 USDC
	TEST_PORT    = 4099
)

// TestMCPEVMIntegration tests the full MCP payment flow with real EVM transactions
func TestMCPEVMIntegration(t *testing.T) {
	// Skip if environment variables not set
	clientPrivateKey := os.Getenv("EVM_CLIENT_PRIVATE_KEY")
	facilitatorPrivateKey := os.Getenv("EVM_FACILITATOR_PRIVATE_KEY")

	if clientPrivateKey == "" || facilitatorPrivateKey == "" {
		t.Skip("Skipping MCP EVM integration test: EVM_CLIENT_PRIVATE_KEY and EVM_FACILITATOR_PRIVATE_KEY must be set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	t.Run("MCP Payment Flow - Real EVM Transactions with Real MCP SDK", func(t *testing.T) {
		// Wait for any pending transactions from previous tests (shared facilitator wallet)
		waitForPendingTransactions(t, ctx, facilitatorPrivateKey, "https://sepolia.base.org")

		// ========================================================================
		// Setup Client (Payer)
		// ========================================================================
		clientSigner, err := evmsigners.NewClientSignerFromPrivateKey(clientPrivateKey)
		if err != nil {
			t.Fatalf("Failed to create client signer: %v", err)
		}

		paymentClient := x402.Newx402Client()
		evmClientScheme := evmclient.NewExactEvmScheme(clientSigner, nil)
		paymentClient.Register(TEST_NETWORK, evmClientScheme)

		// Get client address
		clientAddr := ""
		if addrGetter, ok := clientSigner.(interface{ Address() string }); ok {
			clientAddr = addrGetter.Address()
			t.Logf("\n🔑 Client address: %s", clientAddr)
		}

		// ========================================================================
		// Setup Facilitator (Settles Payments)
		// ========================================================================
		facilitatorSigner, err := newRealFacilitatorEvmSigner(facilitatorPrivateKey, "https://sepolia.base.org")
		if err != nil {
			t.Fatalf("Failed to create facilitator signer: %v", err)
		}

		facilitator := x402.Newx402Facilitator()
		evmConfig := &evmfacilitator.ExactEvmSchemeConfig{
			DeployERC4337WithEIP6492: true,
		}
		evmFacilitator := evmfacilitator.NewExactEvmScheme(facilitatorSigner, evmConfig)
		facilitator.Register([]x402.Network{TEST_NETWORK}, evmFacilitator)

		facilitatorClient := &localEvmFacilitatorClient{facilitator: facilitator}

		// ========================================================================
		// Setup Resource Server
		// ========================================================================
		resourceServer := x402.Newx402ResourceServer(
			x402.WithFacilitatorClient(facilitatorClient),
		)
		evmServerScheme := evmserver.NewExactEvmScheme()
		resourceServer.Register(TEST_NETWORK, evmServerScheme)

		err = resourceServer.Initialize(ctx)
		if err != nil {
			t.Fatalf("Failed to initialize resource server: %v", err)
		}

		// Build payment requirements
		config := x402.ResourceConfig{
			Scheme:  "exact",
			Network: TEST_NETWORK,
			PayTo:   facilitatorSigner.GetAddresses()[0],
			Price:   "$0.001",
		}

		accepts, err := resourceServer.BuildPaymentRequirementsFromConfig(ctx, config)
		if err != nil {
			t.Fatalf("Failed to build payment requirements: %v", err)
		}

		// Ensure all required fields are set
		if len(accepts) == 0 {
			t.Fatal("No payment requirements returned")
		}
		if accepts[0].Asset == "" {
			accepts[0].Asset = TEST_ASSET
		}
		if accepts[0].PayTo == "" {
			accepts[0].PayTo = facilitatorSigner.GetAddresses()[0]
		}
		if accepts[0].MaxTimeoutSeconds == 0 {
			accepts[0].MaxTimeoutSeconds = 300
		}

		// ========================================================================
		// Setup REAL MCP Server with x402
		// ========================================================================
		mcpServer := mcpsdk.NewServer(&mcpsdk.Implementation{
			Name:    "x402 Test Server",
			Version: "1.0.0",
		}, nil)

		// Create payment wrapper
		paymentWrapper := mcp.NewPaymentWrapper(resourceServer, mcp.PaymentWrapperConfig{
			Accepts: accepts,
			Resource: &mcp.ResourceInfo{
				URL:         "mcp://tool/get_weather",
				Description: "Get weather for a city",
				MimeType:    "application/json",
			},
		})

		// Register free tool
		mcpServer.AddTool(&mcpsdk.Tool{
			Name:        "ping",
			Description: "A free health check tool",
			InputSchema: json.RawMessage(`{"type": "object"}`),
		}, func(ctx context.Context, req *mcpsdk.CallToolRequest) (*mcpsdk.CallToolResult, error) {
			return &mcpsdk.CallToolResult{
				Content: []mcpsdk.Content{&mcpsdk.TextContent{Text: "pong"}},
			}, nil
		})

		// Register paid tool
		mcpServer.AddTool(&mcpsdk.Tool{
			Name:        "get_weather",
			Description: "Get current weather for a city. Requires payment of $0.001.",
			InputSchema: json.RawMessage(`{"type": "object", "properties": {"city": {"type": "string"}}}`),
		}, paymentWrapper.Wrap(func(ctx context.Context, req *mcpsdk.CallToolRequest) (*mcpsdk.CallToolResult, error) {
			return &mcpsdk.CallToolResult{
				Content: []mcpsdk.Content{&mcpsdk.TextContent{Text: "pong"}},
			}, nil
		}))

		// ========================================================================
		// Start HTTP Server for SSE Transport
		// ========================================================================
		// Use SSEHandler to manage SSE connections
		sseHandler := mcpsdk.NewSSEHandler(func(req *http.Request) *mcpsdk.Server {
			return mcpServer
		}, &mcpsdk.SSEOptions{})

		// Create HTTP mux
		mux := http.NewServeMux()
		mux.Handle("/sse", sseHandler)
		mux.Handle("/messages", sseHandler)

		// Start HTTP server
		httpServer := &http.Server{
			Addr:    fmt.Sprintf(":%d", TEST_PORT),
			Handler: mux,
		}

		go func() {
			if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				t.Logf("HTTP server error: %v", err)
			}
		}()

		// Wait for server to start
		time.Sleep(100 * time.Millisecond)
		t.Logf("\n🚀 Test MCP Server running on http://localhost:%d\n", TEST_PORT)

		// Cleanup
		defer func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			httpServer.Shutdown(ctx)
		}()

		// ========================================================================
		// Setup REAL MCP Client with SSE Transport
		// ========================================================================
		sseClientTransport := &mcpsdk.SSEClientTransport{
			Endpoint: fmt.Sprintf("http://localhost:%d/sse", TEST_PORT),
		}

		mcpClient := mcpsdk.NewClient(&mcpsdk.Implementation{
			Name:    "x402-test-client",
			Version: "1.0.0",
		}, nil)

		clientSession, err := mcpClient.Connect(ctx, sseClientTransport, nil)
		if err != nil {
			t.Fatalf("Failed to connect MCP client: %v", err)
		}
		defer clientSession.Close()

		// Wrap session with x402 payment handling
		x402McpClient := mcp.NewX402MCPClient(clientSession, paymentClient, mcp.Options{
			AutoPayment: mcp.BoolPtr(true),
			OnPaymentRequested: func(context mcp.PaymentRequiredContext) (bool, error) {
				t.Logf("💰 Payment requested: %s atomic units", context.PaymentRequired.Accepts[0].Amount)
				return true, nil // Auto-approve for tests
			},
		})

		// ========================================================================
		// Test 1: Free tool works without payment
		// ========================================================================
		t.Run("Free tool works without payment", func(t *testing.T) {
			result, err := x402McpClient.CallTool(ctx, "ping", map[string]interface{}{})
			if err != nil {
				t.Fatalf("Unexpected error: %v", err)
			}

			if result.PaymentMade {
				t.Error("Expected PaymentMade to be false for free tool")
			}
			if result.IsError {
				t.Error("Expected IsError to be false")
			}
			if len(result.Content) == 0 {
				t.Fatal("Expected content")
			}
			if result.Content[0].Text != "pong" {
				t.Errorf("Expected 'pong', got '%s'", result.Content[0].Text)
			}

			t.Logf("✅ Free tool result: %s", result.Content[0].Text)
		})

		// ========================================================================
		// Test 2: Paid tool returns 402 without payment (manual test)
		// ========================================================================
		t.Run("Paid tool returns 402 without payment", func(t *testing.T) {
			manualClient := mcp.NewX402MCPClient(clientSession, paymentClient, mcp.Options{
				AutoPayment: mcp.BoolPtr(false),
			})

			_, err := manualClient.CallTool(ctx, "get_weather", map[string]interface{}{"city": "San Francisco"})
			if err == nil {
				t.Fatal("Expected 402 error")
			}

			paymentErr, ok := err.(*mcp.PaymentRequiredError)
			if !ok {
				t.Fatalf("Expected PaymentRequiredError, got %T: %v", err, err)
			}

			if paymentErr.Code != mcp.MCP_PAYMENT_REQUIRED_CODE {
				t.Errorf("Expected code %d, got %d", mcp.MCP_PAYMENT_REQUIRED_CODE, paymentErr.Code)
			}
			if paymentErr.PaymentRequired == nil {
				t.Fatal("Expected PaymentRequired to be set")
			}

			t.Logf("💳 402 Payment Required received as expected")
		})

		// ========================================================================
		// Test 3: Paid tool with payment succeeds (REAL BLOCKCHAIN TRANSACTION)
		// ========================================================================
		t.Run("Paid tool with auto-payment and real blockchain settlement", func(t *testing.T) {
			t.Log("\n🔄 Starting paid tool call with real blockchain settlement...\n")

			result, err := x402McpClient.CallTool(ctx, "get_weather", map[string]interface{}{"city": "New York"})
			if err != nil {
				t.Fatalf("Unexpected error: %v", err)
			}

			// Verify payment was made
			if !result.PaymentMade {
				t.Error("Expected PaymentMade to be true")
			}
			if result.IsError {
				t.Errorf("Expected IsError to be false, content: %+v", result.Content)
			}

			// Verify we got the tool result
			if len(result.Content) == 0 {
				t.Fatal("Expected content")
			}

			// Verify payment response (settlement result)
			if result.PaymentResponse == nil {
				t.Fatalf("Expected PaymentResponse to be set, content: %+v", result.Content)
			}
			if !result.PaymentResponse.Success {
				t.Error("Expected settlement to succeed")
			}
			if result.PaymentResponse.Transaction == "" {
				t.Error("Expected transaction hash to be set")
			}
			if result.PaymentResponse.Network != TEST_NETWORK {
				t.Errorf("Expected network %s, got %s", TEST_NETWORK, result.PaymentResponse.Network)
			}

			t.Logf("\n✅ Settlement successful!")
			t.Logf("   Transaction: %s", result.PaymentResponse.Transaction)
			t.Logf("   Network: %s", result.PaymentResponse.Network)
			t.Logf("   View on BaseScan: https://sepolia.basescan.org/tx/%s\n", result.PaymentResponse.Transaction)
		})

		// ========================================================================
		// Test 4: Multiple paid tool calls work
		// ========================================================================
		t.Run("Multiple paid tool calls work", func(t *testing.T) {
			// Wait for the previous test's settlement tx to be mined
			waitForPendingTransactions(t, ctx, facilitatorPrivateKey, "https://sepolia.base.org")
			t.Log("\n🔄 Starting second paid tool call...\n")

			result, err := x402McpClient.CallTool(ctx, "get_weather", map[string]interface{}{"city": "Los Angeles"})
			if err != nil {
				t.Fatalf("Unexpected error: %v", err)
			}

			if !result.PaymentMade {
				t.Error("Expected PaymentMade to be true")
			}
			if result.IsError {
				t.Errorf("Expected IsError to be false, content: %+v", result.Content)
			}
			if result.PaymentResponse == nil {
				t.Fatalf("Expected PaymentResponse to be set, content: %+v", result.Content)
			}
			if !result.PaymentResponse.Success {
				t.Error("Expected successful settlement")
			}
			if result.PaymentResponse.Transaction == "" {
				t.Error("Expected transaction hash to be set")
			}

			t.Logf("✅ Second settlement successful!")
			t.Logf("   Transaction: %s\n", result.PaymentResponse.Transaction)
		})

		// ========================================================================
		// Test 5: List tools works
		// ========================================================================
		t.Run("List tools works", func(t *testing.T) {
			session, ok := x402McpClient.Client().(*mcpsdk.ClientSession)
			if !ok {
				t.Fatal("Expected underlying client to be *mcp.ClientSession")
			}
			tools, err := session.ListTools(ctx, nil)
			if err != nil {
				t.Fatalf("Unexpected error: %v", err)
			}

			if tools == nil {
				t.Fatal("Expected tools list")
			}

			t.Logf("📋 Available tools listed successfully")
		})
	})
}
