package signinwithx

import (
	"fmt"
	"net/url"
	"strings"
	"time"
)

const defaultMaxAge = 5 * time.Minute

// ValidateMessage checks a payload's non-cryptographic fields: domain and URI
// binding to the expected resource, timestamp freshness, and optional nonce
// uniqueness. It does not verify the signature; call VerifySignature after.
func ValidateMessage(p Payload, expectedResourceURI string, opts ValidationOptions) ValidationResult {
	u, err := url.Parse(expectedResourceURI)
	if err != nil {
		return ValidationResult{Error: fmt.Sprintf("invalid expected resource URI: %v", err)}
	}
	maxAge := opts.MaxAge
	if maxAge <= 0 {
		maxAge = defaultMaxAge
	}

	if p.Domain != u.Hostname() {
		return ValidationResult{Error: fmt.Sprintf("domain mismatch: expected %q, got %q", u.Hostname(), p.Domain)}
	}
	origin := u.Scheme + "://" + u.Host
	if !strings.HasPrefix(p.URI, origin) {
		return ValidationResult{Error: fmt.Sprintf("URI mismatch: expected origin %q, got %q", origin, p.URI)}
	}

	issuedAt, err := time.Parse(time.RFC3339, p.IssuedAt)
	if err != nil {
		return ValidationResult{Error: "invalid issuedAt timestamp"}
	}
	age := time.Since(issuedAt)
	if age > maxAge {
		return ValidationResult{Error: fmt.Sprintf("message too old: %s exceeds %s", age.Round(time.Second), maxAge)}
	}
	if age < 0 {
		return ValidationResult{Error: "issuedAt is in the future"}
	}

	if p.ExpirationTime != "" {
		exp, err := time.Parse(time.RFC3339, p.ExpirationTime)
		if err != nil {
			return ValidationResult{Error: "invalid expirationTime timestamp"}
		}
		if time.Now().After(exp) {
			return ValidationResult{Error: "message expired"}
		}
	}
	if p.NotBefore != "" {
		nb, err := time.Parse(time.RFC3339, p.NotBefore)
		if err != nil {
			return ValidationResult{Error: "invalid notBefore timestamp"}
		}
		if time.Now().Before(nb) {
			return ValidationResult{Error: "message not yet valid (notBefore is in the future)"}
		}
	}

	if opts.CheckNonce != nil && !opts.CheckNonce(p.Nonce) {
		return ValidationResult{Error: "nonce validation failed (possible replay)"}
	}
	return ValidationResult{Valid: true}
}
