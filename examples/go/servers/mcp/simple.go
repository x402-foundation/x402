package main

// MCP Server with x402 Paid Tools - Simple Example
//
// This example demonstrates creating an MCP server with payment-wrapped tools
// using the MCP SDK (github.com/modelcontextprotocol/go-sdk/mcp).
// Uses NewPaymentWrapper to add x402 payment to individual tools.
//
// The getWeatherData helper is defined in helpers.go and shared across examples.
//
// Run with: go run . simple

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"github.com/joho/godotenv"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	"github.com/x402-foundation/x402/go/mcp"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/server"
)

func runSimple() error {
	fmt.Println("\n📦 Using Payment Wrapper API with REAL MCP SDK\n")

	// Load environment variables
	if err := godotenv.Load(); err != nil {
		fmt.Println("No .env file found, using environment variables")
	}

	evmAddress := os.Getenv("EVM_ADDRESS")
	if evmAddress == "" {
		return fmt.Errorf("EVM_ADDRESS environment variable is required")
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		return fmt.Errorf("FACILITATOR_URL environment variable is required")
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "4022"
	}

	// ========================================================================
	// STEP 1: Create REAL MCP server
	// ========================================================================
	mcpServer := mcpsdk.NewServer(&mcpsdk.Implementation{
		Name:    "x402 MCP Server",
		Version: "1.0.0",
	}, nil)

	// ========================================================================
	// STEP 2: Set up x402 resource server for payment handling
	// ========================================================================
	ctx := context.Background()
	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	resourceServer := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(facilitatorClient),
	)
	resourceServer.Register("eip155:84532", evm.NewExactEvmScheme())

	if err := resourceServer.Initialize(ctx); err != nil {
		return fmt.Errorf("failed to initialize resource server: %w", err)
	}

	// ========================================================================
	// STEP 3: Build payment requirements
	// ========================================================================
	config := x402.ResourceConfig{
		Scheme:  "exact",
		Network: "eip155:84532",
		PayTo:   evmAddress,
		Price:   "$0.001",
	}

	accepts, err := resourceServer.BuildPaymentRequirementsFromConfig(ctx, config)
	if err != nil {
		return fmt.Errorf("failed to build payment requirements: %w", err)
	}

	// ========================================================================
	// STEP 4: Create payment wrapper with accepts array
	// ========================================================================
	paymentWrapper := mcp.NewPaymentWrapper(resourceServer, mcp.PaymentWrapperConfig{
		Accepts: accepts,
		Resource: &mcp.ResourceInfo{
			URL:         "mcp://tool/get_weather",
			Description: "Get weather for a city",
			MimeType:    "application/json",
		},
	})

	// ========================================================================
	// STEP 5: Register tools using REAL MCP SDK with payment wrapper
	// ========================================================================

	// Free tool - register directly
	mcpServer.AddTool(&mcpsdk.Tool{
		Name:        "ping",
		Description: "A free health check tool",
		InputSchema: map[string]interface{}{"type": "object"},
	}, func(ctx context.Context, req *mcpsdk.CallToolRequest) (*mcpsdk.CallToolResult, error) {
		return &mcpsdk.CallToolResult{
			Content: []mcpsdk.Content{
				&mcpsdk.TextContent{Text: "pong"},
			},
		}, nil
	})

	// Paid tool - wrap handler with payment
	mcpServer.AddTool(&mcpsdk.Tool{
		Name:        "get_weather",
		Description: "Get current weather for a city. Requires payment of $0.001.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"city": map[string]interface{}{"type": "string", "description": "The city name"},
			},
		},
	}, paymentWrapper.Wrap(func(ctx context.Context, req *mcpsdk.CallToolRequest) (*mcpsdk.CallToolResult, error) {
		city := ""
		if req.Params.Arguments != nil {
			var args map[string]interface{}
			if err := json.Unmarshal(req.Params.Arguments, &args); err == nil {
				if c, ok := args["city"].(string); ok {
					city = c
				}
			}
		}
		if city == "" {
			city = "San Francisco"
		}

		weatherData := getWeatherData(city)
		weatherJSON, _ := json.MarshalIndent(weatherData, "", "  ")

		return &mcpsdk.CallToolResult{
			Content: []mcpsdk.Content{
				&mcpsdk.TextContent{Text: string(weatherJSON)},
			},
		}, nil
	}))

	// Start HTTP server with SSE transport
	return startHTTPServer(mcpServer, port)
}

func startHTTPServer(mcpServer *mcpsdk.Server, port string) error {
	sseHandler := mcpsdk.NewSSEHandler(func(req *http.Request) *mcpsdk.Server {
		return mcpServer
	}, nil)

	mux := http.NewServeMux()
	mux.Handle("/sse", sseHandler)
	mux.Handle("/messages", sseHandler)

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "ok",
			"server": "x402 MCP Server",
		})
	})

	fmt.Printf("🚀 x402 MCP Server running on http://localhost:%s\n", port)
	fmt.Println("\n📋 Available tools:")
	fmt.Println("   - get_weather (paid: $0.001)")
	fmt.Println("   - ping (free)")
	fmt.Printf("\n🔗 Connect via SSE: http://localhost:%s/sse\n", port)
	fmt.Println("\n💡 This example uses NewPaymentWrapper() with REAL MCP SDK.\n")

	server := &http.Server{
		Addr:    ":" + port,
		Handler: mux,
	}

	return server.ListenAndServe()
}
