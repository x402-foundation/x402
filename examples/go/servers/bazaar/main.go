package main

import (
	"fmt"
	"net/http"
	"os"
	"time"

	x402http "github.com/coinbase/x402/go/http"
	"github.com/coinbase/x402/go/extensions/bazaar"
	"github.com/coinbase/x402/go/extensions/types"
	ginmw "github.com/coinbase/x402/go/http/gin"
	evm "github.com/coinbase/x402/go/mechanisms/evm/exact/server"
	svm "github.com/coinbase/x402/go/mechanisms/svm/exact/server"
	ginfw "github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
)

const (
	DefaultPort = "4021"
)

func main() {
	godotenv.Load()

	evmAddress := os.Getenv("EVM_PAYEE_ADDRESS")
	if evmAddress == "" {
		fmt.Println("EVM_PAYEE_ADDRESS environment variable is required")
		os.Exit(1)
	}

	svmAddress := os.Getenv("SVM_PAYEE_ADDRESS")
	if svmAddress == "" {
		fmt.Println("SVM_PAYEE_ADDRESS environment variable is required")
		os.Exit(1)
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("FACILITATOR_URL environment variable is required")
		os.Exit(1)
	}

	fmt.Printf("Starting Bazaar discovery example server...\n")
	fmt.Printf("  EVM Payee: %s\n", evmAddress)
	fmt.Printf("  SVM Payee: %s\n", svmAddress)
	fmt.Printf("  Facilitator: %s\n", facilitatorURL)

	r := ginfw.Default()

	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	paymentOptions := x402http.PaymentOptions{
		{Scheme: "exact", Price: "$0.001", Network: "eip155:84532", PayTo: evmAddress},
		{Scheme: "exact", Price: "$0.001", Network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", PayTo: svmAddress},
	}

	// Single path param: /weather/:city
	weatherByCityExt, err := bazaar.DeclareDiscoveryExtension(
		bazaar.MethodGET, nil, nil, "",
		&types.OutputConfig{
			Example: map[string]interface{}{"city": "san-francisco", "weather": "foggy", "temperature": 60},
		},
		bazaar.DeclareDiscoveryExtensionOpts{
			PathParamsSchema: types.JSONSchema{
				"properties": map[string]interface{}{
					"city": map[string]interface{}{"type": "string", "description": "City name slug"},
				},
				"required": []string{"city"},
			},
		},
	)
	if err != nil {
		fmt.Printf("Error declaring discovery extension: %v\n", err)
		os.Exit(1)
	}

	// Multiple path params: /weather/:country/:city
	// Param names are matched by position in the URL, not by declaration order in the schema.
	// /weather/us/san-francisco -> { country: "us", city: "san-francisco" }
	weatherByCountryCityExt, err := bazaar.DeclareDiscoveryExtension(
		bazaar.MethodGET, nil, nil, "",
		&types.OutputConfig{
			Example: map[string]interface{}{"country": "us", "city": "san-francisco", "weather": "foggy", "temperature": 60},
		},
		bazaar.DeclareDiscoveryExtensionOpts{
			PathParamsSchema: types.JSONSchema{
				"properties": map[string]interface{}{
					"country": map[string]interface{}{"type": "string", "description": "Country code"},
					"city":    map[string]interface{}{"type": "string", "description": "City name slug"},
				},
				"required": []string{"country", "city"},
			},
		},
	)
	if err != nil {
		fmt.Printf("Error declaring discovery extension: %v\n", err)
		os.Exit(1)
	}

	routes := x402http.RoutesConfig{
		"GET /weather/:city": {
			Accepts:     paymentOptions,
			Description: "Weather data for a city",
			MimeType:    "application/json",
			Extensions:  map[string]interface{}{bazaar.BAZAAR.Key(): weatherByCityExt},
		},
		"GET /weather/:country/:city": {
			Accepts:     paymentOptions,
			Description: "Weather data for a city in a specific country",
			MimeType:    "application/json",
			Extensions:  map[string]interface{}{bazaar.BAZAAR.Key(): weatherByCountryCityExt},
		},
	}

	r.Use(ginmw.X402Payment(ginmw.Config{
		Routes:      routes,
		Facilitator: facilitatorClient,
		Schemes: []ginmw.SchemeConfig{
			{Network: "eip155:84532", Server: evm.NewExactEvmScheme()},
			{Network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", Server: svm.NewExactSvmScheme()},
		},
		Timeout: 30 * time.Second,
	}))

	r.GET("/weather/:city", func(c *ginfw.Context) {
		city := c.Param("city")
		weatherData := map[string]map[string]interface{}{
			"san-francisco": {"weather": "foggy", "temperature": 60},
			"new-york":      {"weather": "cloudy", "temperature": 55},
			"tokyo":         {"weather": "rainy", "temperature": 65},
		}
		data, exists := weatherData[city]
		if !exists {
			data = map[string]interface{}{"weather": "sunny", "temperature": 70}
		}
		c.JSON(http.StatusOK, ginfw.H{"city": city, "weather": data["weather"], "temperature": data["temperature"]})
	})

	r.GET("/weather/:country/:city", func(c *ginfw.Context) {
		country := c.Param("country")
		city := c.Param("city")
		weatherData := map[string]map[string]map[string]interface{}{
			"us": {
				"san-francisco": {"weather": "foggy", "temperature": 60},
				"new-york":      {"weather": "cloudy", "temperature": 55},
			},
			"jp": {
				"tokyo": {"weather": "rainy", "temperature": 65},
				"osaka": {"weather": "clear", "temperature": 72},
			},
		}
		data, exists := weatherData[country][city]
		if !exists {
			data = map[string]interface{}{"weather": "sunny", "temperature": 70}
		}
		c.JSON(http.StatusOK, ginfw.H{"country": country, "city": city, "weather": data["weather"], "temperature": data["temperature"]})
	})

	r.GET("/health", func(c *ginfw.Context) {
		c.JSON(http.StatusOK, ginfw.H{"status": "ok"})
	})

	fmt.Printf("  Listening on http://localhost:%s\n\n", DefaultPort)

	if err := r.Run(":" + DefaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
