package batched

import (
	"reflect"
	"testing"
)

func validChannelConfigMap() map[string]interface{} {
	return map[string]interface{}{
		"payer":              "0x1111111111111111111111111111111111111111",
		"payerAuthorizer":    "0x2222222222222222222222222222222222222222",
		"receiver":           "0x3333333333333333333333333333333333333333",
		"receiverAuthorizer": "0x4444444444444444444444444444444444444444",
		"token":              "0x5555555555555555555555555555555555555555",
		"withdrawDelay":      float64(900),
		"salt":               "0x0000000000000000000000000000000000000000000000000000000000000001",
	}
}

func validVoucherSubMap() map[string]interface{} {
	return map[string]interface{}{
		"channelId":          "0xabc",
		"maxClaimableAmount": "1000",
		"signature":          "0xsig",
	}
}

func validDepositPayloadMap() map[string]interface{} {
	return map[string]interface{}{
		"type": "deposit",
		"deposit": map[string]interface{}{
			"channelConfig": validChannelConfigMap(),
			"amount":        "1000",
			"authorization": map[string]interface{}{
				"erc3009Authorization": map[string]interface{}{
					"validAfter":  "0",
					"validBefore": "9999999999",
					"salt":        "0x01",
					"signature":   "0xdeadbeef",
				},
			},
		},
		"voucher": validVoucherSubMap(),
	}
}

func validVoucherPayloadMap() map[string]interface{} {
	return map[string]interface{}{
		"type":               "voucher",
		"channelConfig":      validChannelConfigMap(),
		"channelId":          "0xabc",
		"maxClaimableAmount": "500",
		"signature":          "0xsig",
	}
}

// ---------- Type guards ----------

func TestIsDepositPayload(t *testing.T) {
	tests := []struct {
		name string
		in   map[string]interface{}
		want bool
	}{
		{"valid", validDepositPayloadMap(), true},
		{"wrong type", map[string]interface{}{"type": "voucher", "deposit": 1, "voucher": 1}, false},
		{"missing deposit", map[string]interface{}{"type": "deposit", "voucher": 1}, false},
		{"missing voucher", map[string]interface{}{"type": "deposit", "deposit": 1}, false},
		{"empty", map[string]interface{}{}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsDepositPayload(tc.in); got != tc.want {
				t.Fatalf("IsDepositPayload = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsVoucherPayload(t *testing.T) {
	tests := []struct {
		name string
		in   map[string]interface{}
		want bool
	}{
		{"valid", validVoucherPayloadMap(), true},
		{"wrong type", map[string]interface{}{"type": "deposit", "channelConfig": 1, "channelId": 1, "maxClaimableAmount": 1, "signature": 1}, false},
		{"missing config", map[string]interface{}{"type": "voucher", "channelId": 1, "maxClaimableAmount": 1, "signature": 1}, false},
		{"missing id", map[string]interface{}{"type": "voucher", "channelConfig": 1, "maxClaimableAmount": 1, "signature": 1}, false},
		{"missing amount", map[string]interface{}{"type": "voucher", "channelConfig": 1, "channelId": 1, "signature": 1}, false},
		{"missing signature", map[string]interface{}{"type": "voucher", "channelConfig": 1, "channelId": 1, "maxClaimableAmount": 1}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsVoucherPayload(tc.in); got != tc.want {
				t.Fatalf("IsVoucherPayload = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsClaimWithSignaturePayload(t *testing.T) {
	tests := []struct {
		name string
		in   map[string]interface{}
		want bool
	}{
		{"valid", map[string]interface{}{"settleAction": "claimWithSignature", "claims": []interface{}{}}, true},
		{"wrong action", map[string]interface{}{"settleAction": "settle", "claims": []interface{}{}}, false},
		{"missing claims", map[string]interface{}{"settleAction": "claimWithSignature"}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsClaimWithSignaturePayload(tc.in); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsSettleActionPayload(t *testing.T) {
	tests := []struct {
		name string
		in   map[string]interface{}
		want bool
	}{
		{"valid", map[string]interface{}{"settleAction": "settle", "receiver": "0x1", "token": "0x2"}, true},
		{"wrong action", map[string]interface{}{"settleAction": "claim", "receiver": "0x1", "token": "0x2"}, false},
		{"missing receiver", map[string]interface{}{"settleAction": "settle", "token": "0x2"}, false},
		{"missing token", map[string]interface{}{"settleAction": "settle", "receiver": "0x1"}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsSettleActionPayload(tc.in); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsDepositSettlePayload(t *testing.T) {
	tests := []struct {
		name string
		in   map[string]interface{}
		want bool
	}{
		{"valid", map[string]interface{}{"settleAction": "deposit", "deposit": map[string]interface{}{}}, true},
		{"wrong action", map[string]interface{}{"settleAction": "settle", "deposit": map[string]interface{}{}}, false},
		{"missing deposit", map[string]interface{}{"settleAction": "deposit"}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsDepositSettlePayload(tc.in); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsRefundWithSignaturePayload(t *testing.T) {
	tests := []struct {
		name string
		in   map[string]interface{}
		want bool
	}{
		{"valid", map[string]interface{}{"settleAction": "refundWithSignature", "config": map[string]interface{}{}}, true},
		{"wrong action", map[string]interface{}{"settleAction": "settle", "config": map[string]interface{}{}}, false},
		{"missing config", map[string]interface{}{"settleAction": "refundWithSignature"}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsRefundWithSignaturePayload(tc.in); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsBatchedPayload(t *testing.T) {
	if !IsBatchedPayload(validDepositPayloadMap()) {
		t.Fatal("deposit map should be batched")
	}
	if !IsBatchedPayload(validVoucherPayloadMap()) {
		t.Fatal("voucher map should be batched")
	}
	if IsBatchedPayload(map[string]interface{}{"type": "other"}) {
		t.Fatal("unrelated map should not be batched")
	}
}

// ---------- ChannelConfigFromMap ----------

func TestChannelConfigFromMap_AllNumericTypes(t *testing.T) {
	for _, delay := range []interface{}{float64(900), int(900), int64(900)} {
		m := validChannelConfigMap()
		m["withdrawDelay"] = delay
		cc, err := ChannelConfigFromMap(m)
		if err != nil {
			t.Fatalf("withdrawDelay %T: %v", delay, err)
		}
		if cc.WithdrawDelay != 900 {
			t.Fatalf("withdrawDelay %T: got %d", delay, cc.WithdrawDelay)
		}
	}
}

func TestChannelConfigFromMap_MissingFields(t *testing.T) {
	required := []string{"payer", "payerAuthorizer", "receiver", "receiverAuthorizer", "token", "salt", "withdrawDelay"}
	for _, field := range required {
		m := validChannelConfigMap()
		delete(m, field)
		if _, err := ChannelConfigFromMap(m); err == nil {
			t.Fatalf("expected error when missing %s", field)
		}
	}
}

func TestChannelConfigFromMap_InvalidWithdrawDelay(t *testing.T) {
	m := validChannelConfigMap()
	m["withdrawDelay"] = "string"
	if _, err := ChannelConfigFromMap(m); err == nil {
		t.Fatal("expected error for string withdrawDelay")
	}
}

// ---------- DepositPayloadFromMap / ToMap round-trip ----------

func TestDepositPayloadFromMap_ToMap_RoundTrip(t *testing.T) {
	original := validDepositPayloadMap()
	original["voucher"].(map[string]interface{})["refund"] = true
	original["voucher"].(map[string]interface{})["refundAmount"] = "200"
	original["responseExtra"] = map[string]interface{}{"k": "v"}

	p, err := DepositPayloadFromMap(original)
	if err != nil {
		t.Fatalf("DepositPayloadFromMap: %v", err)
	}
	if p.Type != "deposit" {
		t.Fatalf("Type = %s", p.Type)
	}
	if p.Deposit.Amount != "1000" {
		t.Fatalf("Amount = %s", p.Deposit.Amount)
	}
	if p.Deposit.Authorization.Erc3009Authorization == nil {
		t.Fatal("missing erc3009 authorization")
	}
	if !p.Voucher.Refund || p.Voucher.RefundAmount != "200" {
		t.Fatalf("voucher refund=%v amount=%q", p.Voucher.Refund, p.Voucher.RefundAmount)
	}
	if p.ResponseExtra["k"] != "v" {
		t.Fatalf("responseExtra not preserved")
	}

	out := p.ToMap()
	if out["type"] != "deposit" {
		t.Fatalf("ToMap type = %v", out["type"])
	}
	voucher := out["voucher"].(map[string]interface{})
	if voucher["refund"] != true || voucher["refundAmount"] != "200" {
		t.Fatalf("ToMap voucher = %v", voucher)
	}
}

func TestDepositPayloadFromMap_MissingDeposit(t *testing.T) {
	if _, err := DepositPayloadFromMap(map[string]interface{}{"type": "deposit"}); err == nil {
		t.Fatal("expected error")
	}
}

func TestDepositPayloadFromMap_MissingChannelConfig(t *testing.T) {
	in := map[string]interface{}{"type": "deposit", "deposit": map[string]interface{}{"amount": "1"}}
	if _, err := DepositPayloadFromMap(in); err == nil {
		t.Fatal("expected error")
	}
}

func TestDepositPayloadFromMap_InvalidChannelConfig(t *testing.T) {
	bad := validChannelConfigMap()
	delete(bad, "payer")
	in := map[string]interface{}{"type": "deposit", "deposit": map[string]interface{}{"channelConfig": bad}}
	if _, err := DepositPayloadFromMap(in); err == nil {
		t.Fatal("expected error")
	}
}

// ---------- VoucherPayloadFromMap / ToMap round-trip ----------

func TestVoucherPayloadFromMap_ToMap_RoundTrip(t *testing.T) {
	original := validVoucherPayloadMap()
	original["refund"] = true
	original["refundAmount"] = "100"
	p, err := VoucherPayloadFromMap(original)
	if err != nil {
		t.Fatalf("VoucherPayloadFromMap: %v", err)
	}
	if p.ChannelId != "0xabc" || p.MaxClaimableAmount != "500" || p.Signature != "0xsig" {
		t.Fatalf("payload fields not parsed: %+v", p)
	}
	if !p.Refund || p.RefundAmount != "100" {
		t.Fatalf("refund fields not parsed")
	}
	out := p.ToMap()
	if out["type"] != "voucher" || out["refund"] != true || out["refundAmount"] != "100" {
		t.Fatalf("ToMap = %v", out)
	}
}

func TestVoucherPayloadFromMap_MissingConfig(t *testing.T) {
	if _, err := VoucherPayloadFromMap(map[string]interface{}{"type": "voucher"}); err == nil {
		t.Fatal("expected error")
	}
}

func TestVoucherPayloadFromMap_InvalidConfig(t *testing.T) {
	bad := validChannelConfigMap()
	delete(bad, "payer")
	if _, err := VoucherPayloadFromMap(map[string]interface{}{"channelConfig": bad}); err == nil {
		t.Fatal("expected error")
	}
}

// ---------- VoucherClaim & list ----------

func TestVoucherClaimFromMap_ToMap_RoundTrip(t *testing.T) {
	in := map[string]interface{}{
		"voucher": map[string]interface{}{
			"channel":            validChannelConfigMap(),
			"maxClaimableAmount": "1000",
		},
		"signature":    "0xsig",
		"totalClaimed": "999",
	}
	c, err := VoucherClaimFromMap(in)
	if err != nil {
		t.Fatalf("VoucherClaimFromMap: %v", err)
	}
	if c.Voucher.MaxClaimableAmount != "1000" || c.Signature != "0xsig" || c.TotalClaimed != "999" {
		t.Fatalf("parsed = %+v", c)
	}
	out := VoucherClaimToMap(*c)
	if out["totalClaimed"] != "999" {
		t.Fatalf("ToMap = %v", out)
	}
}

func TestVoucherClaimFromMap_Errors(t *testing.T) {
	// missing voucher
	if _, err := VoucherClaimFromMap(map[string]interface{}{}); err == nil {
		t.Fatal("expected error: missing voucher")
	}
	// missing channel
	if _, err := VoucherClaimFromMap(map[string]interface{}{"voucher": map[string]interface{}{}}); err == nil {
		t.Fatal("expected error: missing channel")
	}
	// invalid channel
	bad := validChannelConfigMap()
	delete(bad, "payer")
	if _, err := VoucherClaimFromMap(map[string]interface{}{"voucher": map[string]interface{}{"channel": bad}}); err == nil {
		t.Fatal("expected error: invalid channel")
	}
}

func TestVoucherClaimsFromList_RoundTrip(t *testing.T) {
	item := map[string]interface{}{
		"voucher": map[string]interface{}{
			"channel":            validChannelConfigMap(),
			"maxClaimableAmount": "1",
		},
		"signature":    "0xs",
		"totalClaimed": "0",
	}
	in := []interface{}{item, item}
	claims, err := VoucherClaimsFromList(in)
	if err != nil {
		t.Fatalf("VoucherClaimsFromList: %v", err)
	}
	if len(claims) != 2 {
		t.Fatalf("got %d claims", len(claims))
	}
	out := VoucherClaimsToList(claims)
	if len(out) != 2 {
		t.Fatalf("ToList len = %d", len(out))
	}
}

func TestVoucherClaimsFromList_Errors(t *testing.T) {
	// non-map element
	if _, err := VoucherClaimsFromList([]interface{}{"not a map"}); err == nil {
		t.Fatal("expected error")
	}
	// invalid claim
	if _, err := VoucherClaimsFromList([]interface{}{map[string]interface{}{}}); err == nil {
		t.Fatal("expected error")
	}
}

// ---------- ClaimWithSignaturePayloadFromMap ----------

func TestClaimWithSignaturePayloadFromMap(t *testing.T) {
	in := map[string]interface{}{
		"settleAction":             "claimWithSignature",
		"claims":                   []interface{}{},
		"claimAuthorizerSignature": "0xauth",
	}
	p, err := ClaimWithSignaturePayloadFromMap(in)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if p.SettleAction != "claimWithSignature" || p.ClaimAuthorizerSignature != "0xauth" {
		t.Fatalf("parsed = %+v", p)
	}
	if _, err := ClaimWithSignaturePayloadFromMap(map[string]interface{}{}); err == nil {
		t.Fatal("expected error: missing claims")
	}
	bad := map[string]interface{}{"claims": []interface{}{"not a map"}}
	if _, err := ClaimWithSignaturePayloadFromMap(bad); err == nil {
		t.Fatal("expected error: bad claim")
	}
}

// ---------- SettleActionPayloadFromMap ----------

func TestSettleActionPayloadFromMap(t *testing.T) {
	p, err := SettleActionPayloadFromMap(map[string]interface{}{"receiver": "0x1", "token": "0x2"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if p.Receiver != "0x1" || p.Token != "0x2" || p.SettleAction != "settle" {
		t.Fatalf("parsed = %+v", p)
	}
}

// ---------- DepositSettlePayloadFromMap ----------

func TestDepositSettlePayloadFromMap(t *testing.T) {
	in := map[string]interface{}{
		"settleAction": "deposit",
		"deposit": map[string]interface{}{
			"channelConfig": validChannelConfigMap(),
			"amount":        "100",
			"authorization": map[string]interface{}{
				"erc3009Authorization": map[string]interface{}{
					"validAfter":  "0",
					"validBefore": "1",
					"salt":        "0x01",
					"signature":   "0xff",
				},
			},
		},
	}
	p, err := DepositSettlePayloadFromMap(in)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if p.Deposit.Amount != "100" || p.Deposit.Authorization.Erc3009Authorization == nil {
		t.Fatalf("parsed = %+v", p)
	}

	if _, err := DepositSettlePayloadFromMap(map[string]interface{}{}); err == nil {
		t.Fatal("expected error: missing deposit")
	}
	if _, err := DepositSettlePayloadFromMap(map[string]interface{}{"deposit": map[string]interface{}{}}); err == nil {
		t.Fatal("expected error: missing channelConfig")
	}
	bad := validChannelConfigMap()
	delete(bad, "payer")
	if _, err := DepositSettlePayloadFromMap(map[string]interface{}{"deposit": map[string]interface{}{"channelConfig": bad}}); err == nil {
		t.Fatal("expected error: invalid channelConfig")
	}
}

// ---------- RefundWithSignaturePayloadFromMap ----------

func TestRefundWithSignaturePayloadFromMap(t *testing.T) {
	in := map[string]interface{}{
		"settleAction":              "refundWithSignature",
		"config":                    validChannelConfigMap(),
		"amount":                    "100",
		"nonce":                     "1",
		"refundAuthorizerSignature": "0xrefund",
		"claimAuthorizerSignature":  "0xclaim",
		"claims": []interface{}{
			map[string]interface{}{
				"voucher": map[string]interface{}{
					"channel":            validChannelConfigMap(),
					"maxClaimableAmount": "1",
				},
				"signature":    "0x",
				"totalClaimed": "0",
			},
		},
	}
	p, err := RefundWithSignaturePayloadFromMap(in)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if p.Amount != "100" || p.Nonce != "1" || len(p.Claims) != 1 {
		t.Fatalf("parsed = %+v", p)
	}

	if _, err := RefundWithSignaturePayloadFromMap(map[string]interface{}{}); err == nil {
		t.Fatal("expected error: missing config")
	}
	bad := validChannelConfigMap()
	delete(bad, "payer")
	if _, err := RefundWithSignaturePayloadFromMap(map[string]interface{}{"config": bad}); err == nil {
		t.Fatal("expected error: invalid config")
	}
	badClaims := map[string]interface{}{
		"config": validChannelConfigMap(),
		"claims": []interface{}{"not a map"},
	}
	if _, err := RefundWithSignaturePayloadFromMap(badClaims); err == nil {
		t.Fatal("expected error: bad claims")
	}
}

// ---------- ChannelConfigToMap round-trip ----------

func TestChannelConfigToMap_RoundTrip(t *testing.T) {
	cc := ChannelConfig{
		Payer:              "0x1",
		PayerAuthorizer:    "0x2",
		Receiver:           "0x3",
		ReceiverAuthorizer: "0x4",
		Token:              "0x5",
		WithdrawDelay:      900,
		Salt:               "0xdead",
	}
	m := ChannelConfigToMap(cc)
	parsed, err := ChannelConfigFromMap(m)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !reflect.DeepEqual(cc, parsed) {
		t.Fatalf("round-trip mismatch:\nwant %+v\ngot  %+v", cc, parsed)
	}
}

// ---------- PaymentResponseExtra round-trip ----------

func TestPaymentResponseExtra_RoundTrip(t *testing.T) {
	e := &BatchedPaymentResponseExtra{
		ChannelId:               "0xabc",
		ChargedCumulativeAmount: "100",
		Balance:                 "900",
		TotalClaimed:            "50",
		WithdrawRequestedAt:     1234,
		RefundNonce:             "1",
		Refund:                  true,
		RefundedAmount:          "10",
	}
	out := e.ToMap()
	if out["refund"] != true || out["refundedAmount"] != "10" {
		t.Fatalf("ToMap = %v", out)
	}
	parsed, err := PaymentResponseExtraFromMap(out)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !reflect.DeepEqual(e, parsed) {
		t.Fatalf("round-trip mismatch:\nwant %+v\ngot  %+v", e, parsed)
	}
}

func TestPaymentResponseExtra_FromMap_NumericWithdrawRequestedAt(t *testing.T) {
	for _, v := range []interface{}{float64(1234), int(1234)} {
		m := map[string]interface{}{"withdrawRequestedAt": v}
		parsed, err := PaymentResponseExtraFromMap(m)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if parsed.WithdrawRequestedAt != 1234 {
			t.Fatalf("withdrawRequestedAt = %d", parsed.WithdrawRequestedAt)
		}
	}
}
