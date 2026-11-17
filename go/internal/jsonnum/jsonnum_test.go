package jsonnum

import (
	"encoding/json"
	"testing"
)

func TestInteger(t *testing.T) {
	ok := map[json.Number]string{
		"60":                       "60",
		"60.0":                     "60",
		"6e1":                      "60",
		"6E+1":                     "60",
		"600e-1":                   "60",
		"-0":                       "0",
		"-60":                      "-60",
		"9007199254740993":         "9007199254740993",
		"9007199254740993.0":       "9007199254740993",
		"18446744073709551615":     "18446744073709551615",
		"1.8446744073709551615e19": "18446744073709551615",
	}
	for in, want := range ok {
		got, valid := Integer(in)
		if !valid || got.String() != want {
			t.Fatalf("Integer(%q) = (%v, %v), want %s", in, got, valid, want)
		}
	}
	for _, in := range []json.Number{"60.5", "1.0000000000000000001", "1e-1", "", "abc", "1e1000000000", "1e-1000000000", "0x10"} {
		if got, valid := Integer(in); valid {
			t.Fatalf("Integer(%q) = %v, want rejected", in, got)
		}
	}
}

func TestCanonical(t *testing.T) {
	for in, want := range map[json.Number]json.Number{"60.0": "60", "6e1": "60", "60": "60", "60.5": "60.5", "abc": "abc"} {
		if got := Canonical(in); got != want {
			t.Fatalf("Canonical(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCanonicalValue(t *testing.T) {
	in := map[string]any{
		"a": json.Number("60.0"),
		"b": []any{json.Number("6e1"), map[string]any{"c": json.Number("60.5")}},
		"s": "60.0",
	}
	out := CanonicalValue(in).(map[string]any)
	if out["a"] != json.Number("60") || out["s"] != "60.0" {
		t.Fatalf("got %#v", out)
	}
	arr := out["b"].([]any)
	if arr[0] != json.Number("60") || arr[1].(map[string]any)["c"] != json.Number("60.5") {
		t.Fatalf("nested %#v", arr)
	}
	if in["a"] != json.Number("60.0") || in["b"].([]any)[0] != json.Number("6e1") {
		t.Fatalf("input mutated: %#v", in)
	}
}
