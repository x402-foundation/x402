package signinwithx

import (
	"fmt"
	"net/url"
	"strings"
	"time"
)

const defaultMaxAge = 5 * time.Minute

// ValidateMessage validates SIWX payload fields before cryptographic verification.
func ValidateMessage(payload Payload, expectedResourceURI string, options ValidationOptions) ValidationResult {
	expectedURL, err := url.Parse(expectedResourceURI)
	if err != nil || expectedURL.Hostname() == "" {
		return ValidationResult{Valid: false, Error: "Invalid expected resource URI"}
	}

	if payload.Domain != expectedURL.Hostname() {
		return ValidationResult{
			Valid: false,
			Error: fmt.Sprintf("Domain mismatch: expected %q, got %q", expectedURL.Hostname(), payload.Domain),
		}
	}

	origin := expectedURL.Scheme + "://" + expectedURL.Host
	if !strings.HasPrefix(payload.URI, origin) {
		return ValidationResult{
			Valid: false,
			Error: fmt.Sprintf("URI mismatch: expected origin %q, got %q", origin, payload.URI),
		}
	}

	maxAge := options.MaxAge
	if maxAge == 0 {
		maxAge = defaultMaxAge
	}

	issuedAt, err := time.Parse(time.RFC3339, payload.IssuedAt)
	if err != nil {
		issuedAt, err = time.Parse(time.RFC3339Nano, payload.IssuedAt)
	}
	if err != nil {
		return ValidationResult{Valid: false, Error: "Invalid issuedAt timestamp"}
	}

	now := time.Now()
	age := now.Sub(issuedAt)
	if age > maxAge {
		return ValidationResult{
			Valid: false,
			Error: fmt.Sprintf("Message too old: %.0fs exceeds %.0fs limit", age.Seconds(), maxAge.Seconds()),
		}
	}
	if age < 0 {
		return ValidationResult{Valid: false, Error: "issuedAt is in the future"}
	}

	if payload.ExpirationTime != "" {
		expiration, err := parseTimestamp(payload.ExpirationTime)
		if err != nil {
			return ValidationResult{Valid: false, Error: "Invalid expirationTime timestamp"}
		}
		if expiration.Before(now) {
			return ValidationResult{Valid: false, Error: "Message expired"}
		}
	}

	if payload.NotBefore != "" {
		notBefore, err := parseTimestamp(payload.NotBefore)
		if err != nil {
			return ValidationResult{Valid: false, Error: "Invalid notBefore timestamp"}
		}
		if now.Before(notBefore) {
			return ValidationResult{Valid: false, Error: "Message not yet valid (notBefore is in the future)"}
		}
	}

	if options.CheckNonce != nil && !options.CheckNonce(payload.Nonce) {
		return ValidationResult{Valid: false, Error: "Nonce validation failed (possible replay attack)"}
	}

	return ValidationResult{Valid: true}
}

func parseTimestamp(value string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339, value)
	if err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339Nano, value)
}
