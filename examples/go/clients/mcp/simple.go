package main

import (
	"context"
	"fmt"
	"os"

	x402 "github.com/coinbase/x402/go"
	evm "github.com/coinbase/x402/go/mechanisms/evm/exact/client"
	evmsigners "github.com/coinbase/x402/go/signers/evm"
	"github.com/coinbase/x402/go/mcp"
	"github.com/joho/godotenv"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// MCP Client with x402 Payment Support - Simple Example
//
// This example demonstrates the RECOMMENDED way to create an MCP client
// using NewX402MCPClient with an explicitly created x402 payment client.
//
// Run with: go run . simple

// runSimple demonstrates the simple API using NewX402MCPClient with x402Client.
func runSimple() error {
	fmt.Println("\n📦 Using SIMPLE API (CreateX402MCPClient factory) with REAL MCP SDK\n")

	// Load environment variables
	if err := godotenv.Load(); err != nil {
		fmt.Println("No .env file found, using environment variables")
	}

	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		return fmt.Errorf("EVM_PRIVATE_KEY environment variable is required")
	}

	serverURL := os.Getenv("MCP_SERVER_URL")
	if serverURL == "" {
		serverURL = "http://localhost:4022"
	}

	fmt.Printf("🔌 Connecting to MCP server at: %s\n", serverURL)

	// Create EVM signer
	evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
	if err != nil {
		return fmt.Errorf("failed to create EVM signer: %w", err)
	}

	fmt.Printf("💳 Using wallet: %s\n", evmSigner.Address())

	// ========================================================================
	// Connect to REAL MCP server using SSE transport
	// ========================================================================
	ctx := context.Background()

	sseClientTransport := &mcpsdk.SSEClientTransport{
		Endpoint: serverURL + "/sse",
	}

	mcpClient := mcpsdk.NewClient(&mcpsdk.Implementation{
		Name:    "x402-mcp-client",
		Version: "1.0.0",
	}, nil)

	clientSession, err := mcpClient.Connect(ctx, sseClientTransport, nil)
	if err != nil {
		return fmt.Errorf("failed to connect to MCP server: %w", err)
	}
	defer clientSession.Close()

	fmt.Println("✅ Connected to MCP server\n")

	// Create x402 payment client and wrap session
	paymentClient := x402.Newx402Client()
	paymentClient.Register("eip155:84532", evm.NewExactEvmScheme(evmSigner, nil))
	x402Mcp := mcp.NewX402MCPClient(clientSession, paymentClient, mcp.Options{
		AutoPayment: mcp.BoolPtr(true),
		OnPaymentRequested: func(context mcp.PaymentRequiredContext) (bool, error) {
			price := context.PaymentRequired.Accepts[0]
			fmt.Printf("\n💰 Payment required for tool: %s\n", context.ToolName)
			fmt.Printf("   Amount: %s (%s)\n", price.Amount, price.Asset)
			fmt.Printf("   Network: %s\n", price.Network)
			fmt.Println("   Approving payment...\n")
			return true, nil
		},
	})

	// List tools
	fmt.Println("📋 Discovering available tools...")
	toolsResult, err := clientSession.ListTools(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to list tools: %w", err)
	}

	fmt.Println("Available tools:")
	for _, tool := range toolsResult.Tools {
		fmt.Printf("   - %s: %s\n", tool.Name, tool.Description)
	}
	fmt.Println()

	// Test free tool
	fmt.Println("━" + string(make([]byte, 50)) + "━")
	fmt.Println("🆓 Test 1: Calling free tool (ping)")
	fmt.Println("━" + string(make([]byte, 50)) + "━")

	pingResult, err := x402Mcp.CallTool(ctx, "ping", map[string]interface{}{})
	if err != nil {
		return fmt.Errorf("failed to call ping: %w", err)
	}

	if len(pingResult.Content) > 0 {
		fmt.Printf("Response: %s\n", pingResult.Content[0].Text)
	}
	fmt.Printf("Payment made: %v\n\n", pingResult.PaymentMade)

	// Test paid tool
	fmt.Println("━" + string(make([]byte, 50)) + "━")
	fmt.Println("💰 Test 2: Calling paid tool (get_weather)")
	fmt.Println("━" + string(make([]byte, 50)) + "━")

	weatherResult, err := x402Mcp.CallTool(ctx, "get_weather", map[string]interface{}{
		"city": "San Francisco",
	})
	if err != nil {
		return fmt.Errorf("failed to call get_weather: %w", err)
	}

	if len(weatherResult.Content) > 0 {
		fmt.Printf("Response: %s\n", weatherResult.Content[0].Text)
	}
	fmt.Printf("Payment made: %v\n", weatherResult.PaymentMade)

	if weatherResult.PaymentResponse != nil {
		fmt.Println("\n📦 Payment Receipt:")
		fmt.Printf("   Success: %v\n", weatherResult.PaymentResponse.Success)
		if weatherResult.PaymentResponse.Transaction != "" {
			fmt.Printf("   Transaction: %s\n", weatherResult.PaymentResponse.Transaction)
		}
	}

	fmt.Println("\n✅ Demo complete!")
	return nil
}
