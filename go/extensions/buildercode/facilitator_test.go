package buildercode

import (
	"encoding/hex"
	"reflect"
	"testing"

	evm "github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// suffixContext builds a facilitator data-suffix context from optional
// payment-payload builder-code extension info.
func suffixContext(info map[string]interface{}) evm.DataSuffixContext {
	var extensions map[string]interface{}
	if info != nil {
		extensions = map[string]interface{}{
			BUILDER_CODE: map[string]interface{}{"info": info, "schema": map[string]interface{}{}},
		}
	}
	return evm.DataSuffixContext{
		Payload: types.PaymentPayload{X402Version: 2, Extensions: extensions},
	}
}

// parsedFromFacilitator runs BuildDataSuffix with a configured wallet code and
// parses attribution back out of synthetic calldata.
func parsedFromFacilitator(t *testing.T, ctx evm.DataSuffixContext) *BuilderCodeExtensionData {
	t.Helper()
	ext := &BuilderCodeFacilitatorExtension{BuilderCode: walletCode}
	suffix, err := ext.BuildDataSuffix(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(suffix) == 0 {
		t.Fatal("expected builder-code suffix")
	}
	parsed, ok := ParseBuilderCodeSuffixFromCalldata("0xdeadbeef" + hex.EncodeToString(suffix))
	if !ok {
		t.Fatal("expected a valid suffix")
	}
	return parsed
}

func TestBuildDataSuffixWalletOnly(t *testing.T) {
	parsed := parsedFromFacilitator(t, suffixContext(nil))
	if parsed.W != walletCode || parsed.A != "" || len(parsed.S) != 0 {
		t.Fatalf("expected wallet code only, got %+v", parsed)
	}
}

func TestBuildDataSuffixOmitsWalletWhenUnset(t *testing.T) {
	ext := &BuilderCodeFacilitatorExtension{}
	ctx := suffixContext(map[string]interface{}{"a": appCode, "s": serviceCode})
	suffix, err := ext.BuildDataSuffix(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	parsed, ok := ParseBuilderCodeSuffixFromCalldata("0xdeadbeef" + hex.EncodeToString(suffix))
	if !ok {
		t.Fatal("expected a valid suffix")
	}
	if parsed.A != appCode || !reflect.DeepEqual(parsed.S, []string{serviceCode}) || parsed.W != "" {
		t.Fatalf("expected app+service only, got %+v", parsed)
	}
}

func TestBuildDataSuffixNoAttribution(t *testing.T) {
	ext := &BuilderCodeFacilitatorExtension{}
	suffix, err := ext.BuildDataSuffix(suffixContext(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if suffix != nil {
		t.Fatalf("expected nil suffix, got %x", suffix)
	}
}

func TestBuildDataSuffixSpecShapedCodes(t *testing.T) {
	parsed := parsedFromFacilitator(t, suffixContext(map[string]interface{}{"a": appCode, "s": serviceCode}))
	if parsed.W != walletCode || parsed.A != appCode || !reflect.DeepEqual(parsed.S, []string{serviceCode}) {
		t.Fatalf("expected all codes, got %+v", parsed)
	}
}

func TestBuildDataSuffixServiceCodeArray(t *testing.T) {
	info := map[string]interface{}{"s": []interface{}{"INVALID", serviceCode, "bc_other"}}
	parsed := parsedFromFacilitator(t, suffixContext(info))
	if parsed.W != walletCode || !reflect.DeepEqual(parsed.S, []string{serviceCode, "bc_other"}) {
		t.Fatalf("expected all valid service codes, got %+v", parsed)
	}
}

func TestBuildDataSuffixTruncatesServiceCodesToFive(t *testing.T) {
	codes := []interface{}{"bc_1", "bc_2", "bc_3", "bc_4", "bc_5", "bc_6", "bc_7"}
	parsed := parsedFromFacilitator(t, suffixContext(map[string]interface{}{"s": codes}))
	want := []string{"bc_1", "bc_2", "bc_3", "bc_4", "bc_5"}
	if parsed.W != walletCode || !reflect.DeepEqual(parsed.S, want) {
		t.Fatalf("expected first 5 service codes, got %+v", parsed)
	}
}

func TestBuildDataSuffixFiltersInvalidBeforeTruncatingToFive(t *testing.T) {
	info := map[string]interface{}{
		"s": []interface{}{"INVALID", "bc_1", "bc_2", "bc_3", "bc_4", "bc_5", "bc_6", "bc_7", "bc_8"},
	}
	parsed := parsedFromFacilitator(t, suffixContext(info))
	want := []string{"bc_1", "bc_2", "bc_3", "bc_4", "bc_5"}
	if parsed.W != walletCode || !reflect.DeepEqual(parsed.S, want) {
		t.Fatalf("expected first 5 valid service codes, got %+v", parsed)
	}
}

func TestBuildDataSuffixIgnoresInvalidServiceCode(t *testing.T) {
	parsed := parsedFromFacilitator(t, suffixContext(map[string]interface{}{"s": "Also_Invalid"}))
	if parsed.W != walletCode || len(parsed.S) != 0 || parsed.A != "" {
		t.Fatalf("expected wallet code only, got %+v", parsed)
	}
}

func TestBuildDataSuffixReadsAppCode(t *testing.T) {
	parsed := parsedFromFacilitator(t, suffixContext(map[string]interface{}{"a": appCode}))
	if parsed.W != walletCode || parsed.A != appCode || len(parsed.S) != 0 {
		t.Fatalf("expected wallet+app, got %+v", parsed)
	}
}

func TestBuildDataSuffixIgnoresInvalidWalletCode(t *testing.T) {
	ext := &BuilderCodeFacilitatorExtension{BuilderCode: "X"}
	suffix, err := ext.BuildDataSuffix(suffixContext(map[string]interface{}{"a": appCode}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	parsed, ok := ParseBuilderCodeSuffixFromCalldata("0xdeadbeef" + hex.EncodeToString(suffix))
	if !ok {
		t.Fatal("expected a valid suffix")
	}
	if parsed.W != "" || parsed.A != appCode {
		t.Fatalf("expected invalid wallet code dropped, got %+v", parsed)
	}
}
