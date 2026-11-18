package eip2612gassponsor

import (
	"testing"
)

func TestExtractEip2612GasSponsoringInfo(t *testing.T) {
	t.Run("returns nil for nil extensions", func(t *testing.T) {
		result, err := ExtractEip2612GasSponsoringInfo(nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != nil {
			t.Fatal("expected nil result for nil extensions")
		}
	})

	t.Run("returns nil for missing extension", func(t *testing.T) {
		extensions := map[string]interface{}{
			"otherExtension": map[string]interface{}{},
		}
		result, err := ExtractEip2612GasSponsoringInfo(extensions)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != nil {
			t.Fatal("expected nil result for missing extension")
		}
	})

	t.Run("returns nil for server-only info (incomplete)", func(t *testing.T) {
		extensions := map[string]interface{}{
			EIP2612GasSponsoring.Key(): map[string]interface{}{
				"info": map[string]interface{}{
					"description": "test",
					"version":     "1",
				},
				"schema": map[string]interface{}{},
			},
		}
		result, err := ExtractEip2612GasSponsoringInfo(extensions)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result != nil {
			t.Fatal("expected nil result for incomplete info")
		}
	})

	t.Run("extracts valid info", func(t *testing.T) {
		extensions := map[string]interface{}{
			EIP2612GasSponsoring.Key(): map[string]interface{}{
				"info": map[string]interface{}{
					"from":      "0x857b06519E91e3A54538791bDbb0E22373e36b66",
					"asset":     "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
					"spender":   "0x000000000022D473030F116dDEE9F6B43aC78BA3",
					"amount":    "115792089237316195423570985008687907853269984665640564039457584007913129639935",
					"nonce":     "0",
					"deadline":  "1740672154",
					"signature": "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
					"version":   "1",
				},
				"schema": map[string]interface{}{},
			},
		}
		result, err := ExtractEip2612GasSponsoringInfo(extensions)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if result == nil {
			t.Fatal("expected non-nil result")
		}
		if result.From != "0x857b06519E91e3A54538791bDbb0E22373e36b66" {
			t.Errorf("unexpected from: %s", result.From)
		}
		if result.Version != "1" {
			t.Errorf("unexpected version: %s", result.Version)
		}
	})
}

func TestValidateEip2612GasSponsoringInfo(t *testing.T) {
	t.Run("validates correct info", func(t *testing.T) {
		info := &Info{
			From:      "0x857b06519E91e3A54538791bDbb0E22373e36b66",
			Asset:     "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Spender:   "0x000000000022D473030F116dDEE9F6B43aC78BA3",
			Amount:    "115792089237316195423570985008687907853269984665640564039457584007913129639935",
			Nonce:     "0",
			Deadline:  "1740672154",
			Signature: "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c340",
			Version:   "1",
		}
		if !ValidateEip2612GasSponsoringInfo(info) {
			t.Fatal("expected valid info")
		}
	})

	t.Run("rejects invalid address", func(t *testing.T) {
		info := &Info{
			From:      "invalid",
			Asset:     "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Spender:   "0x000000000022D473030F116dDEE9F6B43aC78BA3",
			Amount:    "100",
			Nonce:     "0",
			Deadline:  "1740672154",
			Signature: "0xabc",
			Version:   "1",
		}
		if ValidateEip2612GasSponsoringInfo(info) {
			t.Fatal("expected invalid info for bad address")
		}
	})

	t.Run("rejects non-numeric amount", func(t *testing.T) {
		info := &Info{
			From:      "0x857b06519E91e3A54538791bDbb0E22373e36b66",
			Asset:     "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Spender:   "0x000000000022D473030F116dDEE9F6B43aC78BA3",
			Amount:    "not-a-number",
			Nonce:     "0",
			Deadline:  "1740672154",
			Signature: "0xabc",
			Version:   "1",
		}
		if ValidateEip2612GasSponsoringInfo(info) {
			t.Fatal("expected invalid info for bad amount")
		}
	})
}
