package erc20approvalgassponsor

import (
	"testing"
)

func TestExtractInfo(t *testing.T) {
	validInfo := map[string]interface{}{
		"from":              "0x1234567890123456789012345678901234567890",
		"asset":             "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
		"spender":           "0x000000000022D473030F116dDEE9F6B43aC78BA3",
		"amount":            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
		"signedTransaction": "0x02f8a48201f4808459682f0085174876e800830111708080b844095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		"version":           "1",
	}

	t.Run("valid full info", func(t *testing.T) {
		extensions := map[string]interface{}{
			"erc20ApprovalGasSponsoring": map[string]interface{}{
				"info":   validInfo,
				"schema": map[string]interface{}{},
			},
		}
		info, err := ExtractInfo(extensions)
		if err != nil {
			t.Fatalf("expected no error, got: %v", err)
		}
		if info == nil {
			t.Fatal("expected info, got nil")
		}
		if info.From != validInfo["from"] {
			t.Errorf("expected From=%s, got %s", validInfo["from"], info.From)
		}
		if info.SignedTransaction != validInfo["signedTransaction"] {
			t.Errorf("expected SignedTransaction=%s, got %s", validInfo["signedTransaction"], info.SignedTransaction)
		}
	})

	t.Run("nil extensions", func(t *testing.T) {
		info, err := ExtractInfo(nil)
		if err != nil {
			t.Fatalf("expected no error, got: %v", err)
		}
		if info != nil {
			t.Fatalf("expected nil, got: %+v", info)
		}
	})

	t.Run("missing key", func(t *testing.T) {
		extensions := map[string]interface{}{
			"someOtherExtension": map[string]interface{}{},
		}
		info, err := ExtractInfo(extensions)
		if err != nil {
			t.Fatalf("expected no error, got: %v", err)
		}
		if info != nil {
			t.Fatalf("expected nil, got: %+v", info)
		}
	})

	t.Run("incomplete fields - missing signedTransaction", func(t *testing.T) {
		incompleteInfo := map[string]interface{}{
			"from":    "0x1234567890123456789012345678901234567890",
			"asset":   "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
			"spender": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
			"amount":  "12345",
			"version": "1",
			// signedTransaction is missing
		}
		extensions := map[string]interface{}{
			"erc20ApprovalGasSponsoring": map[string]interface{}{
				"info":   incompleteInfo,
				"schema": map[string]interface{}{},
			},
		}
		info, err := ExtractInfo(extensions)
		if err != nil {
			t.Fatalf("expected no error, got: %v", err)
		}
		if info != nil {
			t.Fatalf("expected nil for incomplete fields, got: %+v", info)
		}
	})
}

func TestValidateInfo(t *testing.T) {
	validInfo := &Info{
		From:              "0x1234567890123456789012345678901234567890",
		Asset:             "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
		Spender:           "0x000000000022D473030F116dDEE9F6B43aC78BA3",
		Amount:            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
		SignedTransaction: "0x02f8a4",
		Version:           "1",
	}

	t.Run("valid info", func(t *testing.T) {
		if !ValidateInfo(validInfo) {
			t.Error("expected valid info to pass validation")
		}
	})

	t.Run("bad from address", func(t *testing.T) {
		info := *validInfo
		info.From = "not-an-address"
		if ValidateInfo(&info) {
			t.Error("expected validation to fail for bad from address")
		}
	})

	t.Run("bad signedTransaction - not hex", func(t *testing.T) {
		info := *validInfo
		info.SignedTransaction = "not-hex-data"
		if ValidateInfo(&info) {
			t.Error("expected validation to fail for non-hex signedTransaction")
		}
	})

	t.Run("bad amount - non-numeric", func(t *testing.T) {
		info := *validInfo
		info.Amount = "not-a-number"
		if ValidateInfo(&info) {
			t.Error("expected validation to fail for non-numeric amount")
		}
	})

	t.Run("bad version", func(t *testing.T) {
		info := *validInfo
		info.Version = "not-a-version"
		if ValidateInfo(&info) {
			t.Error("expected validation to fail for bad version")
		}
	})

	t.Run("valid version with minor", func(t *testing.T) {
		info := *validInfo
		info.Version = "1.0"
		if !ValidateInfo(&info) {
			t.Error("expected version '1.0' to pass validation")
		}
	})
}
