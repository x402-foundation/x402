package main

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/http/httputil"
	"net/url"
	"os"

	"github.com/gin-gonic/gin"
	x402gin "github.com/x402-foundation/x402/go/pkg/gin"
	"github.com/x402-foundation/x402/go/pkg/types"
)

func main() {
	gin.SetMode(gin.ReleaseMode)
	argv := os.Args[1:]

	if len(argv) == 0 {
		fmt.Println("Please provide a config file path as an argument")
		os.Exit(1)
	}

	config, err := loadConfig(argv[0])
	if err != nil {
		fmt.Printf("Error loading config: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Running with config: %+v\n", config)

	r := gin.Default()

	facilitatorConfig := &types.FacilitatorConfig{
		URL:               config.FacilitatorURL,
		CreateAuthHeaders: config.CreateAuthHeaders,
	}

	r.Any("/*path",
		x402gin.PaymentMiddleware(
			big.NewFloat(config.Amount),
			config.PayTo,
			x402gin.WithFacilitatorConfig(facilitatorConfig),
			x402gin.WithResource(config.TargetURL),
			x402gin.WithTestnet(config.Testnet),
			x402gin.WithDescription(config.Description),
			x402gin.WithMimeType(config.MimeType),
			x402gin.WithMaxTimeoutSeconds(config.MaxTimeoutSeconds),
		),
		proxyHandler(config.TargetURL, config.Headers))

	err = r.Run(":4021")
	if err != nil {
		fmt.Printf("Error running server: %v\n", err)
		os.Exit(1)
	}
}

type ProxyConfig struct {
	TargetURL         string                                       `json:"targetURL"`
	Amount            float64                                      `json:"amount"`
	PayTo             string                                       `json:"payTo"`
	Description       string                                       `json:"description"`
	FacilitatorURL    string                                       `json:"facilitatorURL"`
	MimeType          string                                       `json:"mimeType"`
	MaxTimeoutSeconds int                                          `json:"maxTimeoutSeconds"`
	Testnet           bool                                         `json:"testnet"`
	Headers           map[string]string                            `json:"headers"`
	CreateAuthHeaders func() (map[string]map[string]string, error) `json:"-"`
}

func proxyHandler(targetURL string, headers map[string]string) gin.HandlerFunc {
	fmt.Println("Proxying to:", targetURL)

	target, err := url.Parse(targetURL)
	if err != nil {
		fmt.Println("Error parsing target URL:", err)
		panic(err)
	}

	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)

			// Copy only essential headers
			if userAgent := pr.In.Header.Get("User-Agent"); userAgent != "" {
				pr.Out.Header.Set("User-Agent", userAgent)
			}
			if accept := pr.In.Header.Get("Accept"); accept != "" {
				pr.Out.Header.Set("Accept", accept)
			}

			// Copy request body if present
			if pr.In.Body != nil {
				pr.Out.Body = pr.In.Body
				pr.Out.ContentLength = pr.In.ContentLength
			}
		},
	}

	return func(c *gin.Context) {
		// Add any configured headers
		for k, v := range headers {
			c.Request.Header.Set(k, v)
		}

		// Remove any payment headers
		delete(c.Request.Header, "X-Payment")
		proxy.ServeHTTP(c.Writer, c.Request)
	}
}

func loadConfig(configPath string) (*ProxyConfig, error) {
	config := &ProxyConfig{
		// default values
		FacilitatorURL:    "https://x402.org/facilitator",
		Testnet:           true,
		MaxTimeoutSeconds: 60,
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("error reading config file: %w", err)
	}

	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("error parsing config file: %w", err)
	}

	if config.TargetURL == "" || config.Amount == 0 || config.PayTo == "" {
		return nil, fmt.Errorf("config is missing required fields")
	}

	return config, nil
}
