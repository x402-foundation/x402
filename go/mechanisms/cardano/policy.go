package cardano

import "math"

// ResolveConfirmationPolicy reads extra.confirmationPolicy, defaulting to one
// confirmation. ok is false when the block is malformed or out of range.
func ResolveConfirmationPolicy(extra map[string]interface{}) (policy ConfirmationPolicy, ok bool) {
	raw, present := extra["confirmationPolicy"]
	if !present {
		return ConfirmationPolicy{L1Confirmations: DefaultL1Confirmations}, true
	}
	return NormalizeConfirmationPolicy(raw)
}

// NormalizeConfirmationPolicy validates a decoded confirmationPolicy value: an
// object with exactly one integer key l1Confirmations in [-1, 20].
func NormalizeConfirmationPolicy(value interface{}) (ConfirmationPolicy, bool) {
	var l1 interface{}
	switch v := value.(type) {
	case map[string]interface{}:
		if len(v) != 1 {
			return ConfirmationPolicy{}, false
		}
		var present bool
		if l1, present = v["l1Confirmations"]; !present {
			return ConfirmationPolicy{}, false
		}
	case ConfirmationPolicy:
		return v, v.L1Confirmations >= MinL1Confirmations && v.L1Confirmations <= MaxL1Confirmations
	case *ConfirmationPolicy:
		if v == nil {
			return ConfirmationPolicy{}, false
		}
		return NormalizeConfirmationPolicy(*v)
	default:
		return ConfirmationPolicy{}, false
	}
	n, ok := IntegerValue(l1)
	if !ok || n < MinL1Confirmations || n > MaxL1Confirmations {
		return ConfirmationPolicy{}, false
	}
	return ConfirmationPolicy{L1Confirmations: int(n)}, true
}

// ConfirmationsSatisfy reports whether observed evidence meets the required depth.
func ConfirmationsSatisfy(observed, required int) bool {
	return observed >= required
}

// IntegerValue accepts the integer representations JSON decoding produces.
func IntegerValue(v interface{}) (int64, bool) {
	switch n := v.(type) {
	case float64:
		if n != math.Trunc(n) || math.IsInf(n, 0) || n > math.MaxInt32 || n < math.MinInt32 {
			return 0, false
		}
		return int64(n), true
	case int:
		return int64(n), true
	case int64:
		return n, true
	case int32:
		return int64(n), true
	}
	return 0, false
}
