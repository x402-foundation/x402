package main

// MCP Server with x402 Paid Tools - Existing Server Integration
//
// This example demonstrates adding x402 to an existing MCP server using NewPaymentWrapper.
// Use this approach when you have an EXISTING MCP server and want to add
// x402 payment to specific tools without adopting the full x402MCPServer abstraction.
//
// The getWeatherData helper is defined in helpers.go and shared across examples.
//
// Run with: go run . existing

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

func runExisting() error {
	fmt.Println("\n📦 Using NewPaymentWrapper with existing server\n")

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
	// STEP 1: Your existing MCP server (this might already exist in your code)
	// ========================================================================
	mcpServer := mcpsdk.NewServer(&mcpsdk.Implementation{
		Name:    "x402 MCP Server (Existing)",
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
	// STEP 3: Build payment requirements for different tools
	// ========================================================================
	weatherConfig := x402.ResourceConfig{
		Scheme:  "exact",
		Network: "eip155:84532",
		PayTo:   evmAddress,
		Price:   "$0.001",
	}

	weatherAccepts, err := resourceServer.BuildPaymentRequirementsFromConfig(ctx, weatherConfig)
	if err != nil {
		return fmt.Errorf("failed to build weather payment requirements: %w", err)
	}

	forecastConfig := x402.ResourceConfig{
		Scheme:  "exact",
		Network: "eip155:84532",
		PayTo:   evmAddress,
		Price:   "$0.005",
	}

	forecastAccepts, err := resourceServer.BuildPaymentRequirementsFromConfig(ctx, forecastConfig)
	if err != nil {
		return fmt.Errorf("failed to build forecast payment requirements: %w", err)
	}

	// ========================================================================
	// STEP 4: Create payment wrappers with accepts arrays
	// ========================================================================
	paymentWrapperWeather := mcp.NewPaymentWrapper(resourceServer, mcp.PaymentWrapperConfig{
		Accepts: weatherAccepts,
		Resource: &mcp.ResourceInfo{
			URL:         "mcp://tool/get_weather",
			Description: "Get weather for a city",
			MimeType:    "application/json",
		},
	})

	paymentWrapperForecast := mcp.NewPaymentWrapper(resourceServer, mcp.PaymentWrapperConfig{
		Accepts: forecastAccepts,
		Resource: &mcp.ResourceInfo{
			URL:         "mcp://tool/get_forecast",
			Description: "Get 7-day forecast",
			MimeType:    "application/json",
		},
	})

	// ========================================================================
	// STEP 5: Register tools using REAL MCP SDK NATIVE tool registration API
	// ========================================================================

	// Free tool - works exactly as before, no changes needed
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

	// Paid tools - wrap the handler with payment wrapper
	mcpServer.AddTool(&mcpsdk.Tool{
		Name:        "get_weather",
		Description: "Get current weather for a city. Requires payment of $0.001.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"city": map[string]interface{}{"type": "string", "description": "The city name"},
			},
		},
	}, paymentWrapperWeather.Wrap(func(ctx context.Context, req *mcpsdk.CallToolRequest) (*mcpsdk.CallToolResult, error) {
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
			Content: []mcpsdk.Content{&mcpsdk.TextContent{Text: string(weatherJSON)}},
		}, nil
	}))

	mcpServer.AddTool(&mcpsdk.Tool{
		Name:        "get_forecast",
		Description: "Get 7-day weather forecast. Requires payment of $0.005.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"city": map[string]interface{}{"type": "string", "description": "The city name"},
			},
		},
	}, paymentWrapperForecast.Wrap(func(ctx context.Context, req *mcpsdk.CallToolRequest) (*mcpsdk.CallToolResult, error) {
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
		forecast := make([]map[string]interface{}, 7)
		for i := 0; i < 7; i++ {
			dayData := getWeatherData(city)
			dayData["day"] = i + 1
			forecast[i] = dayData
		}
		forecastJSON, _ := json.MarshalIndent(forecast, "", "  ")
		return &mcpsdk.CallToolResult{
			Content: []mcpsdk.Content{&mcpsdk.TextContent{Text: string(forecastJSON)}},
		}, nil
	}))

	// Start HTTP server with SSE transport
	return startHTTPServerExisting(mcpServer, port)
}

func startHTTPServerExisting(mcpServer *mcpsdk.Server, port string) error {
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
			"mode":   "existing-server",
			"server": "x402 MCP Server (Existing)",
		})
	})

	fmt.Printf("🚀 Existing MCP Server with x402 running on http://localhost:%s\n", port)
	fmt.Println("\n📋 Available tools:")
	fmt.Println("   - get_weather (paid: $0.001)")
	fmt.Println("   - get_forecast (paid: $0.005)")
	fmt.Println("   - ping (free)")
	fmt.Printf("\n🔗 Connect via SSE: http://localhost:%s/sse\n", port)
	fmt.Println("\n💡 This example shows how to add x402 to an EXISTING MCP server")
	fmt.Println("   using NewPaymentWrapper() with REAL MCP SDK.\n")

	server := &http.Server{
		Addr:    ":" + port,
		Handler: mux,
	}

	return server.ListenAndServe()
}
