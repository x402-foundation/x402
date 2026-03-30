package bazaar

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	x402http "github.com/coinbase/x402/go/http"
)

// testAuthProvider is a test helper that returns fixed auth headers.
type testAuthProvider struct {
	headers x402http.AuthHeaders
	err     error
}

func (p *testAuthProvider) GetAuthHeaders(_ context.Context) (x402http.AuthHeaders, error) {
	return p.headers, p.err
}

func TestWithBazaar(t *testing.T) {
	client := x402http.NewHTTPFacilitatorClient(nil)
	bazaarClient := WithBazaar(client)

	if bazaarClient == nil {
		t.Fatal("Expected non-nil bazaar client")
	}
	if bazaarClient.HTTPFacilitatorClient != client {
		t.Error("Expected embedded client to match original")
	}
}

func TestWithBazaar_PreservesOriginalMethods(t *testing.T) {
	client := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: "https://example.com/facilitator",
	})
	bazaarClient := WithBazaar(client)

	// Verify the wrapped client preserves the URL
	if bazaarClient.URL() != "https://example.com/facilitator" {
		t.Errorf("Expected URL https://example.com/facilitator, got %s", bazaarClient.URL())
	}
}

func TestListDiscoveryResources_Success(t *testing.T) {
	ctx := context.Background()

	expectedResponse := DiscoveryResourcesResponse{
		X402Version: 2,
		Items: []DiscoveryResource{
			{
				Resource:    "https://api.example.com/data",
				Type:        "http",
				X402Version: 2,
				Accepts:     []json.RawMessage{json.RawMessage(`{"scheme":"exact","network":"eip155:1"}`)},
				LastUpdated: "2026-03-01T00:00:00Z",
				Metadata:    map[string]any{"category": "data"},
			},
		},
		Pagination: Pagination{
			Limit:  20,
			Offset: 0,
			Total:  1,
		},
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/discovery/resources" {
			t.Errorf("Expected path /discovery/resources, got %s", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("Expected GET method, got %s", r.Method)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Expected Content-Type application/json, got %s", r.Header.Get("Content-Type"))
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(expectedResponse)
	}))
	defer server.Close()

	client := WithBazaar(x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: server.URL,
	}))

	result, err := client.ListDiscoveryResources(ctx, nil)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if result.X402Version != 2 {
		t.Errorf("Expected x402Version 2, got %d", result.X402Version)
	}
	if len(result.Items) != 1 {
		t.Fatalf("Expected 1 item, got %d", len(result.Items))
	}
	if result.Items[0].Resource != "https://api.example.com/data" {
		t.Errorf("Expected resource URL https://api.example.com/data, got %s", result.Items[0].Resource)
	}
	if result.Items[0].Type != "http" {
		t.Errorf("Expected type http, got %s", result.Items[0].Type)
	}
	if result.Items[0].X402Version != 2 {
		t.Errorf("Expected item x402Version 2, got %d", result.Items[0].X402Version)
	}
	if result.Items[0].LastUpdated != "2026-03-01T00:00:00Z" {
		t.Errorf("Expected lastUpdated 2026-03-01T00:00:00Z, got %s", result.Items[0].LastUpdated)
	}
	if result.Items[0].Metadata["category"] != "data" {
		t.Errorf("Expected metadata category=data, got %v", result.Items[0].Metadata["category"])
	}
	if result.Pagination.Limit != 20 {
		t.Errorf("Expected pagination limit 20, got %d", result.Pagination.Limit)
	}
	if result.Pagination.Total != 1 {
		t.Errorf("Expected pagination total 1, got %d", result.Pagination.Total)
	}
}

func TestListDiscoveryResources_WithParams(t *testing.T) {
	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()

		if query.Get("type") != "http" {
			t.Errorf("Expected type=http, got %s", query.Get("type"))
		}
		if query.Get("limit") != "10" {
			t.Errorf("Expected limit=10, got %s", query.Get("limit"))
		}
		if query.Get("offset") != "5" {
			t.Errorf("Expected offset=5, got %s", query.Get("offset"))
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(DiscoveryResourcesResponse{
			X402Version: 2,
			Items:       []DiscoveryResource{},
			Pagination:  Pagination{Limit: 10, Offset: 5, Total: 0},
		})
	}))
	defer server.Close()

	client := WithBazaar(x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: server.URL,
	}))

	result, err := client.ListDiscoveryResources(ctx, &ListDiscoveryResourcesParams{
		Type:   "http",
		Limit:  10,
		Offset: 5,
	})
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if result.Pagination.Limit != 10 {
		t.Errorf("Expected pagination limit 10, got %d", result.Pagination.Limit)
	}
	if result.Pagination.Offset != 5 {
		t.Errorf("Expected pagination offset 5, got %d", result.Pagination.Offset)
	}
}

func TestListDiscoveryResources_NoParams(t *testing.T) {
	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" {
			t.Errorf("Expected no query params, got %s", r.URL.RawQuery)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(DiscoveryResourcesResponse{
			X402Version: 2,
			Items:       []DiscoveryResource{},
			Pagination:  Pagination{Limit: 20, Offset: 0, Total: 0},
		})
	}))
	defer server.Close()

	client := WithBazaar(x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: server.URL,
	}))

	_, err := client.ListDiscoveryResources(ctx, nil)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
}

func TestListDiscoveryResources_PartialParams(t *testing.T) {
	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()

		if query.Get("type") != "mcp" {
			t.Errorf("Expected type=mcp, got %s", query.Get("type"))
		}
		// limit and offset should not be set when zero
		if query.Has("limit") {
			t.Errorf("Expected no limit param, got %s", query.Get("limit"))
		}
		if query.Has("offset") {
			t.Errorf("Expected no offset param, got %s", query.Get("offset"))
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(DiscoveryResourcesResponse{
			X402Version: 2,
			Items:       []DiscoveryResource{},
			Pagination:  Pagination{Limit: 20, Offset: 0, Total: 0},
		})
	}))
	defer server.Close()

	client := WithBazaar(x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: server.URL,
	}))

	_, err := client.ListDiscoveryResources(ctx, &ListDiscoveryResourcesParams{
		Type: "mcp",
	})
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
}

func TestListDiscoveryResources_ErrorResponse(t *testing.T) {
	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("internal server error"))
	}))
	defer server.Close()

	client := WithBazaar(x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: server.URL,
	}))

	_, err := client.ListDiscoveryResources(ctx, nil)
	if err == nil {
		t.Fatal("Expected error for 500 response")
	}

	expected := "facilitator listDiscoveryResources failed (500): internal server error"
	if err.Error() != expected {
		t.Errorf("Expected error message %q, got %q", expected, err.Error())
	}
}

func TestListDiscoveryResources_NotFound(t *testing.T) {
	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
	}))
	defer server.Close()

	client := WithBazaar(x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: server.URL,
	}))

	_, err := client.ListDiscoveryResources(ctx, nil)
	if err == nil {
		t.Fatal("Expected error for 404 response")
	}

	expected := "facilitator listDiscoveryResources failed (404): not found"
	if err.Error() != expected {
		t.Errorf("Expected error message %q, got %q", expected, err.Error())
	}
}

func TestListDiscoveryResources_InvalidJSON(t *testing.T) {
	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"x402Version":`))
	}))
	defer server.Close()

	client := WithBazaar(x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: server.URL,
	}))

	_, err := client.ListDiscoveryResources(ctx, nil)
	if err == nil {
		t.Fatal("Expected error for invalid JSON response")
	}
}

func TestListDiscoveryResources_WithAuthHeaders(t *testing.T) {
	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-token" {
			t.Errorf("Expected Authorization header 'Bearer test-token', got %q", auth)
		}

		apiKey := r.Header.Get("X-Api-Key")
		if apiKey != "my-key" {
			t.Errorf("Expected X-Api-Key header 'my-key', got %q", apiKey)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(DiscoveryResourcesResponse{
			X402Version: 2,
			Items:       []DiscoveryResource{},
			Pagination:  Pagination{Limit: 20, Offset: 0, Total: 0},
		})
	}))
	defer server.Close()

	authProvider := &testAuthProvider{
		headers: x402http.AuthHeaders{
			Discovery: map[string]string{
				"Authorization": "Bearer test-token",
				"X-Api-Key":     "my-key",
			},
		},
	}

	client := WithBazaar(x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL:          server.URL,
		AuthProvider: authProvider,
	}))

	_, err := client.ListDiscoveryResources(ctx, nil)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
}

func TestListDiscoveryResources_NoAuthProvider(t *testing.T) {
	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Should not have Authorization header when no auth provider
		if r.Header.Get("Authorization") != "" {
			t.Errorf("Expected no Authorization header, got %q", r.Header.Get("Authorization"))
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(DiscoveryResourcesResponse{
			X402Version: 2,
			Items:       []DiscoveryResource{},
			Pagination:  Pagination{Limit: 20, Offset: 0, Total: 0},
		})
	}))
	defer server.Close()

	client := WithBazaar(x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: server.URL,
	}))

	_, err := client.ListDiscoveryResources(ctx, nil)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
}

func TestListDiscoveryResources_AuthProviderError(t *testing.T) {
	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("Request should not have been made when auth provider fails")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	authProvider := &testAuthProvider{
		err: http.ErrAbortHandler,
	}

	client := WithBazaar(x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL:          server.URL,
		AuthProvider: authProvider,
	}))

	_, err := client.ListDiscoveryResources(ctx, nil)
	if err == nil {
		t.Fatal("Expected error when auth provider fails")
	}
}

func TestListDiscoveryResources_MultipleItems(t *testing.T) {
	ctx := context.Background()

	expectedResponse := DiscoveryResourcesResponse{
		X402Version: 2,
		Items: []DiscoveryResource{
			{
				Resource:    "https://api.example.com/endpoint1",
				Type:        "http",
				X402Version: 2,
				Accepts:     []json.RawMessage{json.RawMessage(`{"scheme":"exact"}`)},
				LastUpdated: "2026-03-01T00:00:00Z",
			},
			{
				Resource:    "https://api.example.com/endpoint2",
				Type:        "http",
				X402Version: 1,
				Accepts:     []json.RawMessage{json.RawMessage(`{"scheme":"exact"}`)},
				LastUpdated: "2026-02-28T00:00:00Z",
			},
			{
				Resource:    "mcp://tools/search",
				Type:        "mcp",
				X402Version: 2,
				Accepts:     []json.RawMessage{json.RawMessage(`{"scheme":"exact"}`)},
				LastUpdated: "2026-03-01T12:00:00Z",
			},
		},
		Pagination: Pagination{
			Limit:  20,
			Offset: 0,
			Total:  3,
		},
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(expectedResponse)
	}))
	defer server.Close()

	client := WithBazaar(x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: server.URL,
	}))

	result, err := client.ListDiscoveryResources(ctx, nil)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if len(result.Items) != 3 {
		t.Fatalf("Expected 3 items, got %d", len(result.Items))
	}
	if result.Items[0].Resource != "https://api.example.com/endpoint1" {
		t.Errorf("Expected first resource https://api.example.com/endpoint1, got %s", result.Items[0].Resource)
	}
	if result.Items[2].Type != "mcp" {
		t.Errorf("Expected third resource type mcp, got %s", result.Items[2].Type)
	}
	if result.Pagination.Total != 3 {
		t.Errorf("Expected total 3, got %d", result.Pagination.Total)
	}
}

func TestListDiscoveryResources_ContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("Request should not have been made with cancelled context")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := WithBazaar(x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: server.URL,
	}))

	_, err := client.ListDiscoveryResources(ctx, nil)
	if err == nil {
		t.Fatal("Expected error with cancelled context")
	}
}

func TestListDiscoveryResources_ConnectionError(t *testing.T) {
	ctx := context.Background()

	// Use a URL that will fail to connect
	client := WithBazaar(x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: "http://127.0.0.1:1", // Port 1 should fail
	}))

	_, err := client.ListDiscoveryResources(ctx, nil)
	if err == nil {
		t.Fatal("Expected error for connection failure")
	}
}
