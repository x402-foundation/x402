package bazaar

// Internal tests for unexported facilitator helpers.
// Uses package bazaar (not bazaar_test) to access unexported functions.

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/x402-foundation/x402/go/extensions/types"
	x402types "github.com/x402-foundation/x402/go/types"
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

func TestRawString(t *testing.T) {
	t.Run("returns empty string for nil map", func(t *testing.T) {
		assert.Equal(t, "", rawString(nil, "key"))
	})

	t.Run("returns empty string for empty map", func(t *testing.T) {
		assert.Equal(t, "", rawString(map[string]interface{}{}, "key"))
	})

	t.Run("returns empty string when key is absent", func(t *testing.T) {
		assert.Equal(t, "", rawString(map[string]interface{}{"other": "val"}, "key"))
	})

	t.Run("returns empty string when value is not a string", func(t *testing.T) {
		assert.Equal(t, "", rawString(map[string]interface{}{"key": 42}, "key"))
		assert.Equal(t, "", rawString(map[string]interface{}{"key": true}, "key"))
		assert.Equal(t, "", rawString(map[string]interface{}{"key": nil}, "key"))
	})

	t.Run("returns trimmed string value", func(t *testing.T) {
		assert.Equal(t, "mcp", rawString(map[string]interface{}{"type": "  mcp  "}, "type"))
	})
}

func TestExtractMethodAndToolName(t *testing.T) {
	t.Run("returns empty strings when discoveryInfo is nil", func(t *testing.T) {
		method, toolName := extractMethodAndToolName(nil, nil)
		assert.Equal(t, "", method)
		assert.Equal(t, "", toolName)
	})

	t.Run("extracts toolName from McpInput via type switch when rawInput has no MCP signals", func(t *testing.T) {
		// rawInput has no type="mcp" and no toolName, so rawInputLooksLikeMCP returns false.
		// discoveryInfo.Input is McpInput so the type switch McpInput case fires.
		info := &types.DiscoveryInfo{
			Input: types.McpInput{
				Type:     "mcp",
				ToolName: "switch_case_tool",
			},
		}
		method, toolName := extractMethodAndToolName(info, map[string]interface{}{})
		assert.Equal(t, "", method)
		assert.Equal(t, "switch_case_tool", toolName)
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

func TestIsValidServiceName(t *testing.T) {
	t.Run("accepts strings up to 32 chars", func(t *testing.T) {
		assert.True(t, isValidServiceName("Example Weather"))
		assert.True(t, isValidServiceName("a"))
		assert.True(t, isValidServiceName(strings.Repeat("a", 32)))
	})

	t.Run("rejects empty and over-cap strings", func(t *testing.T) {
		assert.False(t, isValidServiceName(""))
		assert.False(t, isValidServiceName(strings.Repeat("a", 33)))
	})

	t.Run("rejects non-ASCII characters", func(t *testing.T) {
		// Multi-byte chars in UTF-8 — would otherwise diverge across SDKs
		// (UTF-16 code units in TS, code points in Python, bytes here).
		assert.False(t, isValidServiceName("Café Service"))
		assert.False(t, isValidServiceName("東京 Weather"))
		assert.False(t, isValidServiceName("🚀 Service"))
	})

	t.Run("rejects ASCII control characters", func(t *testing.T) {
		assert.False(t, isValidServiceName("Service\x00"))
		assert.False(t, isValidServiceName("Line\nBreak"))
		assert.False(t, isValidServiceName("Tab\there"))
	})

	t.Run("accepts printable ASCII with spaces and punctuation", func(t *testing.T) {
		assert.True(t, isValidServiceName("Example Weather"))
		assert.True(t, isValidServiceName("AT&T"))
		assert.True(t, isValidServiceName("Coinbase, Inc."))
		assert.True(t, isValidServiceName("Service v2.0!"))
	})
}

func TestSanitizeTags(t *testing.T) {
	t.Run("returns nil for nil and empty input", func(t *testing.T) {
		assert.Nil(t, sanitizeTags(nil))
		assert.Nil(t, sanitizeTags([]string{}))
	})

	t.Run("drops empty and over-cap entries", func(t *testing.T) {
		got := sanitizeTags([]string{"weather", "", strings.Repeat("a", 33), "forecast"})
		assert.Equal(t, []string{"weather", "forecast"}, got)
	})

	t.Run("truncates to 5 entries", func(t *testing.T) {
		got := sanitizeTags([]string{"a", "b", "c", "d", "e", "f", "g"})
		assert.Equal(t, []string{"a", "b", "c", "d", "e"}, got)
	})

	t.Run("returns nil when nothing survives", func(t *testing.T) {
		assert.Nil(t, sanitizeTags([]string{"", strings.Repeat("a", 33)}))
	})

	t.Run("drops non-ASCII tags but keeps ASCII siblings", func(t *testing.T) {
		got := sanitizeTags([]string{"weather", "café", "東京", "🚀", "forecast"})
		assert.Equal(t, []string{"weather", "forecast"}, got)
	})

	t.Run("dedupes case-insensitively keeping first occurrence", func(t *testing.T) {
		got := sanitizeTags([]string{"Weather", "weather", "WEATHER", "forecast"})
		assert.Equal(t, []string{"Weather", "forecast"}, got)
	})
}

func TestIsValidIconUrl(t *testing.T) {
	t.Run("accepts plain http and https urls", func(t *testing.T) {
		assert.True(t, isValidIconUrl("https://api.example.com/icon.png"))
		assert.True(t, isValidIconUrl("http://api.example.com/icon"))
	})

	t.Run("rejects empty and over-cap strings", func(t *testing.T) {
		assert.False(t, isValidIconUrl(""))
		assert.False(t, isValidIconUrl("https://example.com/"+strings.Repeat("a", 2048)))
	})

	t.Run("rejects non-http schemes", func(t *testing.T) {
		assert.False(t, isValidIconUrl("data:image/png;base64,iVBOR"))
		assert.False(t, isValidIconUrl("file:///etc/passwd"))
		assert.False(t, isValidIconUrl("javascript:alert(1)"))
		assert.False(t, isValidIconUrl("ftp://example.com/icon.png"))
	})

	t.Run("rejects userinfo", func(t *testing.T) {
		assert.False(t, isValidIconUrl("https://user@example.com/icon.png"))
		assert.False(t, isValidIconUrl("https://user:pass@example.com/icon.png"))
	})

	t.Run("rejects IP literals", func(t *testing.T) {
		assert.False(t, isValidIconUrl("http://10.0.0.1/icon.png"))
		assert.False(t, isValidIconUrl("http://127.0.0.1/icon.png"))
		assert.False(t, isValidIconUrl("http://[::1]/icon.png"))
		assert.False(t, isValidIconUrl("http://[2001:db8::1]/icon.png"))
	})

	t.Run("rejects decimal-encoded and short-form IP hosts", func(t *testing.T) {
		// 2130706433 == 127.0.0.1; 0 expands to 0.0.0.0 on Linux.
		assert.False(t, isValidIconUrl("http://2130706433/icon.png"))
		assert.False(t, isValidIconUrl("http://0/icon.png"))
		assert.False(t, isValidIconUrl("http://3232235521/icon.png"))
	})

	t.Run("rejects hex-encoded IP hosts", func(t *testing.T) {
		// 0x7f000001 == 127.0.0.1.
		assert.False(t, isValidIconUrl("http://0x7f000001/icon.png"))
		assert.False(t, isValidIconUrl("http://0X7F000001/icon.png"))
	})

	t.Run("rejects localhost", func(t *testing.T) {
		assert.False(t, isValidIconUrl("http://localhost/icon.png"))
		assert.False(t, isValidIconUrl("http://LOCALHOST/icon.png"))
	})

	t.Run("rejects loopback aliases from /etc/hosts", func(t *testing.T) {
		assert.False(t, isValidIconUrl("http://localhost.localdomain/icon.png"))
		assert.False(t, isValidIconUrl("http://ip6-localhost/icon.png"))
		assert.False(t, isValidIconUrl("http://ip6-loopback/icon.png"))
	})

	t.Run("rejects IDN / full-width localhost confusables", func(t *testing.T) {
		// Full-width Latin "ｌｏｃａｌｈｏｓｔ" normalizes to "localhost" via UTS #46.
		assert.False(t, isValidIconUrl("http://ｌｏｃａｌｈｏｓｔ/icon.png"))
	})

	t.Run("rejects control characters", func(t *testing.T) {
		assert.False(t, isValidIconUrl("https://example.com/\x00icon.png"))
		assert.False(t, isValidIconUrl("https://example.com/icon\n.png"))
		assert.False(t, isValidIconUrl("https://example.com/icon\x7f.png"))
	})

	t.Run("rejects relative paths", func(t *testing.T) {
		assert.False(t, isValidIconUrl("/icon.png"))
		assert.False(t, isValidIconUrl("icon.png"))
	})
}

func TestSanitizeResourceServiceMetadata(t *testing.T) {
	t.Run("preserves all valid fields", func(t *testing.T) {
		out := SanitizeResourceServiceMetadata(&x402types.ResourceInfo{
			URL:         "https://api.example.com/x",
			ServiceName: "Example Weather",
			Tags:        []string{"weather", "forecast"},
			IconUrl:     "https://api.example.com/icon.png",
		})
		assert.Equal(t, "Example Weather", out.ServiceName)
		assert.Equal(t, []string{"weather", "forecast"}, out.Tags)
		assert.Equal(t, "https://api.example.com/icon.png", out.IconUrl)
	})

	t.Run("soft-drops only invalid fields", func(t *testing.T) {
		out := SanitizeResourceServiceMetadata(&x402types.ResourceInfo{
			ServiceName: strings.Repeat("a", 33),
			Tags:        []string{"weather", "forecast"},
			IconUrl:     "data:image/png;base64,iVBOR",
		})
		assert.Equal(t, "", out.ServiceName)
		assert.Equal(t, []string{"weather", "forecast"}, out.Tags)
		assert.Equal(t, "", out.IconUrl)
	})

	t.Run("nil input returns empty struct", func(t *testing.T) {
		out := SanitizeResourceServiceMetadata(nil)
		assert.Equal(t, "", out.ServiceName)
		assert.Nil(t, out.Tags)
		assert.Equal(t, "", out.IconUrl)
	})
}
