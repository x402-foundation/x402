package x402

import (
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

var (
	moneyStringPattern = regexp.MustCompile(`^\d+(?:\.\d+)?$`)
	moneyParsePattern  = regexp.MustCompile(`^\$?\s*(\d+(?:\.\d+)?)(?:\s+([A-Za-z][A-Za-z0-9.]*))?$`)
	tokenAmountPattern = regexp.MustCompile(`^-?\d+\.?\d*$`)
	scientificPattern  = regexp.MustCompile(`[eE]`)
	jsonNumberPattern  = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)
)

// ValidatePaymentPayload performs basic validation on a payment payload
// Version-aware: handles both v1 and v2 payload structures
func ValidatePaymentPayload(p PaymentPayload) error {
	if p.X402Version < 1 || p.X402Version > 2 {
		return fmt.Errorf("unsupported x402 version: %d", p.X402Version)
	}

	// V2 validation: check accepted field
	if p.X402Version == 2 {
		if p.Accepted.Scheme == "" {
			return fmt.Errorf("payment scheme is required")
		}
		if p.Accepted.Network == "" {
			return fmt.Errorf("payment network is required")
		}
	}

	// Both v1 and v2 must have payload
	if p.Payload == nil {
		return fmt.Errorf("payment payload is required")
	}

	// Note: v1 validation is minimal here - scheme/network are validated
	// by the mechanism-specific facilitator based on the payment requirements
	return nil
}

// ValidatePaymentRequirements performs basic validation on payment requirements
func ValidatePaymentRequirements(r PaymentRequirements) error {
	if r.Scheme == "" {
		return fmt.Errorf("payment scheme is required")
	}
	if r.Network == "" {
		return fmt.Errorf("payment network is required")
	}
	if r.Asset == "" {
		return fmt.Errorf("payment asset is required")
	}
	// Note: Amount check is skipped for v1 compatibility (v1 uses maxAmountRequired)
	// Version-specific facilitators will validate amount fields as needed
	if r.PayTo == "" {
		return fmt.Errorf("payment recipient is required")
	}
	return nil
}

// findByNetworkAndScheme finds a scheme implementation for a given network/scheme combination
// This supports pattern matching for networks (e.g., "eip155:*")
func findByNetworkAndScheme[T any](networkMap map[Network]map[string]T, scheme string, network Network) T {
	var zero T
	registeredNetwork, ok := findRegisteredNetwork(networkMap, scheme, network)
	if !ok {
		return zero
	}
	return networkMap[registeredNetwork][scheme]
}

// findRegisteredNetwork returns the registered network key that findByNetworkAndScheme resolves to
// This lets a caller read a related map under the key of the same registration
func findRegisteredNetwork[T any](networkMap map[Network]map[string]T, scheme string, network Network) (Network, bool) {
	if schemeMap, exists := networkMap[network]; exists {
		if _, exists := schemeMap[scheme]; exists {
			return network, true
		}
	}

	for registeredNetwork, schemeMap := range networkMap {
		if network.Match(registeredNetwork) || registeredNetwork.Match(network) {
			if _, exists := schemeMap[scheme]; exists {
				return registeredNetwork, true
			}
		}
	}

	return "", false
}

// NumberToDecimalString converts a float64 to a plain decimal string without scientific notation.
func NumberToDecimalString(n float64) string {
	return strconv.FormatFloat(n, 'f', -1, 64)
}

// ParseMoneyString extracts a non-negative decimal substring from a money string.
// Accepts plain decimal strings with an optional leading dollar sign.
// Rejects ticker suffixes — use ParseMoney when a symbol may be present.
func ParseMoneyString(money string) (string, error) {
	cleaned := strings.TrimSpace(strings.TrimPrefix(money, "$"))
	if !moneyStringPattern.MatchString(cleaned) || scientificPattern.MatchString(cleaned) {
		return "", fmt.Errorf("invalid money format: %s", money)
	}
	return cleaned, nil
}

// ParseMoney parses money into a decimal string and optional uppercase ticker.
// "1.50 USDT" → symbol; "1.50 USD" and bare amounts have none.
// Glued tickers ("1.50USDT") are rejected.
func ParseMoney(money Price) (amount string, symbol string, err error) {
	switch v := money.(type) {
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
			return "", "", fmt.Errorf("invalid money format: %v", v)
		}
		return NumberToDecimalString(v), "", nil
	case float32:
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) || v < 0 {
			return "", "", fmt.Errorf("invalid money format: %v", v)
		}
		return NumberToDecimalString(float64(v)), "", nil
	case int:
		if v < 0 {
			return "", "", fmt.Errorf("invalid money format: %v", v)
		}
		return strconv.Itoa(v), "", nil
	case int64:
		if v < 0 {
			return "", "", fmt.Errorf("invalid money format: %v", v)
		}
		return strconv.FormatInt(v, 10), "", nil
	case string:
		trimmed := strings.TrimSpace(v)
		match := moneyParsePattern.FindStringSubmatch(trimmed)
		if match == nil {
			return "", "", fmt.Errorf("invalid money format: %s", v)
		}
		rawSymbol := match[2]
		if rawSymbol == "" || strings.ToUpper(rawSymbol) == "USD" {
			return match[1], "", nil
		}
		return match[1], strings.ToUpper(rawSymbol), nil
	default:
		return "", "", fmt.Errorf("invalid money format: %v", money)
	}
}

// ConvertToTokenAmount converts a decimal amount to token smallest units.
// Accepts only plain decimal strings — scientific notation is not allowed.
func ConvertToTokenAmount(decimalAmount string, decimals int) (string, error) {
	if scientificPattern.MatchString(decimalAmount) {
		return "", fmt.Errorf("invalid amount: %s — use decimal notation, not scientific notation", decimalAmount)
	}
	if !tokenAmountPattern.MatchString(decimalAmount) {
		return "", fmt.Errorf("invalid amount: %s", decimalAmount)
	}
	intPart, decPart, found := strings.Cut(decimalAmount, ".")
	if !found {
		decPart = ""
	}
	paddedDec := decPart + strings.Repeat("0", decimals)
	if len(paddedDec) > decimals {
		paddedDec = paddedDec[:decimals]
	}
	tokenAmount := strings.TrimLeft(intPart+paddedDec, "0")
	if tokenAmount == "" {
		tokenAmount = "0"
	}
	return tokenAmount, nil
}

// maxJSONNumberExponent bounds the exponent ParseJSONInteger accepts, so a
// short input such as 1e1000000000 cannot force a huge allocation.
const maxJSONNumberExponent = 1000

// ParseJSONInteger returns n as an exact integer. Decimal and exponent forms
// such as 60.0 and 6e1 are accepted when they equal an integer; values with a
// fractional part, or that are not JSON numbers, are rejected. Callers apply
// their own range checks to the result.
func ParseJSONInteger(n json.Number) (*big.Int, bool) {
	s := string(n)
	if !jsonNumberPattern.MatchString(s) {
		return nil, false
	}
	if i := strings.IndexAny(s, "eE"); i >= 0 {
		exp, err := strconv.Atoi(strings.TrimPrefix(s[i+1:], "+"))
		if err != nil || exp > maxJSONNumberExponent || exp < -maxJSONNumberExponent {
			return nil, false
		}
	}
	r, ok := new(big.Rat).SetString(s)
	if !ok || !r.IsInt() {
		return nil, false
	}
	return new(big.Int).Set(r.Num()), true
}

// NormalizeJSONNumbers returns a copy of a decoded JSON value in which every
// integer-valued json.Number (60.0, 6e1) is rewritten as a plain integer (60),
// so a map re-encoded with json.Marshal still decodes into Go integer fields.
// Other values are kept as they are, and the input is not modified.
func NormalizeJSONNumbers(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, item := range v {
			out[k] = NormalizeJSONNumbers(item)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = NormalizeJSONNumbers(item)
		}
		return out
	case json.Number:
		if i, ok := ParseJSONInteger(v); ok {
			return json.Number(i.String())
		}
		return v
	default:
		return value
	}
}
