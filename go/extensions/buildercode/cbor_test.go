package buildercode

import (
	"encoding/hex"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	appCode     = "bc_my_app"
	serviceCode = "bc_my_client"
	walletCode  = "bc_my_facilitator"
)

func TestEncodeBuilderCodeSuffixSpecVectors(t *testing.T) {
	// Vectors from specs/extensions/builder_code.md.
	tests := []struct {
		name string
		data BuilderCodeSuffixData
		want string
	}{
		{
			name: "app only",
			data: BuilderCodeSuffixData{BuilderCodeExtensionData: BuilderCodeExtensionData{A: "bc_myapp"}},
			want: "a161616862635f6d79617070000c0280218021802180218021802180218021",
		},
		{
			name: "app and facilitator",
			data: BuilderCodeSuffixData{BuilderCodeExtensionData: BuilderCodeExtensionData{A: "bc_myapp", W: "bc_myfacilitator"}},
			want: "a261616862635f6d7961707061777062635f6d79666163696c697461746f72001f0280218021802180218021802180218021",
		},
		{
			name: "app, facilitator and metadata",
			data: BuilderCodeSuffixData{
				BuilderCodeExtensionData: BuilderCodeExtensionData{A: "bc_myapp", W: "bc_myfacilitator"},
				M:                        map[string]any{"x402Example": uint64(7)},
			},
			want: "a361616862635f6d7961707061777062635f6d79666163696c697461746f72616da16b783430324578616d706c6507002f0280218021802180218021802180218021",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := EncodeBuilderCodeSuffix(tt.data)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if hex.EncodeToString(got) != tt.want {
				t.Fatalf("suffix mismatch\n got: %s\nwant: %s", hex.EncodeToString(got), tt.want)
			}
		})
	}
}

func TestSuffixRoundTrip(t *testing.T) {
	suffix, err := EncodeBuilderCodeSuffix(BuilderCodeSuffixData{BuilderCodeExtensionData: BuilderCodeExtensionData{A: appCode, W: walletCode, S: []string{serviceCode}}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	calldata := "0xdeadbeef" + hex.EncodeToString(suffix)
	parsed, ok := ParseBuilderCodeSuffixFromCalldata(calldata)
	if !ok {
		t.Fatal("expected a valid suffix")
	}
	if parsed.A != appCode || parsed.W != walletCode || !reflect.DeepEqual(parsed.S, []string{serviceCode}) {
		t.Fatalf("round-trip mismatch: %+v", parsed)
	}
}

func TestSuffixRoundTripMultipleServiceCodes(t *testing.T) {
	want := []string{serviceCode, "bc_other"}
	suffix, err := EncodeBuilderCodeSuffix(BuilderCodeSuffixData{BuilderCodeExtensionData: BuilderCodeExtensionData{A: appCode, W: walletCode, S: want}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	calldata := "0xdeadbeef" + hex.EncodeToString(suffix)
	parsed, ok := ParseBuilderCodeSuffixFromCalldata(calldata)
	if !ok {
		t.Fatal("expected a valid suffix")
	}
	if parsed.A != appCode || parsed.W != walletCode || !reflect.DeepEqual(parsed.S, want) {
		t.Fatalf("round-trip mismatch: %+v", parsed)
	}
}

func TestParseNoSuffix(t *testing.T) {
	if _, ok := ParseBuilderCodeSuffixFromCalldata("0xdeadbeef"); ok {
		t.Fatal("expected no suffix for plain calldata")
	}
}

func TestParseSpecAppOnlyVector(t *testing.T) {
	calldata := "0xdeadbeefa161616862635f6d79617070000c0280218021802180218021802180218021"
	parsed, ok := ParseBuilderCodeSuffixFromCalldata(calldata)
	if !ok {
		t.Fatal("expected a valid suffix")
	}
	if parsed.A != "bc_myapp" || parsed.W != "" || len(parsed.S) != 0 {
		t.Fatalf("parse mismatch: %+v", parsed)
	}
}

func TestMetadataRoundTrip(t *testing.T) {
	metadata := map[string]any{
		"zero":      uint64(0),
		"inline":    uint64(23),
		"oneByte":   uint64(24),
		"twoBytes":  uint64(1 << 16),
		"fourBytes": uint64(1 << 32),
		"maxUint64": ^uint64(0),
		"text":      "hello",
		"list":      []any{uint64(1), "two", []any{uint64(3)}, map[string]any{"four": uint64(4)}},
		"nested":    map[string]any{"inner": map[string]any{"deep": uint64(1)}},
	}
	suffix, err := EncodeBuilderCodeSuffix(BuilderCodeSuffixData{
		BuilderCodeExtensionData: BuilderCodeExtensionData{A: appCode, W: walletCode, S: []string{serviceCode}},
		M:                        metadata,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	parsed, ok := ParseBuilderCodeSuffixFromCalldata("0xdeadbeef" + hex.EncodeToString(suffix))
	if !ok {
		t.Fatal("expected a valid suffix")
	}
	if !reflect.DeepEqual(parsed.M, metadata) {
		t.Fatalf("metadata mismatch\n got: %#v\nwant: %#v", parsed.M, metadata)
	}
}

func TestMetadataEncodingIsDeterministic(t *testing.T) {
	// Shorter encoded keys sort first: b, c, then aa.
	want := "a3616202616303626161" + "01"

	for _, m := range []map[string]any{
		{"aa": uint64(1), "b": uint64(2), "c": uint64(3)},
		{"c": 3, "b": 2, "aa": 1},
		{"c": uint64(3), "b": uint64(2), "aa": uint64(1)},
	} {
		suffix, err := EncodeBuilderCodeSuffix(BuilderCodeSuffixData{M: m})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !strings.Contains(hex.EncodeToString(suffix), want) {
			t.Fatalf("expected sorted keys %s in %x", want, suffix)
		}
	}
}

func TestMetadataTypedMapsMatchGenericMaps(t *testing.T) {
	typed, err := EncodeBuilderCodeSuffix(BuilderCodeSuffixData{M: map[string]any{
		"counts": map[string]uint64{"a": 1, "b": 2},
		"list":   []uint64{1, 2},
		"names":  []string{"x"},
	}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	generic, err := EncodeBuilderCodeSuffix(BuilderCodeSuffixData{M: map[string]any{
		"counts": map[string]any{"a": uint64(1), "b": uint64(2)},
		"list":   []any{uint64(1), uint64(2)},
		"names":  []any{"x"},
	}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !reflect.DeepEqual(typed, generic) {
		t.Fatalf("typed and generic metadata encode differently\n typed: %x\ngeneric: %x", typed, generic)
	}
}

func TestEncodeRejectsOversizedCbor(t *testing.T) {
	_, err := EncodeBuilderCodeSuffix(BuilderCodeSuffixData{M: map[string]any{"big": strings.Repeat("x", 0x10000)}})
	if err == nil {
		t.Fatal("expected an error when the CBOR exceeds 65535 bytes")
	}
}

func TestEncodeRejectsUnsupportedMetadataValues(t *testing.T) {
	type customStruct struct{ A uint64 }
	one := uint64(1)

	for name, value := range map[string]any{
		"negative":       -1,
		"float":          1.5,
		"bool":           true,
		"false":          false,
		"bytes":          []byte{1},
		"byte array":     [2]byte{1, 2},
		"nil":            nil,
		"time":           time.Unix(0, 0),
		"func":           func() {},
		"struct":         customStruct{A: 1},
		"pointer":        &one,
		"int8":           int8(1),
		"uint32":         uint32(1),
		"bool slice":     []bool{true},
		"typed map":      map[string]string{"k": "v"},
		"non-text keys":  map[int]uint64{1: 1},
		"channel":        make(chan int),
		"nested nil map": map[string]any{"k": nil},
	} {
		t.Run(name, func(t *testing.T) {
			wrappers := map[string]any{
				"direct": value,
				"array":  []any{value},
				"map":    map[string]any{"nested": map[string]any{"k": value}},
			}
			for position, wrapped := range wrappers {
				_, err := EncodeBuilderCodeSuffix(BuilderCodeSuffixData{M: map[string]any{"k": wrapped}})
				if err == nil {
					t.Fatalf("expected an error for %s (%s)", name, position)
				}
			}
		})
	}
}

func TestParseRejectsUnsupportedMetadata(t *testing.T) {
	for name, cborHex := range map[string]string{
		"negative integer":        "a1616d" + "a1616b20",
		"byte string":             "a1616d" + "a1616b4100",
		"float":                   "a1616d" + "a1616bf90000",
		"tag":                     "a1616d" + "a1616bc101",
		"boolean":                 "a1616d" + "a1616bf5",
		"indefinite-length array": "a1616d" + "a1616b9fff",
		"non-text map key":        "a1616d" + "a10100",
		"truncated value":         "a1616d" + "a1616b1b00",
		"m that is not a map":     "a1616d" + "01",
	} {
		t.Run(name, func(t *testing.T) {
			length := len(cborHex) / 2
			calldata := "0xdeadbeef" + cborHex + hex.EncodeToString([]byte{byte(length >> 8), byte(length)}) + "02" + ERC_8021_MARKER
			if _, ok := ParseBuilderCodeSuffixFromCalldata(calldata); ok {
				t.Fatalf("expected %s to be rejected", name)
			}
		})
	}
}
