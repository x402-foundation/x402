package http

import (
	"net/http"
	"strings"
)

// AccessControlExposeHeadersHeader is the response header that lets a
// cross-origin browser client read response headers that are not CORS-safelisted.
const AccessControlExposeHeadersHeader = "Access-Control-Expose-Headers"

// paymentCORSExposeHeaders are the payment protocol response headers a browser
// client must be able to read: the 402 challenge and the settlement receipt.
var paymentCORSExposeHeaders = []string{"PAYMENT-REQUIRED", "PAYMENT-RESPONSE"}

// WithPaymentCORSExposeHeaders returns an Access-Control-Expose-Headers value that
// names PAYMENT-REQUIRED and PAYMENT-RESPONSE in addition to every name in
// existing. Each element of existing may itself be a comma-separated list (as
// returned by http.Header.Values). Names are compared case-insensitively; the
// first spelling and the original order are kept, and the payment headers are
// appended only when missing. It never touches Access-Control-Allow-Origin, so
// whether a browser may read the response at all stays the app's decision.
func WithPaymentCORSExposeHeaders(existing ...string) string {
	names := make([]string, 0, len(existing)+len(paymentCORSExposeHeaders))
	seen := make(map[string]struct{}, cap(names))
	add := func(name string) {
		name = strings.TrimSpace(name)
		if name == "" {
			return
		}
		key := strings.ToLower(name)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		names = append(names, name)
	}
	for _, value := range existing {
		for _, name := range strings.Split(value, ",") {
			add(name)
		}
	}
	for _, name := range paymentCORSExposeHeaders {
		add(name)
	}
	return strings.Join(names, ", ")
}

// ApplyPaymentResponseHeaders copies headers produced by the resource server onto
// dst. Every header is written with Set, except Access-Control-Expose-Headers:
// when headers carry PAYMENT-REQUIRED or PAYMENT-RESPONSE, the expose list already
// on dst (across all of its values) is merged with the payment headers instead of
// being replaced, so a list set by app CORS middleware or the route handler
// survives.
func ApplyPaymentResponseHeaders(dst http.Header, headers map[string]string) {
	carriesPaymentHeader := false
	var exposeValue string
	for key, value := range headers {
		if strings.EqualFold(key, AccessControlExposeHeadersHeader) {
			exposeValue = value
			continue
		}
		for _, name := range paymentCORSExposeHeaders {
			if strings.EqualFold(key, name) {
				carriesPaymentHeader = true
			}
		}
		dst.Set(key, value)
	}
	if !carriesPaymentHeader && exposeValue == "" {
		return
	}
	existing := append([]string(nil), dst.Values(AccessControlExposeHeadersHeader)...)
	if exposeValue != "" {
		existing = append(existing, exposeValue)
	}
	dst.Set(AccessControlExposeHeadersHeader, WithPaymentCORSExposeHeaders(existing...))
}
