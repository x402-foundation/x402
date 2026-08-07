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

func TestBuildDataSuffixTruncatesServiceCodesToEchoedBudget(t *testing.T) {
	codes := []interface{}{
		"bc_1", "bc_2", "bc_3", "bc_4", "bc_5", "bc_6", "bc_7", "bc_8", "bc_9", "bc_10", "bc_11",
	}
	parsed := parsedFromFacilitator(t, suffixContext(map[string]interface{}{"s": codes}))
	want := []string{"bc_1", "bc_2", "bc_3", "bc_4", "bc_5", "bc_6", "bc_7", "bc_8", "bc_9", "bc_10"}
	if parsed.W != walletCode || !reflect.DeepEqual(parsed.S, want) {
		t.Fatalf("expected first %d service codes, got %+v", maxEchoedServiceCodes, parsed)
	}
}

func TestBuildDataSuffixFiltersInvalidBeforeTruncatingToEchoedBudget(t *testing.T) {
	info := map[string]interface{}{
		"s": []interface{}{
			"INVALID", "bc_1", "bc_2", "bc_3", "bc_4", "bc_5", "bc_6", "bc_7", "bc_8", "bc_9", "bc_10", "bc_11", "bc_12",
		},
	}
	parsed := parsedFromFacilitator(t, suffixContext(info))
	want := []string{"bc_1", "bc_2", "bc_3", "bc_4", "bc_5", "bc_6", "bc_7", "bc_8", "bc_9", "bc_10"}
	if parsed.W != walletCode || !reflect.DeepEqual(parsed.S, want) {
		t.Fatalf("expected first %d valid service codes, got %+v", maxEchoedServiceCodes, parsed)
	}
}

func TestBuildDataSuffixDoesNotDropServerEntriesWhenClientAndServerUseFullReservation(t *testing.T) {
	// Regression test: client provides MAX_CLIENT_SERVICE_CODES codes and server
	// provides MAX_SERVER_SERVICE_CODES codes; neither side should crowd out the other.
	clientCodes := []string{"bc_c1", "bc_c2", "bc_c3", "bc_c4", "bc_c5"}
	serverCodes := []string{"bc_s1", "bc_s2", "bc_s3", "bc_s4", "bc_s5"}
	info := map[string]interface{}{"s": append(append([]string{}, clientCodes...), serverCodes...)}
	parsed := parsedFromFacilitator(t, suffixContext(info))
	want := append(append([]string{}, clientCodes...), serverCodes...)
	if parsed.W != walletCode || !reflect.DeepEqual(parsed.S, want) {
		t.Fatalf("expected all client and server codes, got %+v", parsed)
	}
}

func TestBuildDataSuffixAppendsFacilitatorServiceCodeAfterEchoedCodes(t *testing.T) {
	ext := &BuilderCodeFacilitatorExtension{BuilderCode: walletCode, ServiceCode: "bc_fac"}
	ctx := suffixContext(map[string]interface{}{"s": serviceCode})
	suffix, err := ext.BuildDataSuffix(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	parsed, ok := ParseBuilderCodeSuffixFromCalldata("0xdeadbeef" + hex.EncodeToString(suffix))
	if !ok {
		t.Fatal("expected a valid suffix")
	}
	want := []string{serviceCode, "bc_fac"}
	if parsed.W != walletCode || !reflect.DeepEqual(parsed.S, want) {
		t.Fatalf("expected facilitator service code appended, got %+v", parsed)
	}
}

func TestBuildDataSuffixDoesNotDuplicateFacilitatorServiceCodeWhenAlreadyEchoed(t *testing.T) {
	ext := &BuilderCodeFacilitatorExtension{BuilderCode: walletCode, ServiceCode: serviceCode}
	ctx := suffixContext(map[string]interface{}{"s": serviceCode})
	suffix, err := ext.BuildDataSuffix(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	parsed, ok := ParseBuilderCodeSuffixFromCalldata("0xdeadbeef" + hex.EncodeToString(suffix))
	if !ok {
		t.Fatal("expected a valid suffix")
	}
	want := []string{serviceCode}
	if parsed.W != walletCode || !reflect.DeepEqual(parsed.S, want) {
		t.Fatalf("expected no duplicate service code, got %+v", parsed)
	}
}

func TestBuildDataSuffixRejectsInvalidFacilitatorServiceCode(t *testing.T) {
	ext := &BuilderCodeFacilitatorExtension{BuilderCode: walletCode, ServiceCode: "Bad-Code"}
	ctx := suffixContext(map[string]interface{}{"a": appCode})
	suffix, err := ext.BuildDataSuffix(ctx)
	if err == nil {
		t.Fatal("expected an error for an invalid facilitator service code")
	}
	if suffix != nil {
		t.Fatalf("expected no suffix on error, got %x", suffix)
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
