package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/bazaar"
	exttypes "github.com/x402-foundation/x402/go/extensions/types"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/facilitator"
	uptoevm "github.com/x402-foundation/x402/go/mechanisms/evm/upto/facilitator"
	svm "github.com/x402-foundation/x402/go/mechanisms/svm/exact/facilitator"
)

/**
 * Facilitator with Discovery Extension Example
 *
 * Demonstrates how to create a facilitator with bazaar discovery extension that
 * catalogs discovered x402 resources.
 */

// DiscoveredResource represents a discovered x402 resource for the bazaar catalog
type DiscoveredResource struct {
	Resource      string                     `json:"resource"`
	Description   string                     `json:"description,omitempty"`
	MimeType      string                     `json:"mimeType,omitempty"`
	Type          string                     `json:"type"`
	X402Version   int                        `json:"x402Version"`
	Accepts       []x402.PaymentRequirements `json:"accepts"`
	DiscoveryInfo *exttypes.DiscoveryInfo    `json:"discoveryInfo,omitempty"`
	LastUpdated   string                     `json:"lastUpdated"`
}

// BazaarCatalog stores discovered resources
type BazaarCatalog struct {
	resources map[string]DiscoveredResource
	mutex     sync.RWMutex
}

const extensionResponsesHeader = "EXTENSION-RESPONSES"

func setExtensionResponsesHeader(c *gin.Context) {
	extensionResponses := map[string]map[string]string{
		"bazaar": {
			"status": "success",
		},
	}

	body, err := json.Marshal(extensionResponses)
	if err != nil {
		return
	}

	c.Header(extensionResponsesHeader, base64.StdEncoding.EncodeToString(body))
}

func NewBazaarCatalog() *BazaarCatalog {
	return &BazaarCatalog{
		resources: make(map[string]DiscoveredResource),
	}
}

func (c *BazaarCatalog) Add(res DiscoveredResource) {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	c.resources[res.Resource] = res
}

func (c *BazaarCatalog) GetAll() []DiscoveredResource {
	c.mutex.RLock()
	defer c.mutex.RUnlock()
	result := make([]DiscoveredResource, 0, len(c.resources))
	for _, r := range c.resources {
		result = append(result, r)
	}
	return result
}

// Search performs case-insensitive keyword matching across resource URL, type,
// and metadata values. Pagination is not supported for in-memory keyword search.
func (c *BazaarCatalog) Search(query, resourceType string, limit int) []DiscoveredResource {
	c.mutex.RLock()
	defer c.mutex.RUnlock()

	needle := strings.ToLower(query)
	var results []DiscoveredResource

	for _, r := range c.resources {
		haystack := strings.ToLower(r.Resource + " " + r.Type + " " + r.Description)
		if !strings.Contains(haystack, needle) {
			continue
		}
		if resourceType != "" && r.Type != resourceType {
			continue
		}
		results = append(results, r)
	}

	if limit > 0 && len(results) > limit {
		results = results[:limit]
	}

	return results
}

func runBazaarExample(evmPrivateKey, svmPrivateKey string) error {
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
		facilitator.Register([]x402.Network{evmNetwork}, uptoevm.NewUptoEvmScheme(evmSigner, nil))
	}

	// Register SVM scheme if signer is available
	if svmSigner != nil {
		facilitator.Register([]x402.Network{svmNetwork}, svm.NewExactSvmScheme(svmSigner))
	}

	// Initialize bazaar catalog
	catalog := NewBazaarCatalog()

	// Add discovery hook
	facilitator.OnAfterVerify(func(ctx x402.FacilitatorVerifyResultContext) error {
		fmt.Printf("✅ Payment verified\n")

		// Extract discovered resource from payment for bazaar catalog
		discovered, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(
			ctx.PayloadBytes,
			ctx.RequirementsBytes,
			true,
		)
		if err != nil {
			fmt.Printf("   ⚠️  Failed to extract discovery info: %v\n", err)
		} else if discovered != nil {
			fmt.Printf("   📝 Discovered resource: %s\n", discovered.ResourceURL)
			fmt.Printf("   📝 Method: %s\n", discovered.Method)
			fmt.Printf("   📝 X402Version: %d\n", discovered.X402Version)

			// Get requirements for the catalog
			var requirements x402.PaymentRequirements
			if err := json.Unmarshal(ctx.RequirementsBytes, &requirements); err == nil {
				catalog.Add(DiscoveredResource{
					Resource:      discovered.ResourceURL,
					Description:   discovered.Description,
					MimeType:      discovered.MimeType,
					Type:          "http",
					X402Version:   discovered.X402Version,
					Accepts:       []x402.PaymentRequirements{requirements},
					DiscoveryInfo: discovered.DiscoveryInfo,
					LastUpdated:   time.Now().Format(time.RFC3339),
				})
				fmt.Printf("   ✅ Added to bazaar catalog\n")
			}
		}

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

	// Discovery list endpoint
	r.GET("/discovery/resources", func(c *gin.Context) {
		resources := catalog.GetAll()
		c.JSON(http.StatusOK, gin.H{
			"x402Version": 2,
			"items":       resources,
			"pagination": gin.H{
				"limit":  100,
				"offset": 0,
				"total":  len(resources),
			},
		})
	})

	// Discovery search endpoint
	r.GET("/discovery/search", func(c *gin.Context) {
		query := c.Query("query")
		if query == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "query parameter is required"})
			return
		}
		resourceType := c.Query("type")
		limit := 0
		if limitParam := c.Query("limit"); limitParam != "" {
			fmt.Sscanf(limitParam, "%d", &limit)
		}

		items := catalog.Search(query, resourceType, limit)
		if items == nil {
			items = []DiscoveredResource{}
		}

		c.JSON(http.StatusOK, gin.H{
			"x402Version":    2,
			"resources":      items,
			"partialResults": false,
			"pagination":     nil,
		})
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

		setExtensionResponsesHeader(c)
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

		setExtensionResponsesHeader(c)
		c.JSON(http.StatusOK, result)
	})

	// Print startup info
	fmt.Printf("🚀 Discovery Facilitator listening on http://localhost:%s\n", defaultPort)
	if evmSigner != nil {
		fmt.Printf("   EVM: %s on %s\n", evmSigner.GetAddresses()[0], evmNetwork)
	}
	if svmSigner != nil {
		fmt.Printf("   SVM: %s on %s\n", svmSigner.GetAddresses(context.Background(), string(svmNetwork))[0], svmNetwork)
	}
	fmt.Printf("   Discovery endpoint: GET /discovery/resources\n")
	fmt.Println()

	return r.Run(":" + defaultPort)
}
