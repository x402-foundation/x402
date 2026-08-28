package authcapture

import "testing"

func TestIsAuthCaptureExtra(t *testing.T) {
	future := float64(4102444800)
	valid := map[string]interface{}{
		"captureAuthorizer": "0xcccccccccccccccccccccccccccccccccccccccc",
		"captureDeadline":   future,
		"refundDeadline":    future + 86400,
		"feeRecipient":      "0x4444444444444444444444444444444444444444",
		"minFeeBps":         float64(0),
		"maxFeeBps":         float64(100),
		"name":              "USDC",
		"version":           "2",
	}

	if !IsAuthCaptureExtra(valid) {
		t.Fatal("expected valid extra")
	}
	if IsAuthCaptureExtra(nil) || IsAuthCaptureExtra("string") || IsAuthCaptureExtra(42) {
		t.Fatal("expected non-object to be rejected")
	}

	noAuthorizer := copyMap(valid)
	delete(noAuthorizer, "captureAuthorizer")
	if IsAuthCaptureExtra(noAuthorizer) {
		t.Fatal("expected missing captureAuthorizer to be rejected")
	}

	badDeadline := copyMap(valid)
	badDeadline["captureDeadline"] = "soon"
	if IsAuthCaptureExtra(badDeadline) {
		t.Fatal("expected non-number captureDeadline to be rejected")
	}

	badFeeRecipient := copyMap(valid)
	badFeeRecipient["feeRecipient"] = 42
	if IsAuthCaptureExtra(badFeeRecipient) {
		t.Fatal("expected non-string feeRecipient to be rejected")
	}

	noName := copyMap(valid)
	delete(noName, "name")
	if IsAuthCaptureExtra(noName) {
		t.Fatal("expected missing name to be rejected")
	}

	noMinFee := copyMap(valid)
	delete(noMinFee, "minFeeBps")
	if IsAuthCaptureExtra(noMinFee) {
		t.Fatal("expected missing minFeeBps to be rejected")
	}

	noMaxFee := copyMap(valid)
	delete(noMaxFee, "maxFeeBps")
	if IsAuthCaptureExtra(noMaxFee) {
		t.Fatal("expected missing maxFeeBps to be rejected")
	}

	oldShape := map[string]interface{}{
		"escrowAddress":   "0xeee",
		"operatorAddress": "0xccc",
		"tokenCollector":  "0xbbb",
		"name":            "USDC",
		"version":         "2",
	}
	if IsAuthCaptureExtra(oldShape) {
		t.Fatal("expected old commerce-era extra to be rejected")
	}
}

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
