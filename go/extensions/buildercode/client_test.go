package buildercode

import (
	"context"
	"fmt"
	"reflect"
	"testing"

	"github.com/x402-foundation/x402/go/v2/types"
)

func TestNewBuilderCodeClientExtensionRejectsInvalidCode(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for invalid service code")
		}
	}()
	NewBuilderCodeClientExtension("Bad-Code")
}

func TestNewBuilderCodeClientExtensionRejectsTooManyCodes(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for too many service codes")
		}
	}()
	codes := make([]string, MAX_CLIENT_SERVICE_CODES+1)
	for i := range codes {
		codes[i] = fmt.Sprintf("bc_%d", i)
	}
	NewBuilderCodeClientExtension(codes...)
}

func TestNewBuilderCodeClientExtensionAcceptsMaxCodes(t *testing.T) {
	codes := make([]string, MAX_CLIENT_SERVICE_CODES)
	for i := range codes {
		codes[i] = fmt.Sprintf("bc_%d", i)
	}
	NewBuilderCodeClientExtension(codes...)
}

func TestClientExtensionKey(t *testing.T) {
	if got := NewBuilderCodeClientExtension(serviceCode).Key(); got != BUILDER_CODE {
		t.Fatalf("expected key %q, got %q", BUILDER_CODE, got)
	}
}

func TestClientExtensionAttachesServiceCode(t *testing.T) {
	ext := NewBuilderCodeClientExtension(serviceCode)
	enriched, err := ext.EnrichPaymentPayload(context.Background(), types.PaymentPayload{X402Version: 2}, types.PaymentRequired{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := map[string]interface{}{"info": map[string]interface{}{"s": []string{serviceCode}}}
	if !reflect.DeepEqual(enriched.Extensions[BUILDER_CODE], want) {
		t.Fatalf("expected %v, got %v", want, enriched.Extensions[BUILDER_CODE])
	}
}

func TestClientExtensionAttachesMultipleServiceCodes(t *testing.T) {
	ext := NewBuilderCodeClientExtension(serviceCode, "bc_other")
	enriched, err := ext.EnrichPaymentPayload(context.Background(), types.PaymentPayload{X402Version: 2}, types.PaymentRequired{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := map[string]interface{}{"info": map[string]interface{}{"s": []string{serviceCode, "bc_other"}}}
	if !reflect.DeepEqual(enriched.Extensions[BUILDER_CODE], want) {
		t.Fatalf("expected %v, got %v", want, enriched.Extensions[BUILDER_CODE])
	}
}

func TestClientExtensionPreservesUnrelatedExtensions(t *testing.T) {
	ext := NewBuilderCodeClientExtension(serviceCode)
	payload := types.PaymentPayload{
		X402Version: 2,
		Extensions:  map[string]interface{}{"other": map[string]interface{}{"kept": true}},
	}

	enriched, err := ext.EnrichPaymentPayload(context.Background(), payload, types.PaymentRequired{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !reflect.DeepEqual(enriched.Extensions["other"], map[string]interface{}{"kept": true}) {
		t.Fatalf("unrelated extension not preserved: %v", enriched.Extensions["other"])
	}
	want := map[string]interface{}{"info": map[string]interface{}{"s": []string{serviceCode}}}
	if !reflect.DeepEqual(enriched.Extensions[BUILDER_CODE], want) {
		t.Fatalf("expected %v, got %v", want, enriched.Extensions[BUILDER_CODE])
	}
}

func TestDeclareBuilderCodeExtensionRejectsInvalidCode(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for invalid app code")
		}
	}()
	DeclareBuilderCodeExtension("INVALID")
}

func TestDeclareBuilderCodeExtensionShape(t *testing.T) {
	declared := DeclareBuilderCodeExtension(appCode)
	ext, ok := declared[BUILDER_CODE].(map[string]interface{})
	if !ok {
		t.Fatalf("expected builder-code map, got %T", declared[BUILDER_CODE])
	}
	info, ok := ext["info"].(map[string]interface{})
	if !ok || info["a"] != appCode {
		t.Fatalf("expected info.a=%q, got %+v", appCode, ext["info"])
	}
	if _, ok := ext["schema"]; !ok {
		t.Fatal("expected schema in declaration")
	}
	if _, hasS := info["s"]; hasS {
		t.Fatalf("expected no s field when no service codes given, got %+v", info)
	}
}

func TestDeclareBuilderCodeExtensionWithServiceCodes(t *testing.T) {
	declared := DeclareBuilderCodeExtension(appCode, "bc_server_sdk", "bc_other")
	ext := declared[BUILDER_CODE].(map[string]interface{})
	info := ext["info"].(map[string]interface{})
	want := []string{"bc_server_sdk", "bc_other"}
	if !reflect.DeepEqual(info["s"], want) {
		t.Fatalf("expected s=%v, got %v", want, info["s"])
	}
}

func TestDeclareBuilderCodeExtensionRejectsInvalidServiceCode(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for invalid service code")
		}
	}()
	DeclareBuilderCodeExtension(appCode, "Bad-Code")
}

func TestDeclareBuilderCodeExtensionRejectsTooManyServiceCodes(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for too many service codes")
		}
	}()
	codes := make([]string, MAX_SERVER_SERVICE_CODES+1)
	for i := range codes {
		codes[i] = fmt.Sprintf("bc_%d", i)
	}
	DeclareBuilderCodeExtension(appCode, codes...)
}

func TestDeclareBuilderCodeExtensionAcceptsMaxServiceCodes(t *testing.T) {
	codes := make([]string, MAX_SERVER_SERVICE_CODES)
	for i := range codes {
		codes[i] = fmt.Sprintf("bc_%d", i)
	}
	DeclareBuilderCodeExtension(appCode, codes...)
}
