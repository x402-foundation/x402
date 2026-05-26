package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/paymentidentifier"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/facilitator"
	svm "github.com/x402-foundation/x402/go/mechanisms/svm/exact/facilitator"
)

/**
 * Payment Identifier Facilitator Example
 *
 * This demonstrates how facilitators can extract and validate payment identifiers
 * from payment payloads for idempotency and deduplication.
 *
 * Key concepts:
 * - Extract payment ID from PaymentPayload using ExtractPaymentIdentifier()
 * - Validate requirements using ValidatePaymentIdentifierRequirement()
 * - Track processed payments for idempotency guarantees
 *
 * Use cases:
 * - Prevent duplicate settlements
 * - Track payment processing state
 * - Provide exactly-once settlement semantics
 */

// PaymentRecord tracks a processed payment for idempotency
type PaymentRecord struct {
	PaymentID   string    `json:"paymentId"`
	Status      string    `json:"status"` // "verified", "settled", "failed"
	Transaction string    `json:"transaction,omitempty"`
	ProcessedAt time.Time `json:"processedAt"`
}

// IdempotencyStore stores processed payment records
type IdempotencyStore struct {
	records map[string]PaymentRecord
	mutex   sync.RWMutex
}

func NewIdempotencyStore() *IdempotencyStore {
	return &IdempotencyStore{
		records: make(map[string]PaymentRecord),
	}
}

func (s *IdempotencyStore) Get(paymentID string) (PaymentRecord, bool) {
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	record, found := s.records[paymentID]
	return record, found
}

func (s *IdempotencyStore) Set(paymentID string, record PaymentRecord) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.records[paymentID] = record
}

func (s *IdempotencyStore) GetAll() []PaymentRecord {
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	result := make([]PaymentRecord, 0, len(s.records))
	for _, r := range s.records {
		result = append(result, r)
	}
	return result
}

func runPaymentIdentifierExample(evmPrivateKey, svmPrivateKey string) error {
	// Network configuration
	evmNetwork := x402.Network("eip155:84532")                            // Base Sepolia
	svmNetwork := x402.Network("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1") // Solana Devnet

	// Initialize signers based on available keys
	var evmSigner *facilitatorEvmSigner
	var svmSigner *facilitatorSvmSigner
	var err error

	if evmPrivateKey != "" {
		evmSigner, err = newFacilitatorEvmSigner(evmPrivateKey, DefaultEvmRPC)
		if err != nil {
			return fmt.Errorf("failed to create EVM signer: %w", err)
		}
	}

	if svmPrivateKey != "" {
		svmSigner, err = newFacilitatorSvmSigner(svmPrivateKey, DefaultSvmRPC)
		if err != nil {
			return fmt.Errorf("failed to create SVM signer: %w", err)
		}
	}

	// Create facilitator
	facilitator := x402.Newx402Facilitator()

	// Register EVM scheme if signer is available
	if evmSigner != nil {
		evmConfig := &evm.ExactEvmSchemeConfig{
			DeployERC4337WithEIP6492: true,
		}
		facilitator.Register([]x402.Network{evmNetwork}, evm.NewExactEvmScheme(evmSigner, evmConfig))
	}

	// Register SVM scheme if signer is available
	if svmSigner != nil {
		facilitator.Register([]x402.Network{svmNetwork}, svm.NewExactSvmScheme(svmSigner))
	}

	// Initialize idempotency store
	store := NewIdempotencyStore()

	/**
	 * Extract and validate payment identifier in verification hook
	 */
	facilitator.OnAfterVerify(func(ctx x402.FacilitatorVerifyResultContext) error {
		fmt.Printf("✅ Payment verified\n")

		// Extract payment identifier from the payload
		paymentID, err := paymentidentifier.ExtractPaymentIdentifierFromBytes(ctx.PayloadBytes, true)
		if err != nil {
			fmt.Printf("   ⚠️  Failed to extract payment ID: %v\n", err)
			return nil // Continue without payment ID
		}

		if paymentID == "" {
			fmt.Println("   📝 No payment identifier provided")
			return nil
		}

		fmt.Printf("   📝 Payment ID: %s\n", paymentID)

		// Check if this payment was already processed
		if existing, found := store.Get(paymentID); found {
			fmt.Printf("   🔄 Duplicate payment detected!\n")
			fmt.Printf("      Previous status: %s\n", existing.Status)
			fmt.Printf("      Processed at: %s\n", existing.ProcessedAt.Format(time.RFC3339))
			// The verify response is already being returned, just log the duplicate
			return nil
		}

		// Record the verified payment
		store.Set(paymentID, PaymentRecord{
			PaymentID:   paymentID,
			Status:      "verified",
			ProcessedAt: time.Now(),
		})
		fmt.Println("   ✅ Payment ID recorded for idempotency")

		return nil
	})

	/**
	 * Update payment record after settlement
	 */
	facilitator.OnAfterSettle(func(ctx x402.FacilitatorSettleResultContext) error {
		fmt.Printf("🎉 Payment settled: %s\n", ctx.Result.Transaction)

		// Extract payment identifier
		paymentID, _ := paymentidentifier.ExtractPaymentIdentifierFromBytes(ctx.PayloadBytes, false)
		if paymentID != "" {
			// Update the record with settlement info
			store.Set(paymentID, PaymentRecord{
				PaymentID:   paymentID,
				Status:      "settled",
				Transaction: ctx.Result.Transaction,
				ProcessedAt: time.Now(),
			})
			fmt.Printf("   ✅ Payment ID %s marked as settled\n", paymentID)
		}

		return nil
	})

	// Setup Gin router
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	// Supported endpoint
	r.GET("/supported", func(c *gin.Context) {
		supported := facilitator.GetSupported()
		c.JSON(http.StatusOK, supported)
	})

	// Payment records endpoint (for debugging/monitoring)
	r.GET("/payments", func(c *gin.Context) {
		records := store.GetAll()
		c.JSON(http.StatusOK, gin.H{
			"payments": records,
			"count":    len(records),
		})
	})

	// Health endpoint
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// Verify endpoint with idempotency check
	r.POST("/verify", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()

		var reqBody struct {
			PaymentPayload      json.RawMessage `json:"paymentPayload"`
			PaymentRequirements json.RawMessage `json:"paymentRequirements"`
		}

		if err := c.BindJSON(&reqBody); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
			return
		}

		// Check for duplicate before verification
		paymentID, _ := paymentidentifier.ExtractPaymentIdentifierFromBytes(reqBody.PaymentPayload, false)
		if paymentID != "" {
			if existing, found := store.Get(paymentID); found && existing.Status == "settled" {
				// Return cached result for already-settled payments
				c.JSON(http.StatusOK, gin.H{
					"isValid":     true,
					"payer":       "",
					"idempotent":  true,
					"paymentId":   paymentID,
					"transaction": existing.Transaction,
					"message":     "Payment was already settled",
				})
				return
			}
		}

		result, err := facilitator.Verify(ctx, reqBody.PaymentPayload, reqBody.PaymentRequirements)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		c.JSON(http.StatusOK, result)
	})

	// Settle endpoint with idempotency check
	r.POST("/settle", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
		defer cancel()

		var reqBody struct {
			PaymentPayload      json.RawMessage `json:"paymentPayload"`
			PaymentRequirements json.RawMessage `json:"paymentRequirements"`
		}

		if err := c.BindJSON(&reqBody); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
			return
		}

		// Check for duplicate settlement
		paymentID, _ := paymentidentifier.ExtractPaymentIdentifierFromBytes(reqBody.PaymentPayload, false)
		if paymentID != "" {
			if existing, found := store.Get(paymentID); found && existing.Status == "settled" {
				// Return cached result for already-settled payments
				fmt.Printf("🔄 Returning cached settlement for payment ID: %s\n", paymentID)
				c.JSON(http.StatusOK, gin.H{
					"success":     true,
					"transaction": existing.Transaction,
					"network":     "",
					"idempotent":  true,
					"paymentId":   paymentID,
					"message":     "Payment was already settled",
				})
				return
			}
		}

		result, err := facilitator.Settle(ctx, reqBody.PaymentPayload, reqBody.PaymentRequirements)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		c.JSON(http.StatusOK, result)
	})

	// Print startup info
	fmt.Printf("🚀 Payment Identifier Facilitator listening on http://localhost:%s\n", defaultPort)
	if evmSigner != nil {
		fmt.Printf("   EVM: %s on %s\n", evmSigner.GetAddresses()[0], evmNetwork)
	}
	if svmSigner != nil {
		fmt.Printf("   SVM: %s on %s\n", svmSigner.GetAddresses(context.Background(), string(svmNetwork))[0], svmNetwork)
	}
	fmt.Printf("   Payment records: GET /payments\n")
	fmt.Println()

	return r.Run(":" + defaultPort)
}
