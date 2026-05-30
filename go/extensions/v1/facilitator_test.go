package v1

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/x402-foundation/x402/go/v2/extensions/types"
)

// TestExtractDiscoveryInfoV1_PreservesPathParams verifies that v1 dynamic-route
// metadata (outputSchema.input.pathParams) survives the conversion to
// extensions.bazaar.info for both query (GET) and body (POST) methods.
func TestExtractDiscoveryInfoV1_PreservesPathParams(t *testing.T) {
	pathParams := map[string]interface{}{
		"id":     "string",
		"region": "string",
	}

	t.Run("query method preserves pathParams", func(t *testing.T) {
		req := map[string]interface{}{
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"type":   "http",
					"method": "GET",
					"queryParams": map[string]interface{}{
						"limit": "number",
					},
					"pathParams": pathParams,
				},
			},
		}

		info, err := ExtractDiscoveryInfoV1(req)
		require.NoError(t, err)
		require.NotNil(t, info)

		queryInput, ok := info.Input.(types.QueryInput)
		require.True(t, ok, "expected QueryInput, got %T", info.Input)
		assert.Equal(t, pathParams, queryInput.PathParams)
		// Existing behaviour must be unaffected.
		assert.Equal(t, map[string]interface{}{"limit": "number"}, queryInput.QueryParams)
	})

	t.Run("body method preserves pathParams", func(t *testing.T) {
		req := map[string]interface{}{
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"type":   "http",
					"method": "POST",
					"bodyFields": map[string]interface{}{
						"name": "string",
					},
					"pathParams": pathParams,
				},
			},
		}

		info, err := ExtractDiscoveryInfoV1(req)
		require.NoError(t, err)
		require.NotNil(t, info)

		bodyInput, ok := info.Input.(types.BodyInput)
		require.True(t, ok, "expected BodyInput, got %T", info.Input)
		assert.Equal(t, pathParams, bodyInput.PathParams)
	})

	t.Run("snake_case path_params is also read", func(t *testing.T) {
		req := map[string]interface{}{
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"type":        "http",
					"method":      "GET",
					"path_params": pathParams,
				},
			},
		}

		info, err := ExtractDiscoveryInfoV1(req)
		require.NoError(t, err)
		require.NotNil(t, info)

		queryInput, ok := info.Input.(types.QueryInput)
		require.True(t, ok, "expected QueryInput, got %T", info.Input)
		assert.Equal(t, pathParams, queryInput.PathParams)
	})

	t.Run("absent pathParams stays nil", func(t *testing.T) {
		req := map[string]interface{}{
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"type":   "http",
					"method": "GET",
				},
			},
		}

		info, err := ExtractDiscoveryInfoV1(req)
		require.NoError(t, err)
		require.NotNil(t, info)

		queryInput, ok := info.Input.(types.QueryInput)
		require.True(t, ok, "expected QueryInput, got %T", info.Input)
		assert.Nil(t, queryInput.PathParams)
	})
}
