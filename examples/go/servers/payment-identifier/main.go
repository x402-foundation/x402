package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/paymentidentifier"
	x402http "github.com/x402-foundation/x402/go/http"
	ginmw "github.com/x402-foundation/x402/go/http/gin"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/server"
)

const DefaultPort = "4021"

type processedPayment struct {
	orderID     string
	fingerprint string
}

// paymentHeaderFingerprint hashes the raw PAYMENT-SIGNATURE header.
// Because a proper retry resends the exact same signed payload, the header
// bytes are identical and the hash matches. A genuinely different request
// produces a different hash → 409 Conflict.
func paymentHeaderFingerprint(header string) string {
	hash := sha256.Sum256([]byte(header))
	return hex.EncodeToString(hash[:])
}

/**
 * Payment Identifier Extension Example
 *
 * This example demonstrates how to use the payment-identifier extension
 * to enable idempotency for payment requests. The extension allows clients
 * to provide a unique identifier that servers can use for deduplication.
 *
 * Key concepts:
 * - Server declares support with DeclarePaymentIdentifierExtension(required bool)
 * - When required=true, clients MUST provide an ID or receive 400 Bad Request
 * - When required=false, clients MAY provide an ID for optional deduplication
 * - Idempotency is checked BEFORE the payment middleware so duplicate requests
 *   skip verification and settlement entirely
 */

func main() {
	godotenv.Load()

	evmPayeeAddress := os.Getenv("EVM_PAYEE_ADDRESS")
	if evmPayeeAddress == "" {
		fmt.Println("EVM_PAYEE_ADDRESS environment variable is required")
		os.Exit(1)
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("FACILITATOR_URL environment variable is required")
		os.Exit(1)
	}

	evmNetwork := x402.Network("eip155:84532") // Base Sepolia

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	// In-memory store for processed payments (use Redis/DB in production)
	processedPayments := make(map[string]processedPayment)

	// Create x402 resource server
	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(facilitatorClient),
	).
		Register(evmNetwork, evm.NewExactEvmScheme())

	paymentIdExtension := paymentidentifier.DeclarePaymentIdentifierExtension(true)

	routes := x402http.RoutesConfig{
		"POST /order": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   evmPayeeAddress,
					Price:   "$0.01",
					Network: evmNetwork,
				},
			},
			Description: "Create an order (requires payment identifier for idempotency)",
			MimeType:    "application/json",
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: paymentIdExtension,
			},
		},
	}

	// Idempotency middleware — runs BEFORE the payment middleware.
	// If we've already processed this payment ID, return the cached response
	// immediately without re-verifying or re-settling the payment.
	r.Use(func(c *gin.Context) {
		paymentHeader := c.GetHeader("PAYMENT-SIGNATURE")
		if paymentHeader == "" {
			c.Next()
			return
		}

		// Decode the payment header to extract the payment ID
		decoded, err := base64.StdEncoding.DecodeString(paymentHeader)
		if err != nil {
			c.Next()
			return
		}

		paymentID, err := paymentidentifier.ExtractPaymentIdentifierFromBytes(decoded, false)
		if err != nil || paymentID == "" {
			c.Next()
			return
		}

		existing, found := processedPayments[paymentID]
		if !found {
			c.Next()
			return
		}

		// Duplicate payment ID — compare fingerprints
		fingerprint := paymentHeaderFingerprint(paymentHeader)

		if existing.fingerprint != fingerprint {
			fmt.Printf("Conflict: payment ID %s reused with different payload\n", paymentID)
			c.JSON(http.StatusConflict, gin.H{
				"error":     "payment identifier already used with different payload",
				"paymentId": paymentID,
			})
			c.Abort()
			return
		}

		fmt.Printf("Duplicate payment detected: %s -> returning existing order: %s\n", paymentID, existing.orderID)
		c.JSON(http.StatusOK, gin.H{
			"orderId":   existing.orderID,
			"status":    "already_processed",
			"paymentId": paymentID,
			"message":   "This payment was already processed",
		})
		c.Abort()
	})

	// Payment middleware — only runs for requests that pass the idempotency check
	r.Use(ginmw.PaymentMiddleware(routes, server,
		ginmw.WithTimeout(30*time.Second),
	))

	r.POST("/order", func(c *gin.Context) {
		// Get the payment payload from context (set by middleware)
		payloadInterface, exists := c.Get("x402_payload")
		if !exists {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "payment payload not found"})
			return
		}

		payload, ok := payloadInterface.(x402.PaymentPayload)
		if !ok {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "invalid payload type"})
			return
		}

		// Extract payment identifier from the payload
		paymentID, err := paymentidentifier.ExtractPaymentIdentifier(payload, true)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid payment identifier: %v", err)})
			return
		}

		if paymentID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "payment identifier is required"})
			return
		}

		// Compute fingerprint from the raw payment header
		paymentHeader := c.GetHeader("PAYMENT-SIGNATURE")
		fingerprint := paymentHeaderFingerprint(paymentHeader)

		// Process the order (your business logic here)
		orderID := fmt.Sprintf("order_%d", time.Now().UnixNano())

		// Store for future deduplication
		processedPayments[paymentID] = processedPayment{
			orderID:     orderID,
			fingerprint: fingerprint,
		}

		fmt.Printf("New order created: %s with payment ID: %s\n", orderID, paymentID)

		c.JSON(http.StatusOK, gin.H{
			"orderId":   orderID,
			"status":    "created",
			"paymentId": paymentID,
			"message":   "Order created successfully",
		})
	})

	fmt.Printf("Payment Identifier example running on http://localhost:%s\n", DefaultPort)
	fmt.Printf("POST /order - requires payment identifier for idempotency\n")

	if err := r.Run(":" + DefaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
