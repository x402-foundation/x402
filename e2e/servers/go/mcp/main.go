package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	e2eserver "github.com/x402-foundation/x402/e2e/servers/go"
	x402 "github.com/x402-foundation/x402/go/v2"
	mcp402 "github.com/x402-foundation/x402/go/v2/mcp"
)

var shutdownRequested bool

// MCP E2E Test Server with x402 Payment Support.
//
// Thin MCP transport over the same mechanisms catalog as the HTTP servers
// (see e2eserver.ResolvedRoutes) — each catalog route becomes an MCP tool
// wrapped with mcp402.PaymentWrapper for verification + settlement.

func main() {
	cfg := e2eserver.LoadConfig()
	facilitatorClient := e2eserver.NewFacilitatorClient(cfg)

	resourceServer := x402.Newx402ResourceServer(x402.WithFacilitatorClient(facilitatorClient))
	for _, binding := range e2eserver.SchemeBindings(cfg) {
		resourceServer.Register(binding.Network, binding.Server)
	}

	ctx := context.Background()
	if err := resourceServer.Initialize(ctx); err != nil {
		fmt.Printf("Warning: failed to initialize x402 server: %v\n", err)
	}

	mcpServer := mcp.NewServer(&mcp.Implementation{
		Name:    "x402 MCP E2E Server",
		Version: "1.0.0",
	}, nil)

	for _, route := range e2eserver.ResolvedRoutes() {
		route := route
		toolName := e2eserver.McpToolName(route.Path)
		description := e2eserver.RouteDescription(route)
		_, extensions := e2eserver.BuildResolvedRouteConfig(route, "mcp")

		requirements, err := resourceServer.BuildPaymentRequirementsFromConfig(ctx, x402.ResourceConfig{
			Scheme:  route.Scheme,
			PayTo:   route.PayTo,
			Price:   route.Price,
			Network: x402.Network(route.Network),
			Extra:   route.Extra,
		})
		if err != nil {
			fmt.Printf("❌ Failed to build payment requirements for %s: %v\n", route.Path, err)
			os.Exit(1)
		}

		wrapperConfig := mcp402.PaymentWrapperConfig{
			Accepts: requirements,
			Resource: &mcp402.ResourceInfo{
				URL:         "mcp://tool/" + toolName,
				Description: description,
				MimeType:    "application/json",
			},
		}
		if len(extensions) > 0 {
			wrapperConfig.Extensions = extensions
		}
		wrapper := mcp402.NewPaymentWrapper(resourceServer, wrapperConfig)

		tool := &mcp.Tool{
			Name:        toolName,
			Description: description,
			InputSchema: &jsonschema.Schema{Type: "object"},
		}

		mcpServer.AddTool(tool, wrapper.Wrap(
			func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				if shutdownRequested {
					body, _ := json.Marshal(map[string]interface{}{"error": "Server shutting down"})
					return &mcp.CallToolResult{
						Content: []mcp.Content{&mcp.TextContent{Text: string(body)}},
						IsError: true,
					}, nil
				}
				body, _ := json.Marshal(e2eserver.RouteBody())
				return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(body)}}}, nil
			},
		))
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, e2eserver.HealthBody())
	})

	mux.HandleFunc("POST /close", func(w http.ResponseWriter, r *http.Request) {
		shutdownRequested = true

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message": "Server shutting down gracefully",
		})
		fmt.Println("Received shutdown request")

		go func() {
			time.Sleep(100 * time.Millisecond)
			os.Exit(0)
		}()
	})

	sseHandler := mcp.NewSSEHandler(func(r *http.Request) *mcp.Server {
		return mcpServer
	}, nil)
	mux.Handle("/", sseHandler)

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-quit
		fmt.Println("Received shutdown signal, exiting...")
		os.Exit(0)
	}()

	// Bind the socket first and only then print the "listening" log, so the
	// e2e harness (which treats this log line as the readiness signal)
	// doesn't consider the server ready before it can actually accept
	// connections.
	listener, err := net.Listen("tcp", ":"+cfg.Port)
	if err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(e2eserver.FormatStartupBanner(
		"x402 MCP E2E Test Server",
		"http://localhost:"+cfg.Port,
	))

	if err := http.Serve(listener, mux); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}

// writeJSON is a helper to write JSON responses.
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
