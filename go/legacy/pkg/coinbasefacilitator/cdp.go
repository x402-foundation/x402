package coinbasefacilitator

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/coinbase/cdp-sdk/go/auth"
	"github.com/x402-foundation/x402/go/pkg/types"
)

// SDKVersion represents the current version of the SDK
const SDKVersion = "0.0.0"

// CreateAuthHeader creates an authorization header for a request to the Coinbase API.
//
// Parameters:
//   - apiKeyId: The api key ID
//   - apiKeySecret: The api key secret
//   - requestHost: The host for the request (e.g. 'https://x402.org/facilitator')
//   - requestPath: The path for the request (e.g. '/verify')
//
// Returns:
//   - The authorization header string and any error that occurred
func CreateAuthHeader(apiKeyId, apiKeySecret, requestHost, requestPath string) (string, error) {
	// Remove https:// if present
	requestHost = strings.TrimPrefix(requestHost, "https://")

	jwt, err := auth.GenerateJWT(auth.JwtOptions{
		KeyID:         apiKeyId,
		KeySecret:     apiKeySecret,
		RequestMethod: "POST",
		RequestHost:   requestHost,
		RequestPath:   requestPath,
	})
	if err != nil {
		fmt.Printf("JWT Generation Error: %v\n", err)
		return "", err
	}

	bearerToken := fmt.Sprintf("Bearer %s", jwt)

	return bearerToken, nil
}

// CreateCorrelationHeader creates a correlation header for a request to the Coinbase API.
//
// Returns:
//   - The correlation header string
func CreateCorrelationHeader() string {
	data := map[string]string{
		"sdk_version":    SDKVersion,
		"sdk_language":   "go",
		"source":         "x402",
		"source_version": types.Version,
	}

	var pairs []string
	for key, value := range data {
		pairs = append(pairs, fmt.Sprintf("%s=%s", key, url.QueryEscape(value)))
	}

	return strings.Join(pairs, ",")
}
