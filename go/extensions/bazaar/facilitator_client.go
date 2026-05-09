package bazaar

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"

	x402http "github.com/x402-foundation/x402/go/http"
)

// ListDiscoveryResourcesParams contains optional filtering and pagination parameters
// for listing discovery resources from a facilitator's bazaar.
type ListDiscoveryResourcesParams struct {
	// Type filters by protocol type (e.g., "http", "mcp").
	Type string

	// PayTo filters by payment recipient address.
	PayTo string

	// Scheme filters by payment scheme (e.g., "exact").
	Scheme string

	// Network filters by payment network (e.g., "eip155:8453").
	Network string

	// Extensions filters by extension key present on the discovered resource.
	Extensions string

	// Limit is the number of discovered x402 resources to return per page.
	Limit int

	// Offset is the offset of the first discovered x402 resource to return.
	Offset int
}

// SearchDiscoveryResourcesParams contains parameters for searching discovery resources.
type SearchDiscoveryResourcesParams struct {
	// Query is the natural-language search query (required).
	Query string

	// Type filters by protocol type (e.g., "http", "mcp").
	Type string

	// PayTo filters by payment recipient address.
	PayTo string

	// Scheme filters by payment scheme (e.g., "exact").
	Scheme string

	// Network filters by payment network (e.g., "eip155:8453").
	Network string

	// Extensions filters by extension key present on the discovered resource.
	Extensions string

	// Limit is an advisory maximum number of results. The server may return fewer or ignore this.
	Limit int

	// Cursor is an advisory continuation token from a previous response. The server may ignore this.
	Cursor string
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

	// Extensions contains additional extension payloads for this discovered resource.
	Extensions map[string]any `json:"extensions,omitempty"`
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

// SearchPagination describes pagination details for a paginated search response.
type SearchPagination struct {
	// Limit is the number of results in this page.
	Limit int `json:"limit"`

	// Cursor is a continuation token for the next page; may be nil.
	Cursor *string `json:"cursor"`
}

// SearchDiscoveryResourcesResponse is the response from searching discovery resources.
type SearchDiscoveryResourcesResponse struct {
	// X402Version is the x402 protocol version of this response.
	X402Version int `json:"x402Version"`

	// Resources is the list of matching discovered resources.
	Resources []DiscoveryResource `json:"resources"`

	// PartialResults indicates additional matches were truncated by facilitator.
	PartialResults bool `json:"partialResults,omitempty"`

	// Pagination contains optional pagination details for paginated responses.
	Pagination *SearchPagination `json:"pagination,omitempty"`
}

// BazaarFacilitatorClient wraps an HTTPFacilitatorClient with bazaar discovery
// query functionality. It preserves all original facilitator client capabilities
// (Verify, Settle, GetSupported) and adds the ability to list and search discovered
// x402 resources from the facilitator's bazaar.
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
//	results, err := client.SearchDiscoveryResources(ctx, &bazaar.SearchDiscoveryResourcesParams{
//	    Query: "weather APIs",
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
		for k, v := range authHeaders.Bazaar {
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

// SearchDiscoveryResources queries the facilitator's /discovery/search endpoint
// to search x402 discovery resources from the bazaar using a natural-language query.
//
// Pagination is optional: facilitators may ignore Limit/Cursor in params, or include
// response.pagination when pagination is used.
func (c *BazaarFacilitatorClient) SearchDiscoveryResources(
	ctx context.Context,
	params *SearchDiscoveryResourcesParams,
) (*SearchDiscoveryResourcesResponse, error) {
	if params == nil || params.Query == "" {
		return nil, fmt.Errorf("search query is required")
	}

	endpoint, err := c.buildSearchURL(params)
	if err != nil {
		return nil, fmt.Errorf("failed to build search URL: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create search request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	authProvider := c.GetAuthProvider()
	if authProvider != nil {
		authHeaders, err := authProvider.GetAuthHeaders(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to get auth headers: %w", err)
		}
		for k, v := range authHeaders.Bazaar {
			req.Header.Set(k, v)
		}
	}

	resp, err := c.HTTPClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("search request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("facilitator searchDiscoveryResources failed (%d): %s", resp.StatusCode, string(body))
	}

	var result SearchDiscoveryResourcesResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to decode search response: %w", err)
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
	if params.PayTo != "" {
		q.Set("payTo", params.PayTo)
	}
	if params.Scheme != "" {
		q.Set("scheme", params.Scheme)
	}
	if params.Network != "" {
		q.Set("network", params.Network)
	}
	if params.Extensions != "" {
		q.Set("extensions", params.Extensions)
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

// buildSearchURL constructs the full /discovery/search URL with query parameters.
func (c *BazaarFacilitatorClient) buildSearchURL(params *SearchDiscoveryResourcesParams) (string, error) {
	base := c.URL() + "/discovery/search"

	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}

	q := u.Query()
	q.Set("query", params.Query)
	if params.Type != "" {
		q.Set("type", params.Type)
	}
	if params.PayTo != "" {
		q.Set("payTo", params.PayTo)
	}
	if params.Scheme != "" {
		q.Set("scheme", params.Scheme)
	}
	if params.Network != "" {
		q.Set("network", params.Network)
	}
	if params.Extensions != "" {
		q.Set("extensions", params.Extensions)
	}
	if params.Limit > 0 {
		q.Set("limit", strconv.Itoa(params.Limit))
	}
	if params.Cursor != "" {
		q.Set("cursor", params.Cursor)
	}

	u.RawQuery = q.Encode()
	return u.String(), nil
}
