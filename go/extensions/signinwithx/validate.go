package signinwithx

import (
	"fmt"
	"net/url"
	"time"
)

const defaultMaxAge = 5 * time.Minute

func normalizeConfiguredOrigin(origin string) (*url.URL, error) {
	if origin == "" {
		return nil, fmt.Errorf("siwx origin is required")
	}

	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid siwx origin %q is not a valid URL", origin)
	}

	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("invalid siwx origin %q must use http or https", origin)
	}

	if parsed.User != nil {
		return nil, fmt.Errorf("invalid siwx origin %q must not include credentials", origin)
	}

	if parsed.Path != "" && parsed.Path != "/" {
		return nil, fmt.Errorf("invalid siwx origin %q must not include a path, query, or fragment", origin)
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("invalid siwx origin %q must not include a path, query, or fragment", origin)
	}

	return &url.URL{
		Scheme: parsed.Scheme,
		Host:   parsed.Host,
	}, nil
}

func urlOrigin(u *url.URL) string {
	return u.Scheme + "://" + u.Host
}

// ValidateMessage validates SIWX payload fields before cryptographic verification.
func ValidateMessage(payload Payload, expectedOrigin *url.URL, options ValidationOptions) ValidationResult {
	if expectedOrigin == nil || expectedOrigin.Scheme == "" || expectedOrigin.Host == "" {
		return ValidationResult{Valid: false, Error: "Invalid expected origin"}
	}

	if payload.Domain != expectedOrigin.Host {
		return ValidationResult{
			Valid: false,
			Error: fmt.Sprintf(`Domain mismatch: expected %q, got %q`, expectedOrigin.Host, payload.Domain),
		}
	}

	messageURI, err := url.Parse(payload.URI)
	if err != nil || messageURI.Scheme == "" || messageURI.Host == "" {
		return ValidationResult{
			Valid: false,
			Error: fmt.Sprintf(`Invalid URI: %q is not a valid URL`, payload.URI),
		}
	}

	expected := urlOrigin(expectedOrigin)
	if urlOrigin(messageURI) != expected {
		return ValidationResult{
			Valid: false,
			Error: fmt.Sprintf(`URI mismatch: expected origin %q, got %q`, expected, urlOrigin(messageURI)),
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
