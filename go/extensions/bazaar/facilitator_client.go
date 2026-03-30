package bazaar

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"

	x402http "github.com/coinbase/x402/go/http"
)

// ListDiscoveryResourcesParams contains optional filtering and pagination parameters
// for listing discovery resources from a facilitator's bazaar.
type ListDiscoveryResourcesParams struct {
	// Type filters by protocol type (e.g., "http", "mcp").
	Type string

	// Limit is the number of discovered x402 resources to return per page.
	Limit int

	// Offset is the offset of the first discovered x402 resource to return.
	Offset int
}

// DiscoveryResource represents a discovered x402 resource from the bazaar.
type DiscoveryResource struct {
	// Resource is the URL or identifier of the discovered resource.
	Resource string `json:"resource"`

	// Type is the protocol type of the resource (e.g., "http").
	Type string `json:"type"`

	// X402Version is the x402 protocol version supported by this resource.
	X402Version int `json:"x402Version"`

	// Accepts is an array of accepted payment methods for this resource.
	Accepts []json.RawMessage `json:"accepts"`

	// LastUpdated is an ISO 8601 timestamp of when the resource was last updated.
	LastUpdated string `json:"lastUpdated"`

	// Metadata contains additional metadata about the resource.
	Metadata map[string]any `json:"metadata,omitempty"`
}

// Pagination contains pagination information for a discovery resources response.
type Pagination struct {
	// Limit is the maximum number of results returned.
	Limit int `json:"limit"`

	// Offset is the number of results skipped.
	Offset int `json:"offset"`

	// Total is the total count of resources matching the query.
	Total int `json:"total"`
}

// DiscoveryResourcesResponse is the response from listing discovery resources.
type DiscoveryResourcesResponse struct {
	// X402Version is the x402 protocol version of this response.
	X402Version int `json:"x402Version"`

	// Items is the list of discovered resources.
	Items []DiscoveryResource `json:"items"`

	// Pagination contains pagination information for the response.
	Pagination Pagination `json:"pagination"`
}

// BazaarFacilitatorClient wraps an HTTPFacilitatorClient with bazaar discovery
// query functionality. It preserves all original facilitator client capabilities
// (Verify, Settle, GetSupported) and adds the ability to list discovered x402
// resources from the facilitator's bazaar.
type BazaarFacilitatorClient struct {
	*x402http.HTTPFacilitatorClient
}

// WithBazaar extends a facilitator client with bazaar discovery query functionality.
//
// Example:
//
//	client := bazaar.WithBazaar(http.NewHTTPFacilitatorClient(nil))
//	resources, err := client.ListDiscoveryResources(ctx, &bazaar.ListDiscoveryResourcesParams{
//	    Type: "http",
//	    Limit: 20,
//	})
func WithBazaar(client *x402http.HTTPFacilitatorClient) *BazaarFacilitatorClient {
	return &BazaarFacilitatorClient{HTTPFacilitatorClient: client}
}

// ListDiscoveryResources queries the facilitator's /discovery/resources endpoint
// to list x402 discovery resources from the bazaar.
//
// Params may be nil to list all resources without filtering.
func (c *BazaarFacilitatorClient) ListDiscoveryResources(
	ctx context.Context,
	params *ListDiscoveryResourcesParams,
) (*DiscoveryResourcesResponse, error) {
	// Build URL with query parameters
	endpoint, err := c.buildDiscoveryURL(params)
	if err != nil {
		return nil, fmt.Errorf("failed to build discovery URL: %w", err)
	}

	// Create request
	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create discovery request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	// Add auth headers if available
	authProvider := c.GetAuthProvider()
	if authProvider != nil {
		authHeaders, err := authProvider.GetAuthHeaders(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to get auth headers: %w", err)
		}
		for k, v := range authHeaders.Discovery {
			req.Header.Set(k, v)
		}
	}

	// Make request
	resp, err := c.HTTPClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("discovery request failed: %w", err)
	}
	defer resp.Body.Close()

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Check for error response
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("facilitator listDiscoveryResources failed (%d): %s", resp.StatusCode, string(body))
	}

	// Parse response
	var result DiscoveryResourcesResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to decode discovery response: %w", err)
	}

	return &result, nil
}

// buildDiscoveryURL constructs the full /discovery/resources URL with query parameters.
func (c *BazaarFacilitatorClient) buildDiscoveryURL(params *ListDiscoveryResourcesParams) (string, error) {
	base := c.URL() + "/discovery/resources"

	if params == nil {
		return base, nil
	}

	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}

	q := u.Query()
	if params.Type != "" {
		q.Set("type", params.Type)
	}
	if params.Limit > 0 {
		q.Set("limit", strconv.Itoa(params.Limit))
	}
	if params.Offset > 0 {
		q.Set("offset", strconv.Itoa(params.Offset))
	}

	u.RawQuery = q.Encode()
	return u.String(), nil
}
