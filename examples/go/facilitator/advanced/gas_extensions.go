package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	x402 "github.com/x402-foundation/x402/go"
	eip2612gassponsor "github.com/x402-foundation/x402/go/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/extensions/erc20approvalgassponsor"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/facilitator"
	uptoevm "github.com/x402-foundation/x402/go/mechanisms/evm/upto/facilitator"
)

/**
 * Gas extensions facilitator example (exact + upto)
 *
 * Registers `exact` and `upto` on Base Sepolia and advertises both Permit2 gas-sponsoring
 * extensions: EIP-2612 and ERC-20 approve (tokens without EIP-2612).
 *
 * Requires EVM_PRIVATE_KEY with Base Sepolia ETH for settlement and for broadcasting
 * client-supplied approval transactions when those extensions are used.
 */

func runGasExtensionsExample(evmPrivateKey string) error {
	evmNetwork := x402.Network("eip155:84532")

	evmSigner, err := newFacilitatorEvmSigner(evmPrivateKey, DefaultEvmRPC)
	if err != nil {
		return fmt.Errorf("failed to create EVM signer: %w", err)
	}

	facilitator := x402.Newx402Facilitator()

	evmConfig := &evm.ExactEvmSchemeConfig{
		DeployERC4337WithEIP6492: true,
	}
	facilitator.Register([]x402.Network{evmNetwork}, evm.NewExactEvmScheme(evmSigner, evmConfig))
	facilitator.Register([]x402.Network{evmNetwork}, uptoevm.NewUptoEvmScheme(evmSigner, nil))

	facilitator.RegisterExtension(eip2612gassponsor.EIP2612GasSponsoring)
	facilitator.RegisterExtension(&erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension{
		Signer: newErc20ApprovalGasSponsorSigner(evmSigner),
	})

	facilitator.OnAfterVerify(func(ctx x402.FacilitatorVerifyResultContext) error {
		fmt.Printf("✅ Payment verified\n")
		return nil
	})

	facilitator.OnAfterSettle(func(ctx x402.FacilitatorSettleResultContext) error {
		fmt.Printf("🎉 Payment settled: %s\n", ctx.Result.Transaction)
		return nil
	})

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	r.GET("/supported", func(c *gin.Context) {
		supported := facilitator.GetSupported()
		c.JSON(http.StatusOK, supported)
	})

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

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

	fmt.Printf("🚀 Gas extensions facilitator (exact + upto) listening on http://localhost:%s\n", defaultPort)
	fmt.Printf("   Extensions: eip2612GasSponsoring, erc20ApprovalGasSponsoring\n")
	fmt.Printf("   EVM: %s on %s\n", evmSigner.GetAddresses()[0], evmNetwork)
	fmt.Println()

	return r.Run(":" + defaultPort)
}
