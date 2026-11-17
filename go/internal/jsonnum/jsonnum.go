// Package jsonnum converts json.Number values to exact integers.
package jsonnum

import (
	"encoding/json"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

var numberPattern = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)

// maxExponent bounds the exponent so a short input such as 1e1000000000 cannot
// force a huge allocation. It is far above any value a uint256 field can hold.
const maxExponent = 1000

// Integer returns n as an exact integer. Decimal and exponent forms such as
// 60.0 and 6e1 are accepted when they equal an integer; anything with a
// fractional part, or that is not a JSON number, is rejected.
func Integer(n json.Number) (*big.Int, bool) {
	s := string(n)
	if !numberPattern.MatchString(s) {
		return nil, false
	}
	if i := strings.IndexAny(s, "eE"); i >= 0 {
		exp, err := strconv.Atoi(strings.TrimPrefix(s[i+1:], "+"))
		if err != nil || exp > maxExponent || exp < -maxExponent {
			return nil, false
		}
	}
	r, ok := new(big.Rat).SetString(s)
	if !ok || !r.IsInt() {
		return nil, false
	}
	return new(big.Int).Set(r.Num()), true
}

// Canonical rewrites an integer-valued number such as 60.0 or 6e1 as 60, so it
// decodes into Go integer fields. Other values are returned unchanged.
func Canonical(n json.Number) json.Number {
	if i, ok := Integer(n); ok {
		return json.Number(i.String())
	}
	return n
}

// CanonicalValue returns a copy of a decoded JSON value with every json.Number
// passed through Canonical, so a payload map re-encoded with json.Marshal still
// decodes into Go integer fields. The input is not modified.
func CanonicalValue(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, item := range v {
			out[k] = CanonicalValue(item)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = CanonicalValue(item)
		}
		return out
	case json.Number:
		return Canonical(v)
	default:
		return v
	}
}
