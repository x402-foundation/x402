package masumi

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

var errUnpairedSurrogate = errors.New("JCS cannot serialize a string containing an unpaired surrogate")

// JCS canonicalizes a JSON value per RFC 8785, exactly as the TypeScript SDK
// does: members sorted by UTF-16 code units, numbers in ECMAScript
// Number::toString form, JSON.stringify string escaping. Values decoded by
// encoding/json (nil, bool, float64, string, []interface{},
// map[string]interface{}) are supported, as are Go integer types and
// json.Number. Non-finite numbers, invalid Unicode and cycles are rejected.
func JCS(value interface{}) ([]byte, error) {
	var sb strings.Builder
	if err := writeJCS(&sb, value, map[uintptr]bool{}); err != nil {
		return nil, err
	}
	return []byte(sb.String()), nil
}

func writeJCS(sb *strings.Builder, value interface{}, active map[uintptr]bool) error {
	switch v := value.(type) {
	case nil:
		sb.WriteString("null")
		return nil
	case bool:
		if v {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
		return nil
	case string:
		return writeJSONString(sb, v)
	case json.Number:
		f, err := strconv.ParseFloat(string(v), 64)
		if err != nil {
			return fmt.Errorf("JCS cannot serialize the number %s", v)
		}
		return writeNumber(sb, f)
	case float64:
		return writeNumber(sb, v)
	case float32:
		return writeNumber(sb, float64(v))
	case int:
		return writeNumber(sb, float64(v))
	case int8:
		return writeNumber(sb, float64(v))
	case int16:
		return writeNumber(sb, float64(v))
	case int32:
		return writeNumber(sb, float64(v))
	case int64:
		return writeNumber(sb, float64(v))
	case uint:
		return writeNumber(sb, float64(v))
	case uint8:
		return writeNumber(sb, float64(v))
	case uint16:
		return writeNumber(sb, float64(v))
	case uint32:
		return writeNumber(sb, float64(v))
	case uint64:
		return writeNumber(sb, float64(v))
	}

	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Slice, reflect.Array:
		if rv.Kind() == reflect.Slice && rv.IsNil() {
			sb.WriteString("null")
			return nil
		}
		leave, err := enter(rv, active)
		if err != nil {
			return err
		}
		defer leave()
		sb.WriteByte('[')
		for i := 0; i < rv.Len(); i++ {
			if i > 0 {
				sb.WriteByte(',')
			}
			if err := writeJCS(sb, rv.Index(i).Interface(), active); err != nil {
				return err
			}
		}
		sb.WriteByte(']')
		return nil
	case reflect.Map:
		if rv.Type().Key().Kind() != reflect.String {
			return fmt.Errorf("JCS cannot serialize a map keyed by %s", rv.Type().Key())
		}
		if rv.IsNil() {
			sb.WriteString("null")
			return nil
		}
		leave, err := enter(rv, active)
		if err != nil {
			return err
		}
		defer leave()
		keys := make([]string, 0, rv.Len())
		for _, k := range rv.MapKeys() {
			keys = append(keys, k.String())
		}
		sort.Slice(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		sb.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			if err := writeJSONString(sb, k); err != nil {
				return err
			}
			sb.WriteByte(':')
			if err := writeJCS(sb, rv.MapIndex(reflect.ValueOf(k).Convert(rv.Type().Key())).Interface(), active); err != nil {
				return err
			}
		}
		sb.WriteByte('}')
		return nil
	case reflect.Pointer, reflect.Interface:
		if rv.IsNil() {
			sb.WriteString("null")
			return nil
		}
		return writeJCS(sb, rv.Elem().Interface(), active)
	}
	return fmt.Errorf("JCS cannot serialize a value of type %T", value)
}

func enter(rv reflect.Value, active map[uintptr]bool) (func(), error) {
	if rv.Kind() == reflect.Array {
		return func() {}, nil
	}
	ptr := rv.Pointer()
	if ptr == 0 || (rv.Kind() == reflect.Slice && rv.Len() == 0) {
		return func() {}, nil
	}
	if active[ptr] {
		return nil, errors.New("JCS cannot serialize a cyclic value")
	}
	active[ptr] = true
	return func() { delete(active, ptr) }, nil
}

// lessUTF16 orders strings by their UTF-16 code units, as JavaScript sorts.
func lessUTF16(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

func writeJSONString(sb *strings.Builder, s string) error {
	if !utf8.ValidString(s) {
		return errUnpairedSurrogate
	}
	const hexDigits = "0123456789abcdef"
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		default:
			if r < 0x20 {
				sb.WriteString(`\u00`)
				sb.WriteByte(hexDigits[r>>4])
				sb.WriteByte(hexDigits[r&0xf])
			} else {
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
	return nil
}

func writeNumber(sb *strings.Builder, f float64) error {
	s, err := formatNumber(f)
	if err != nil {
		return err
	}
	sb.WriteString(s)
	return nil
}

// formatNumber renders f exactly as ECMAScript Number.prototype.toString.
func formatNumber(f float64) (string, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "", fmt.Errorf("JCS cannot serialize the non-finite number %v", f)
	}
	if f == 0 {
		return "0", nil
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	exp := strconv.FormatFloat(f, 'e', -1, 64)
	mantissa, expPart, _ := strings.Cut(exp, "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	e, _ := strconv.Atoi(expPart)
	k := len(digits)
	n := e + 1

	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		expSign := "+"
		if n-1 < 0 {
			expSign = "-"
		}
		mag := n - 1
		if mag < 0 {
			mag = -mag
		}
		if k == 1 {
			out = digits + "e" + expSign + strconv.Itoa(mag)
		} else {
			out = digits[:1] + "." + digits[1:] + "e" + expSign + strconv.Itoa(mag)
		}
	}
	return sign + out, nil
}
