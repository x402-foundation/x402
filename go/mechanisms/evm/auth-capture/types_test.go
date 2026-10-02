package authcapture

import "testing"

func TestIsEip3009Payload(t *testing.T) {
	future := "4102444800"
	valid := map[string]interface{}{
		"authorization": map[string]interface{}{
			"from":        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"to":          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"value":       "1000000",
			"validAfter":  "0",
			"validBefore": future,
			"nonce":       "0x1234567890123456789012345678901234567890123456789012345678901234",
		},
		"signature": "0xabcd",
		"salt":      "0x0000000000000000000000000000000000000000000000000000000000000abc",
	}

	if !IsEip3009Payload(valid) {
		t.Fatal("expected valid EIP-3009 payload")
	}

	noAuth := copyMap(valid)
	delete(noAuth, "authorization")
	if IsEip3009Payload(noAuth) {
		t.Fatal("expected missing authorization to be rejected")
	}

	noSig := copyMap(valid)
	delete(noSig, "signature")
	if IsEip3009Payload(noSig) {
		t.Fatal("expected missing signature to be rejected")
	}

	noSalt := copyMap(valid)
	delete(noSalt, "salt")
	if IsEip3009Payload(noSalt) {
		t.Fatal("expected missing salt to be rejected")
	}

	withSaltNonce := copyMap(valid)
	withSaltNonce["saltNonce"] = "0x0000000000000000000000000000000000000000000000000000000000000abc"
	if !IsEip3009Payload(withSaltNonce) {
		t.Fatal("expected bound payload with saltNonce")
	}

	lifecycle := copyMap(valid)
	lifecycle["type"] = "capture"
	if IsEip3009Payload(lifecycle) {
		t.Fatal("expected lifecycle payload to be rejected")
	}

	if IsEip3009Payload(validPermit2()) || IsEip3009Payload(nil) {
		t.Fatal("expected Permit2/null to be rejected")
	}
}

func TestIsPermit2Payload(t *testing.T) {
	valid := validPermit2()
	if !IsPermit2Payload(valid) {
		t.Fatal("expected valid Permit2 payload")
	}

	noPermit := copyMap(valid)
	delete(noPermit, "permit2Authorization")
	if IsPermit2Payload(noPermit) {
		t.Fatal("expected missing permit2Authorization to be rejected")
	}

	noSalt := copyMap(valid)
	delete(noSalt, "salt")
	if IsPermit2Payload(noSalt) {
		t.Fatal("expected missing salt to be rejected")
	}

	badFrom := copyMap(valid)
	auth := copyMap(valid["permit2Authorization"].(map[string]interface{}))
	auth["from"] = 42
	badFrom["permit2Authorization"] = auth
	if IsPermit2Payload(badFrom) {
		t.Fatal("expected non-string from to be rejected")
	}

	if IsPermit2Payload(validEip3009()) {
		t.Fatal("expected EIP-3009 payload to be rejected")
	}
}

func validEip3009() map[string]interface{} {
	return map[string]interface{}{
		"authorization": map[string]interface{}{
			"from":        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"to":          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"value":       "1000000",
			"validAfter":  "0",
			"validBefore": "4102444800",
			"nonce":       "0x1234567890123456789012345678901234567890123456789012345678901234",
		},
		"signature": "0xabcd",
		"salt":      "0x0000000000000000000000000000000000000000000000000000000000000abc",
	}
}

func validPermit2() map[string]interface{} {
	return map[string]interface{}{
		"permit2Authorization": map[string]interface{}{
			"from": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"permitted": map[string]interface{}{
				"token":  "0xeeee",
				"amount": "1000000",
			},
			"spender":  "0xdddd",
			"nonce":    "12345",
			"deadline": "4102444800",
		},
		"signature": "0xabcd",
		"salt":      "0x0000000000000000000000000000000000000000000000000000000000000abc",
	}
}

func copyMap(in map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(in))
	for k, v := range in {
		if nested, ok := v.(map[string]interface{}); ok {
			out[k] = copyMap(nested)
			continue
		}
		out[k] = v
	}
	return out
}

func validCapture() map[string]interface{} {
	return map[string]interface{}{
		"type":                     "capture",
		"paymentInfo":              validPaymentInfoWire(),
		"saltNonce":                "0x01",
		"amount":                   "600000",
		"feeAmount":                "0",
		"feeReceiver":              "0x4444444444444444444444444444444444444444",
		"expectedCapturableAmount": "400000",
		"expectedRefundableAmount": "0",
		"authorizerSignature":      "0xabcd",
	}
}

func validPaymentInfoWire() map[string]interface{} {
	wire, err := mockPaymentInfo().ToWireMap()
	if err != nil {
		panic(err)
	}
	return wire
}

func TestIsCapturePayload(t *testing.T) {
	valid := validCapture()
	if !IsCapturePayload(valid) {
		t.Fatal("expected a v1.1 capture payload")
	}

	v10 := copyMap(valid)
	delete(v10, "feeAmount")
	v10["feeBps"] = float64(50)
	if !IsCapturePayload(v10) {
		t.Fatal("expected a v1.0 capture payload")
	}

	both := copyMap(valid)
	both["feeBps"] = float64(50)
	neither := copyMap(valid)
	delete(neither, "feeAmount")
	noSaltNonce := copyMap(valid)
	delete(noSaltNonce, "saltNonce")
	noSignature := copyMap(valid)
	delete(noSignature, "authorizerSignature")
	badInfo := copyMap(valid)
	badInfo["paymentInfo"] = map[string]interface{}{}
	void := copyMap(valid)
	void["type"] = "void"

	for name, payload := range map[string]interface{}{
		"both fee fields": both, "no fee field": neither, "no saltNonce": noSaltNonce,
		"no signature": noSignature, "bad paymentInfo": badInfo, "wrong type": void, "nil": nil,
	} {
		if IsCapturePayload(payload) {
			t.Fatalf("expected %s to be rejected", name)
		}
	}
}

func TestIsVoidPayload(t *testing.T) {
	valid := map[string]interface{}{
		"type":                "void",
		"paymentInfo":         validPaymentInfoWire(),
		"saltNonce":           "0x01",
		"authorizerSignature": "0xabcd",
	}
	if !IsVoidPayload(valid) {
		t.Fatal("expected a void payload")
	}

	noSignature := copyMap(valid)
	delete(noSignature, "authorizerSignature")
	capture := copyMap(valid)
	capture["type"] = "capture"
	if IsVoidPayload(noSignature) || IsVoidPayload(capture) || IsVoidPayload("void") {
		t.Fatal("expected malformed void payloads to be rejected")
	}
}

func TestLifecyclePayloadParsing(t *testing.T) {
	capture, err := CapturePayloadFromMap(validCapture())
	if err != nil {
		t.Fatal(err)
	}
	if capture.Amount != "600000" || capture.FeeAmount != "0" || capture.FeeBps != nil || capture.PaymentInfo.MaxFeeBps != 100 {
		t.Fatalf("unexpected capture payload: %+v", capture)
	}

	v10 := validCapture()
	delete(v10, "feeAmount")
	v10["feeBps"] = float64(50)
	v10["voidAuthorizerSignature"] = "0xbeef"
	parsed, err := CapturePayloadFromMap(v10)
	if err != nil || parsed.FeeBps == nil || *parsed.FeeBps != 50 || parsed.VoidAuthorizerSignature != "0xbeef" {
		t.Fatalf("unexpected v1.0 capture payload: %+v, %v", parsed, err)
	}

	void, err := VoidPayloadFromMap(map[string]interface{}{
		"paymentInfo": validPaymentInfoWire(), "saltNonce": "0x01", "authorizerSignature": "0xabcd",
	})
	if err != nil || void.SaltNonce != "0x01" || void.AuthorizerSignature != "0xabcd" {
		t.Fatalf("unexpected void payload: %+v, %v", void, err)
	}

	if _, err := CapturePayloadFromMap(map[string]interface{}{}); err == nil {
		t.Fatal("expected a missing paymentInfo to fail")
	}
	if _, err := VoidPayloadFromMap(map[string]interface{}{"paymentInfo": map[string]interface{}{}}); err == nil {
		t.Fatal("expected an incomplete paymentInfo to fail")
	}
}
