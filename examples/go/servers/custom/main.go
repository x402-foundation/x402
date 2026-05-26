package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/server"
)

const (
	DefaultPort = "4021"
)

/**
 * Custom Middleware Example - Direct x402 Integration
 *
 * This example demonstrates how to implement x402 payment handling WITHOUT
 * using the pre-built middleware. It shows the implementation details of how
 * to integrate x402 directly with any Go web framework.
 *
 * Use this example to:
 * - Understand how x402 middleware works under the hood
 * - Learn how to customize payment handling for your specific needs
 * - See how to integrate x402 with custom web frameworks
 */

// ============================================================================
// Custom Gin Adapter
// ============================================================================

// CustomGinAdapter implements the HTTPAdapter interface for Gin
// This adapter translates Gin-specific HTTP operations to the x402 HTTP interface
type CustomGinAdapter struct {
	ctx *gin.Context
}

func NewCustomGinAdapter(ctx *gin.Context) *CustomGinAdapter {
	return &CustomGinAdapter{ctx: ctx}
}

func (a *CustomGinAdapter) GetHeader(name string) string {
	return a.ctx.GetHeader(name)
}

func (a *CustomGinAdapter) GetMethod() string {
	return a.ctx.Request.Method
}

func (a *CustomGinAdapter) GetPath() string {
	return a.ctx.Request.URL.Path
}

func (a *CustomGinAdapter) GetURL() string {
	scheme := "http"
	if a.ctx.Request.TLS != nil {
		scheme = "https"
	}
	host := a.ctx.Request.Host
	if host == "" {
		host = a.ctx.GetHeader("Host")
	}
	return fmt.Sprintf("%s://%s%s", scheme, host, a.ctx.Request.URL.Path)
}

func (a *CustomGinAdapter) GetAcceptHeader() string {
	return a.ctx.GetHeader("Accept")
}

func (a *CustomGinAdapter) GetUserAgent() string {
	return a.ctx.GetHeader("User-Agent")
}

// ============================================================================
// Response Capture for Settlement
// ============================================================================

// ResponseCapture captures the response for settlement processing
// This allows us to inspect the response before sending it to the client
type ResponseCapture struct {
	gin.ResponseWriter
	body       *bytes.Buffer
	statusCode int
	written    bool
	mu         sync.Mutex
}

func (w *ResponseCapture) WriteHeader(code int) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if !w.written {
		w.statusCode = code
		w.written = true
	}
}

func (w *ResponseCapture) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if !w.written {
		w.WriteHeader(http.StatusOK)
	}
	return w.body.Write(data)
}

func (w *ResponseCapture) WriteString(s string) (int, error) {
	return w.Write([]byte(s))
}

// ============================================================================
// Custom Payment Middleware Implementation
// ============================================================================

// customPaymentMiddleware creates a custom x402 payment middleware
// This demonstrates the core logic of payment handling without using pre-built middleware
func customPaymentMiddleware(server *x402http.HTTPServer, timeout time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Create context with timeout for payment operations
		ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
		defer cancel()

		// Create adapter to translate Gin requests to x402 HTTP interface
		adapter := NewCustomGinAdapter(c)
		reqCtx := x402http.HTTPRequestContext{
			Adapter: adapter,
			Path:    c.Request.URL.Path,
			Method:  c.Request.Method,
		}

		fmt.Printf("🔍 Processing request: %s %s\n", reqCtx.Method, reqCtx.Path)

		// Process the HTTP request through x402
		// This checks if payment is required, validates payment if provided, etc.
		result := server.ProcessHTTPRequest(ctx, reqCtx, nil)

		// Handle different result types
		switch result.Type {
		case x402http.ResultNoPaymentRequired:
			// No payment required for this route, continue to handler
			fmt.Printf("✅ No payment required, continuing to handler\n")
			c.Next()

		case x402http.ResultPaymentError:
			// Payment is required but not provided or invalid
			fmt.Printf("❌ Payment error: %d\n", result.Response.Status)
			handlePaymentError(c, result.Response)

		case x402http.ResultPaymentVerified:
			// Payment verified, continue with settlement handling
			fmt.Printf("✅ Payment verified, proceeding to handler\n")
			handlePaymentVerified(c, server, ctx, result)
		}
	}
}

// handlePaymentError sends a payment required response to the client
func handlePaymentError(c *gin.Context, response *x402http.HTTPResponseInstructions) {
	// Set status code
	c.Status(response.Status)

	// Set headers (includes x402 payment requirements)
	for key, value := range response.Headers {
		c.Header(key, value)
	}

	// Send response body
	if response.IsHTML {
		// HTML paywall for browsers
		c.Data(response.Status, "text/html; charset=utf-8", []byte(response.Body.(string)))
	} else {
		// JSON response for API clients
		c.JSON(response.Status, response.Body)
	}

	// Abort to prevent further handlers from running
	c.Abort()
}

// handlePaymentVerified handles verified payments with settlement
func handlePaymentVerified(c *gin.Context, server *x402http.HTTPServer, ctx context.Context, result x402http.HTTPProcessResult) {
	// Capture the response so we can inspect it before settlement
	capture := &ResponseCapture{
		ResponseWriter: c.Writer,
		body:           &bytes.Buffer{},
		statusCode:     http.StatusOK,
	}
	c.Writer = capture

	// Continue to the protected handler
	c.Next()

	// Restore original writer
	c.Writer = capture.ResponseWriter

	// Check if request was aborted by handler
	if c.IsAborted() {
		return
	}

	// Don't settle if the handler returned an error
	if capture.statusCode >= 400 {
		fmt.Printf("⚠️  Handler returned error %d, skipping settlement\n", capture.statusCode)
		c.Writer.WriteHeader(capture.statusCode)
		c.Writer.Write(capture.body.Bytes())
		return
	}

	fmt.Printf("💰 Settling payment...\n")

	// Process settlement through x402
	settlementHeaders, err := server.ProcessSettlement(
		ctx,
		*result.PaymentPayload,
		*result.PaymentRequirements,
		capture.statusCode,
	)

	if err != nil {
		fmt.Printf("❌ Settlement failed: %v\n", err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Settlement failed",
			"details": err.Error(),
		})
		return
	}

	fmt.Printf("✅ Settlement successful\n")

	// Add settlement headers to response
	if settlementHeaders != nil {
		for key, value := range settlementHeaders {
			c.Header(key, value)
		}

		// Log settlement details
		if settlementHeaders["PAYMENT-RESPONSE"] != "" {
			logSettlementDetails(settlementHeaders)
		}
	}

	// Write the captured response to the client
	c.Writer.WriteHeader(capture.statusCode)
	c.Writer.Write(capture.body.Bytes())
}

// logSettlementDetails extracts and logs settlement information
func logSettlementDetails(headers map[string]string) {
	httpClient := x402http.Newx402HTTPClient(x402.Newx402Client())
	settleResponse, err := httpClient.GetPaymentSettleResponse(headers)
	if err == nil {
		fmt.Printf("   Transaction: %s\n", settleResponse.Transaction)
		fmt.Printf("   Network: %s\n", settleResponse.Network)
		fmt.Printf("   Payer: %s\n", settleResponse.Payer)
	}
}

// ============================================================================
// Main Server
// ============================================================================

func main() {
	// Load .env file if it exists
	godotenv.Load()

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

	evmNetwork := x402.Network("eip155:84532") // Base Sepolia

	r := gin.Default()

	// ========================================================================
	// Configure x402 HTTP Server (Core Package)
	// ========================================================================

	// Create facilitator client for payment verification/settlement
	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	// Define routes and their payment requirements
	routes := x402http.RoutesConfig{
		"GET /weather": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   evmPayeeAddress,
					Price:   "$0.001",
					Network: evmNetwork,
				},
			},
			Description: "Get weather data for a city",
			MimeType:    "application/json",
		},
	}

	// Create x402 HTTP server with core package
	x402Server := x402http.Newx402HTTPResourceServer(
		routes,
		x402.WithFacilitatorClient(facilitatorClient),
		x402.WithSchemeServer(evmNetwork, evm.NewExactEvmScheme()),
	)

	// Initialize the server (queries facilitator for supported schemes)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := x402Server.Initialize(ctx); err != nil {
		fmt.Printf("⚠️  Warning: failed to initialize x402 server: %v\n", err)
	}

	// ========================================================================
	// Apply Custom Payment Middleware
	// ========================================================================

	// Use our custom middleware implementation
	r.Use(customPaymentMiddleware(x402Server, 30*time.Second))

	// ========================================================================
	// Protected Route Handler
	// ========================================================================

	r.GET("/weather", func(c *gin.Context) {
		city := c.DefaultQuery("city", "San Francisco")

		weatherData := map[string]map[string]interface{}{
			"San Francisco": {"weather": "foggy", "temperature": 60},
			"New York":      {"weather": "cloudy", "temperature": 55},
			"London":        {"weather": "rainy", "temperature": 50},
			"Tokyo":         {"weather": "clear", "temperature": 65},
		}

		data, exists := weatherData[city]
		if !exists {
			data = map[string]interface{}{"weather": "sunny", "temperature": 70}
		}

		c.JSON(http.StatusOK, gin.H{
			"city":        city,
			"weather":     data["weather"],
			"temperature": data["temperature"],
			"timestamp":   time.Now().Format(time.RFC3339),
		})
	})

	// ========================================================================
	// Public Routes (No Payment Required)
	// ========================================================================

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":  "ok",
			"version": "2.0.0",
		})
	})

	// Debug endpoint to inspect payment requirements
	r.GET("/debug/requirements", func(c *gin.Context) {
		ctx := context.Background()
		requirements, err := x402Server.BuildPaymentRequirementsFromConfig(ctx, x402.ResourceConfig{
			Scheme:  "exact",
			PayTo:   evmPayeeAddress,
			Price:   "$0.001",
			Network: evmNetwork,
		})

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		// Pretty print requirements
		pretty, _ := json.MarshalIndent(requirements, "", "  ")
		c.Data(http.StatusOK, "application/json", pretty)
	})

	// ========================================================================
	// Start Server
	// ========================================================================

	fmt.Printf("🚀 Server: %s on %s\n", evmPayeeAddress, evmNetwork)
	fmt.Printf("   Listening on http://localhost:%s\n\n", DefaultPort)

	if err := r.Run(":" + DefaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
