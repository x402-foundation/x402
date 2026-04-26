package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/bazaar"
	x402http "github.com/x402-foundation/x402/go/http"
	mcp402 "github.com/x402-foundation/x402/go/mcp"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/server"
	"github.com/x402-foundation/x402/go/types"
)

// getWeatherData simulates fetching weather data for a city.
func getWeatherData(city string) map[string]interface{} {
	conditions := []string{"sunny", "cloudy", "rainy", "snowy", "windy"}
	weather := conditions[rand.Intn(len(conditions))]
	temperature := rand.Intn(40) + 40
	return map[string]interface{}{
		"city":        city,
		"weather":     weather,
		"temperature": temperature,
	}
}

// getString extracts a string argument from CallToolRequest.
func getString(request *mcp.CallToolRequest, key string, defaultValue string) string {
	if request.Params.Arguments == nil {
		return defaultValue
	}
	var args map[string]any
	if err := json.Unmarshal(request.Params.Arguments, &args); err != nil {
		return defaultValue
	}
	if v, ok := args[key].(string); ok {
		return v
	}
	return defaultValue
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "4022"
	}

	evmPayeeAddress := os.Getenv("EVM_PAYEE_ADDRESS")
	if evmPayeeAddress == "" {
		fmt.Println("❌ EVM_PAYEE_ADDRESS environment variable is required")
		os.Exit(1)
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("❌ FACILITATOR_URL environment variable is required")
		os.Exit(1)
	}

	evmNetworkStr := os.Getenv("EVM_NETWORK")
	if evmNetworkStr == "" {
		evmNetworkStr = "eip155:84532"
	}
	evmNetwork := x402.Network(evmNetworkStr)

	// Create HTTP facilitator client for payment verification
	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	// Create x402 resource server
	resourceServer := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(facilitatorClient),
		x402.WithSchemeServer(evmNetwork, evm.NewExactEvmScheme()),
	)
	ctx := context.Background()
	if err := resourceServer.Initialize(ctx); err != nil {
		fmt.Printf("❌ Failed to initialize resource server: %v\n", err)
		os.Exit(1)
	}

	// Build payment requirements for weather tool
	weatherAccepts, err := resourceServer.BuildPaymentRequirementsFromConfig(ctx, x402.ResourceConfig{
		Scheme:  "exact",
		Network: evmNetwork,
		PayTo:   evmPayeeAddress,
		Price:   "$0.001",
	})
	if err != nil {
		fmt.Printf("❌ Failed to build payment requirements: %v\n", err)
		os.Exit(1)
	}

	// Declare bazaar MCP discovery extension for weather tool
	weatherInputSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"city": map[string]any{
				"type":        "string",
				"description": "The city name to get weather for",
			},
		},
		"required": []string{"city"},
	}
	bazaarExtension, err := bazaar.DeclareMcpDiscoveryExtension(bazaar.DeclareMcpDiscoveryConfig{
		ToolName:    "get_weather",
		Description: "Get current weather for a city. Requires payment of $0.001.",
		Transport:   bazaar.TransportSSE,
		InputSchema: weatherInputSchema,
		Example:     map[string]any{"city": "San Francisco"},
	})
	if err != nil {
		fmt.Printf("❌ Failed to declare bazaar extension: %v\n", err)
		os.Exit(1)
	}

	// Create payment wrapper using the x402 MCP SDK
	paymentWrapper := mcp402.NewPaymentWrapper(resourceServer, mcp402.PaymentWrapperConfig{
		Accepts: weatherAccepts,
		Resource: &types.ResourceInfo{
			URL:         "mcp://tool/get_weather",
			Description: "Get current weather for a city",
			MimeType:    "application/json",
		},
		Extensions: map[string]interface{}{
			bazaar.BAZAAR.Key(): bazaarExtension,
		},
	})

	// Create MCP server using the official SDK
	mcpServer := mcp.NewServer(
		&mcp.Implementation{
			Name:    "x402 MCP E2E Server",
			Version: "1.0.0",
		},
		nil,
	)

	// Register paid weather tool - wrapped with payment verification/settlement
	weatherTool := &mcp.Tool{
		Name:        "get_weather",
		Description: "Get current weather for a city. Requires payment of $0.001.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"city": map[string]any{
					"type":        "string",
					"description": "The city name to get weather for",
				},
			},
			"required": []string{"city"},
		},
	}

	mcpServer.AddTool(weatherTool, paymentWrapper.Wrap(
		func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			// This handler only runs after payment is verified.
			// Settlement happens automatically after this returns.
			city := getString(request, "city", "unknown")
			data := getWeatherData(city)
			dataJSON, _ := json.Marshal(data)
			return &mcp.CallToolResult{
				Content: []mcp.Content{&mcp.TextContent{Text: string(dataJSON)}},
			}, nil
		},
	))

	// Register free ping tool (no payment wrapper)
	pingTool := &mcp.Tool{
		Name:        "ping",
		Description: "A free health check tool",
		InputSchema: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	}

	mcpServer.AddTool(pingTool, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "pong"}},
		}, nil
	})

	// Create SSE handler using the official SDK
	sseHandler := mcp.NewSSEHandler(func(r *http.Request) *mcp.Server {
		return mcpServer
	}, nil)

	// Create HTTP mux for health and close endpoints alongside SSE
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "ok",
			"tools":  []string{"get_weather (paid: $0.001)", "ping (free)"},
		})
	})

	mux.HandleFunc("/close", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"message": "Server shutting down gracefully",
		})
		go func() {
			time.Sleep(100 * time.Millisecond)
			os.Exit(0)
		}()
	})

	// Mount SSE handler as catch-all
	mux.Handle("/", sseHandler)

	fmt.Printf("Server listening on port %s\n", port)
	fmt.Printf("SSE endpoint: http://localhost:%s/sse\n", port)
	fmt.Printf("Health: http://localhost:%s/health\n", port)

	if err := http.ListenAndServe(":"+port, mux); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
