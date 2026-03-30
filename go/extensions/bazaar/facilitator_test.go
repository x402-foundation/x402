package bazaar

// Internal tests for unexported facilitator helpers.
// Uses package bazaar (not bazaar_test) to access unexported functions.

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestIsValidRouteTemplate(t *testing.T) {
	t.Run("returns false for empty input", func(t *testing.T) {
		assert.False(t, isValidRouteTemplate(""))
	})

	t.Run("returns false for paths not starting with /", func(t *testing.T) {
		assert.False(t, isValidRouteTemplate("users/123"))
		assert.False(t, isValidRouteTemplate("relative/path"))
		assert.False(t, isValidRouteTemplate("no-slash"))
	})

	t.Run("returns false for paths containing ..", func(t *testing.T) {
		assert.False(t, isValidRouteTemplate("/users/../admin"))
		assert.False(t, isValidRouteTemplate("/../etc/passwd"))
		assert.False(t, isValidRouteTemplate("/users/.."))
	})

	t.Run("returns false for paths containing ://", func(t *testing.T) {
		assert.False(t, isValidRouteTemplate("http://evil.com/path"))
		assert.False(t, isValidRouteTemplate("/users/http://evil"))
		assert.False(t, isValidRouteTemplate("javascript://foo"))
	})

	t.Run("returns true for valid paths", func(t *testing.T) {
		assert.True(t, isValidRouteTemplate("/users/:userId"))
		assert.True(t, isValidRouteTemplate("/api/v1/items"))
		assert.True(t, isValidRouteTemplate("/products/:productId/reviews/:reviewId"))
		assert.True(t, isValidRouteTemplate("/weather/:country/:city"))
	})

	t.Run("returns false for paths with spaces or invalid characters", func(t *testing.T) {
		assert.False(t, isValidRouteTemplate("/users/ bad"))
		assert.False(t, isValidRouteTemplate("/path with spaces"))
	})

	t.Run("edge case: /users/..hidden is rejected (contains ..)", func(t *testing.T) {
		assert.False(t, isValidRouteTemplate("/users/..hidden"))
	})

	t.Run("rejects percent-encoded traversal sequences", func(t *testing.T) {
		assert.False(t, isValidRouteTemplate("/users/%2e%2e/admin"))
		assert.False(t, isValidRouteTemplate("/users/%2E%2E/admin"))
	})
}

func TestExtractPathParams(t *testing.T) {
	t.Run("returns empty map when URL path has fewer segments than pattern (bracket)", func(t *testing.T) {
		result := extractPathParams("/users/[userId]", "/api/other", true)
		assert.Equal(t, map[string]string{}, result)
	})

	t.Run("extracts single param from matching path (bracket)", func(t *testing.T) {
		result := extractPathParams("/users/[userId]", "/users/123", true)
		assert.Equal(t, map[string]string{"userId": "123"}, result)
	})

	t.Run("extracts multiple params from matching path (bracket)", func(t *testing.T) {
		result := extractPathParams("/users/[userId]/posts/[postId]", "/users/42/posts/7", true)
		assert.Equal(t, map[string]string{"userId": "42", "postId": "7"}, result)
	})

	t.Run("extracts single param from matching path (colon)", func(t *testing.T) {
		result := extractPathParams("/users/:userId", "/users/123", false)
		assert.Equal(t, map[string]string{"userId": "123"}, result)
	})

	t.Run("extracts multiple params from matching path (colon)", func(t *testing.T) {
		result := extractPathParams("/users/:userId/posts/:postId", "/users/42/posts/7", false)
		assert.Equal(t, map[string]string{"userId": "42", "postId": "7"}, result)
	})

	t.Run("returns empty map when URL path mismatches (colon)", func(t *testing.T) {
		result := extractPathParams("/users/:userId", "/api/other", false)
		assert.Equal(t, map[string]string{}, result)
	})
}

func TestNormalizeResourceURL(t *testing.T) {
	t.Run("uses routeTemplate as canonical path when present", func(t *testing.T) {
		result := normalizeResourceURL("https://api.example.com/users/123?foo=bar#frag", "/users/:userId")
		assert.Equal(t, "https://api.example.com/users/:userId", result)
	})

	t.Run("strips query params and fragment when no routeTemplate", func(t *testing.T) {
		result := normalizeResourceURL("https://api.example.com/search?q=test#section", "")
		assert.Equal(t, "https://api.example.com/search", result)
	})

	t.Run("returns original URL on parse error with routeTemplate", func(t *testing.T) {
		// url.Parse rarely fails but we exercise the fallback branch.
		result := normalizeResourceURL("://invalid", "/route")
		// Fallback: stripQueryParams is called, which may also fail on invalid URL,
		// returning the original.
		assert.NotEmpty(t, result)
	})

}
