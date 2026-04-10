package main

// MCP Server with x402 Paid Tools - Advanced Example with Hooks
//
// This example demonstrates using NewPaymentWrapper with hooks for:
// - Logging and observability
// - Rate limiting and access control
// - Custom settlement handling
// - Production monitoring
//
// The getWeatherData helper is defined in helpers.go and shared across examples.
//
// Run with: go run . advanced

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

func runAdvanced() error {
	fmt.Println("\n📦 Using Payment Wrapper with Hooks\n")

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
		Name:    "x402 MCP Server (Advanced)",
		Version: "1.0.0",
	}, nil)

	// ========================================================================
	// STEP 2: Set up x402 resource server
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
	// STEP 4: Create payment wrappers with hooks for production features
	// ========================================================================

	// Shared hooks for all paid tools
	beforeHook := mcp.BeforeExecutionHook(func(context mcp.ServerHookContext) (bool, error) {
		fmt.Printf("\n🔧 [Hook] Before execution: %s\n", context.ToolName)
		if context.PaymentPayload.Payload != nil {
			if auth, ok := context.PaymentPayload.Payload["authorization"].(map[string]interface{}); ok {
				if from, ok := auth["from"].(string); ok {
					fmt.Printf("   Payment from: %s\n", from)
				}
			}
		}
		fmt.Printf("   Amount: %s\n", context.PaymentRequirements.Amount)
		return true, nil // Continue execution
	})

	afterHook := mcp.AfterExecutionHook(func(context mcp.AfterExecutionContext) error {
		fmt.Printf("✅ [Hook] After execution: %s\n", context.ToolName)
		fmt.Printf("   Result error: %v\n", context.Result.IsError)
		return nil
	})

	settlementHook := mcp.AfterSettlementHook(func(context mcp.SettlementContext) error {
		fmt.Printf("💸 [Hook] Settlement complete: %s\n", context.ToolName)
		if context.Settlement.Transaction != "" {
			fmt.Printf("   Transaction: %s\n", context.Settlement.Transaction)
		}
		fmt.Printf("   Success: %v\n\n", context.Settlement.Success)
		return nil
	})

	sharedHooks := &mcp.PaymentWrapperHooks{
		OnBeforeExecution: &beforeHook,
		OnAfterExecution:  &afterHook,
		OnAfterSettlement: &settlementHook,
	}

	paymentWrapperWeather := mcp.NewPaymentWrapper(resourceServer, mcp.PaymentWrapperConfig{
		Accepts: weatherAccepts,
		Resource: &mcp.ResourceInfo{
			URL:         "mcp://tool/get_weather",
			Description: "Get weather for a city",
			MimeType:    "application/json",
		},
		Hooks: sharedHooks,
	})

	paymentWrapperForecast := mcp.NewPaymentWrapper(resourceServer, mcp.PaymentWrapperConfig{
		Accepts: forecastAccepts,
		Resource: &mcp.ResourceInfo{
			URL:         "mcp://tool/get_forecast",
			Description: "Get 7-day forecast",
			MimeType:    "application/json",
		},
		Hooks: sharedHooks,
	})

	// ========================================================================
	// STEP 5: Register tools using REAL MCP SDK
	// ========================================================================

	// Free tool
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

	// Weather tool - $0.001 with hooks
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

	// Forecast tool - $0.005 with hooks
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
	return startHTTPServerAdvanced(mcpServer, port)
}

func startHTTPServerAdvanced(mcpServer *mcpsdk.Server, port string) error {
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
			"mode":   "advanced-with-hooks",
			"server": "x402 MCP Server (Advanced)",
		})
	})

	fmt.Printf("🚀 x402 MCP Server (Advanced) running on http://localhost:%s\n", port)
	fmt.Println("\n📋 Available tools:")
	fmt.Println("   - get_weather (paid: $0.001) [with hooks]")
	fmt.Println("   - get_forecast (paid: $0.005) [with hooks]")
	fmt.Println("   - ping (free)")
	fmt.Printf("\n🔗 Connect via SSE: http://localhost:%s/sse\n", port)
	fmt.Println("\n📊 Hooks enabled:")
	fmt.Println("   - OnBeforeExecution: Rate limiting, validation")
	fmt.Println("   - OnAfterExecution: Logging, metrics")
	fmt.Println("   - OnAfterSettlement: Receipts, notifications")
	fmt.Println("\n💡 This example uses NewPaymentWrapper() with hooks and REAL MCP SDK.\n")

	server := &http.Server{
		Addr:    ":" + port,
		Handler: mux,
	}

	return server.ListenAndServe()
}
