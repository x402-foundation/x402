package bazaar

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/x402-foundation/x402/go/v2/extensions/types"
	x402http "github.com/x402-foundation/x402/go/v2/http"
)

func captureStartupValidationStdout(f func()) string {
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	f()
	w.Close()
	os.Stdout = old
	var buf bytes.Buffer
	_, _ = io.Copy(&buf, r)
	return buf.String()
}

func TestValidateBazaarRouteExtensions_NoBazaar(t *testing.T) {
	routes := x402http.RoutesConfig{
		"GET /api": {
			Accepts: x402http.PaymentOptions{
				{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:8453"},
			},
		},
	}

	output := captureStartupValidationStdout(func() {
		ValidateBazaarRouteExtensions(routes)
	})

	assert.NotContains(t, output, "Warning")
	assert.NotContains(t, output, "bazaar")
}

func TestValidateBazaarRouteExtensions_ValidExtension(t *testing.T) {
	routes := x402http.RoutesConfig{
		"GET /api": {
			Accepts: x402http.PaymentOptions{
				{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:8453"},
			},
			Extensions: map[string]interface{}{
				"bazaar": map[string]interface{}{
					"info": map[string]interface{}{
						"input": map[string]interface{}{
							"type":   "http",
							"method": "GET",
						},
					},
					"schema": map[string]interface{}{
						"type": "object",
						"properties": map[string]interface{}{
							"input": map[string]interface{}{"type": "object"},
						},
						"required": []interface{}{"input"},
					},
				},
			},
		},
	}

	output := captureStartupValidationStdout(func() {
		ValidateBazaarRouteExtensions(routes)
	})

	assert.NotContains(t, output, "Warning")
	assert.NotContains(t, output, "invalid")
}

func TestValidateBazaarRouteExtensions_InvalidExtension(t *testing.T) {
	routes := x402http.RoutesConfig{
		"GET /api": {
			Accepts: x402http.PaymentOptions{
				{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:8453"},
			},
			Extensions: map[string]interface{}{
				"bazaar": map[string]interface{}{
					"info": map[string]interface{}{
						"input": map[string]interface{}{
							"type":   "http",
							"method": "GET",
						},
					},
					"schema": map[string]interface{}{
						"type": "object",
						"properties": map[string]interface{}{
							"input": map[string]interface{}{"type": "object"},
							"jobs":  map[string]interface{}{"type": "array"},
							"count": map[string]interface{}{"type": "integer"},
						},
						"required": []interface{}{"input", "jobs", "count"},
					},
				},
			},
		},
	}

	output := captureStartupValidationStdout(func() {
		ValidateBazaarRouteExtensions(routes)
	})

	assert.Contains(t, output, "Warning")
	assert.Contains(t, output, "bazaar")
}

func TestValidateBazaarRouteExtensions_MalformedExtension(t *testing.T) {
	routes := x402http.RoutesConfig{
		"GET /api": {
			Accepts: x402http.PaymentOptions{
				{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:8453"},
			},
			Extensions: map[string]interface{}{
				"bazaar": "not-an-object",
			},
		},
	}

	output := captureStartupValidationStdout(func() {
		ValidateBazaarRouteExtensions(routes)
	})

	assert.Contains(t, output, "Warning")
	assert.Contains(t, output, "malformed")
}

func TestValidateBazaarRouteExtensions_DeclareDiscoveryExtensionGET(t *testing.T) {
	extension, err := DeclareDiscoveryExtension(
		MethodGET,
		map[string]interface{}{"city": "San Francisco"},
		types.JSONSchema{
			"properties": map[string]interface{}{
				"city": map[string]interface{}{"type": "string"},
			},
			"required": []string{"city"},
		},
		"",
		&types.OutputConfig{
			Example: map[string]interface{}{
				"weather":     "sunny",
				"temperature": 70,
			},
			Schema: types.JSONSchema{
				"properties": map[string]interface{}{
					"weather":     map[string]interface{}{"type": "string"},
					"temperature": map[string]interface{}{"type": "number"},
				},
				"required": []string{"weather", "temperature"},
			},
		},
	)
	require.NoError(t, err)

	routes := x402http.RoutesConfig{
		"GET /weather": {
			Accepts: x402http.PaymentOptions{
				{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:8453"},
			},
			Extensions: map[string]interface{}{
				BAZAAR.Key(): extension,
			},
		},
	}

	output := captureStartupValidationStdout(func() {
		ValidateBazaarRouteExtensions(routes)
	})

	assert.NotContains(t, output, "Warning")
}

func TestValidateBazaarRouteExtensions_PreEnrichmentWithoutMethod(t *testing.T) {
	ext := types.DiscoveryExtension{
		Info: types.DiscoveryInfo{
			Input: types.QueryInput{
				Type:        "http",
				QueryParams: map[string]interface{}{"city": "San Francisco"},
			},
		},
		Schema: types.JSONSchema{
			"type": "object",
			"properties": map[string]interface{}{
				"input": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"type":   map[string]interface{}{"type": "string", "const": "http"},
						"method": map[string]interface{}{"type": "string", "enum": []string{"GET", "HEAD", "DELETE"}},
						"queryParams": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"city": map[string]interface{}{"type": "string"},
							},
							"required": []string{"city"},
						},
					},
					"required":             []string{"type", "method"},
					"additionalProperties": false,
				},
			},
			"required": []string{"input"},
		},
	}

	routes := x402http.RoutesConfig{
		"GET /weather": {
			Accepts: x402http.PaymentOptions{
				{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:8453"},
			},
			Extensions: map[string]interface{}{
				BAZAAR.Key(): ext,
			},
		},
	}

	output := captureStartupValidationStdout(func() {
		ValidateBazaarRouteExtensions(routes)
	})

	assert.NotContains(t, output, "Warning")
}

func TestValidateBazaarRouteExtensions_PostBodyWithoutRouteVerb(t *testing.T) {
	extension, err := DeclareDiscoveryExtension(
		MethodPOST,
		map[string]interface{}{"name": "John"},
		types.JSONSchema{
			"properties": map[string]interface{}{
				"name": map[string]interface{}{"type": "string"},
			},
			"required": []string{"name"},
		},
		types.BodyTypeJSON,
		&types.OutputConfig{
			Example: map[string]interface{}{"success": true},
		},
	)
	require.NoError(t, err)

	extMap := map[string]interface{}{}
	extJSON, err := json.Marshal(extension)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(extJSON, &extMap))
	info := extMap["info"].(map[string]interface{})
	input := info["input"].(map[string]interface{})
	delete(input, "method")

	routes := x402http.RoutesConfig{
		"*": {
			Accepts: x402http.PaymentOptions{
				{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:8453"},
			},
			Extensions: map[string]interface{}{
				BAZAAR.Key(): extMap,
			},
		},
	}

	output := captureStartupValidationStdout(func() {
		ValidateBazaarRouteExtensions(routes)
	})

	assert.NotContains(t, output, "Warning")
}

func TestWithSyntheticMethod_LeavesExistingMethodUnchanged(t *testing.T) {
	ext := types.DiscoveryExtension{
		Info: types.DiscoveryInfo{
			Input: types.QueryInput{
				Type:   "http",
				Method: types.MethodDELETE,
			},
		},
	}

	result := withSyntheticMethod(ext, "GET /api")
	input, ok := result.Info.Input.(types.QueryInput)
	require.True(t, ok)
	assert.Equal(t, types.MethodDELETE, input.Method)
}

func TestWithSyntheticMethod_InjectsFromRoutePattern(t *testing.T) {
	ext := types.DiscoveryExtension{
		Info: types.DiscoveryInfo{
			Input: types.QueryInput{
				Type:        "http",
				QueryParams: map[string]interface{}{"city": "sf"},
			},
		},
	}

	result := withSyntheticMethod(ext, "GET /weather")
	input, ok := result.Info.Input.(types.QueryInput)
	require.True(t, ok)
	assert.Equal(t, types.MethodGET, input.Method)
}

func TestWithSyntheticMethod_InfersPostFromBody(t *testing.T) {
	ext := types.DiscoveryExtension{
		Info: types.DiscoveryInfo{
			Input: types.BodyInput{
				Type:     "http",
				BodyType: types.BodyTypeJSON,
				Body:     map[string]interface{}{"name": "John"},
			},
		},
	}

	result := withSyntheticMethod(ext, "*")
	input, ok := result.Info.Input.(types.BodyInput)
	require.True(t, ok)
	assert.Equal(t, types.MethodPOST, input.Method)
}
