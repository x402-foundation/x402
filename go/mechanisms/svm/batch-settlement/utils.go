package batchsettlement

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// IsDigits reports whether value is a non-empty decimal digit string.
func IsDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

// FormatU64 formats value as a base-10 string.
func FormatU64(value uint64) string {
	return strconv.FormatUint(value, 10)
}

// WireMap round-trips a struct through JSON to obtain a map payload.
func WireMap(value any) (map[string]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AddU64 reports whether left+right fits in a uint64.
func AddU64(left, right uint64) (uint64, bool) {
	sum := left + right
	return sum, sum >= left
}

// AddU64Checked is AddU64 with a stable overflow error for callers that reject invalid sums.
func AddU64Checked(left, right uint64) (uint64, error) {
	sum, ok := AddU64(left, right)
	if !ok {
		return 0, fmt.Errorf("batch-settlement amount overflow")
	}
	return sum, nil
}

// SubU64 reports whether left-right fits in a uint64.
func SubU64(left, right uint64) (uint64, bool) {
	if left < right {
		return 0, false
	}
	return left - right, true
}

// MulU64 reports whether left*right fits in a uint64.
func MulU64(left, right uint64) (uint64, bool) {
	if left == 0 || right == 0 {
		return 0, true
	}
	product := left * right
	return product, product/left == right
}
