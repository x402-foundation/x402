package server

import (
	"math"
	"testing"
)

// TestMapUintStringField pins the canonical totalClaimed parsing rule shared across SDKs: a plain
// decimal string without leading zeros, or a JSON number that is a non-negative safe integer.
func TestMapUintStringField(t *testing.T) {
	cases := []struct {
		name   string
		value  interface{}
		want   string
		wantOK bool
	}{
		{"zero string", "0", "0", true},
		{"plain string", "500", "500", true},
		{"large string beyond uint64", "340282366920938463463374607431768211455", "340282366920938463463374607431768211455", true},
		{"leading zeros", "007", "", false},
		{"double zero", "00", "", false},
		{"plus sign", "+5", "", false},
		{"negative string", "-1", "", false},
		{"negative zero", "-0", "", false},
		{"empty", "", "", false},
		{"whitespace", " 5", "", false},
		{"decimal", "1.5", "", false},
		{"safe integer number", float64(500), "500", true},
		{"max safe integer number", float64(1<<53 - 1), "9007199254740991", true},
		{"above max safe integer", float64(1 << 53), "", false},
		{"beyond uint64", 1e30, "", false},
		{"positive infinity", math.Inf(1), "", false},
		{"nan", math.NaN(), "", false},
		{"negative number", float64(-1), "", false},
		{"fractional number", 1.5, "", false},
		{"bool", true, "", false},
		{"absent", nil, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := mapUintStringField(map[string]interface{}{"totalClaimed": tc.value}, "totalClaimed")
			if ok != tc.wantOK || got != tc.want {
				t.Fatalf("mapUintStringField(%v) = (%q, %v), want (%q, %v)", tc.value, got, ok, tc.want, tc.wantOK)
			}
		})
	}
}
