package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	x402 "github.com/x402-foundation/x402/go"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/facilitator"
	uptoevm "github.com/x402-foundation/x402/go/mechanisms/evm/upto/facilitator"
	svm "github.com/x402-foundation/x402/go/mechanisms/svm/exact/facilitator"
)

/**
 * All Networks Facilitator Example
 *
 * Demonstrates how to create a facilitator that supports all available networks with
 * optional chain configuration via environment variables.
 *
 * New chain support should be added here in alphabetic order by network prefix
 * (e.g., "eip155" before "solana").
 */

const (
	defaultPort = "4022"
)

func runAllNetworksExample(evmPrivateKey, svmPrivateKey string) error {
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

	// Register EVM scheme if signer is available (only explicitly specified networks)
	if evmSigner != nil {
		evmConfig := &evm.ExactEvmSchemeConfig{
			DeployERC4337WithEIP6492: true,
		}
		facilitator.Register([]x402.Network{evmNetwork}, evm.NewExactEvmScheme(evmSigner, evmConfig))
		facilitator.Register([]x402.Network{evmNetwork}, uptoevm.NewUptoEvmScheme(evmSigner, nil))
	}

	// Register SVM scheme if signer is available (only explicitly specified networks)
	if svmSigner != nil {
		facilitator.Register([]x402.Network{svmNetwork}, svm.NewExactSvmScheme(svmSigner))
	}

	// Add lifecycle hooks
	facilitator.OnAfterVerify(func(ctx x402.FacilitatorVerifyResultContext) error {
		fmt.Printf("✅ Payment verified\n")
		return nil
	})

	facilitator.OnAfterSettle(func(ctx x402.FacilitatorSettleResultContext) error {
		fmt.Printf("🎉 Payment settled: %s\n", ctx.Result.Transaction)
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

	// Health endpoint
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// Verify endpoint
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

		result, err := facilitator.Verify(ctx, reqBody.PaymentPayload, reqBody.PaymentRequirements)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		c.JSON(http.StatusOK, result)
	})

	// Settle endpoint
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

		result, err := facilitator.Settle(ctx, reqBody.PaymentPayload, reqBody.PaymentRequirements)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		c.JSON(http.StatusOK, result)
	})

	// Print startup info
	fmt.Printf("🚀 All Networks Facilitator listening on http://localhost:%s\n", defaultPort)
	if evmSigner != nil {
		fmt.Printf("   EVM: %s on %s\n", evmSigner.GetAddresses()[0], evmNetwork)
	}
	if svmSigner != nil {
		fmt.Printf("   SVM: %s on %s\n", svmSigner.GetAddresses(context.Background(), string(svmNetwork))[0], svmNetwork)
	}
	fmt.Println()

	return r.Run(":" + defaultPort)
}
