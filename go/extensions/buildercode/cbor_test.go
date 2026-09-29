package buildercode

import (
	"encoding/hex"
	"reflect"
	"testing"
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
		data BuilderCodeExtensionData
		want string
	}{
		{
			name: "app only",
			data: BuilderCodeExtensionData{A: "bc_myapp"},
			want: "a161616862635f6d79617070000c0280218021802180218021802180218021",
		},
		{
			name: "app and facilitator",
			data: BuilderCodeExtensionData{A: "bc_myapp", W: "bc_myfacilitator"},
			want: "a261616862635f6d7961707061777062635f6d79666163696c697461746f72001f0280218021802180218021802180218021",
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
	suffix, err := EncodeBuilderCodeSuffix(BuilderCodeExtensionData{A: appCode, W: walletCode, S: []string{serviceCode}})
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
	suffix, err := EncodeBuilderCodeSuffix(BuilderCodeExtensionData{A: appCode, W: walletCode, S: want})
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
