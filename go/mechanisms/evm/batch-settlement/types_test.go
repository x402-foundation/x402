package batchsettlement

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
		"type":          "deposit",
		"channelConfig": validChannelConfigMap(),
		"voucher":       validVoucherSubMap(),
		"deposit": map[string]interface{}{
			"amount": "1000",
			"authorization": map[string]interface{}{
				"erc3009Authorization": map[string]interface{}{
					"validAfter":  "0",
					"validBefore": "9999999999",
					"salt":        "0x01",
					"signature":   "0xdeadbeef",
				},
			},
		},
	}
}

func validVoucherPayloadMap() map[string]interface{} {
	return map[string]interface{}{
		"type":          "voucher",
		"channelConfig": validChannelConfigMap(),
		"voucher":       validVoucherSubMap(),
	}
}

func validRefundPayloadMap() map[string]interface{} {
	return map[string]interface{}{
		"type":          "refund",
		"channelConfig": validChannelConfigMap(),
		"voucher":       validVoucherSubMap(),
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
		{"wrong type", map[string]interface{}{"type": "voucher", "channelConfig": 1, "voucher": 1, "deposit": 1}, false},
		{"missing deposit", map[string]interface{}{"type": "deposit", "channelConfig": 1, "voucher": 1}, false},
		{"missing voucher", map[string]interface{}{"type": "deposit", "channelConfig": 1, "deposit": 1}, false},
		{"missing channelConfig", map[string]interface{}{"type": "deposit", "voucher": 1, "deposit": 1}, false},
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
		{"wrong type", map[string]interface{}{"type": "deposit", "channelConfig": 1, "voucher": 1}, false},
		{"missing config", map[string]interface{}{"type": "voucher", "voucher": 1}, false},
		{"missing voucher", map[string]interface{}{"type": "voucher", "channelConfig": 1}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsVoucherPayload(tc.in); got != tc.want {
				t.Fatalf("IsVoucherPayload = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsRefundPayload(t *testing.T) {
	tests := []struct {
		name string
		in   map[string]interface{}
		want bool
	}{
		{"valid", validRefundPayloadMap(), true},
		{"wrong type", map[string]interface{}{"type": "voucher", "channelConfig": 1, "voucher": 1}, false},
		{"missing config", map[string]interface{}{"type": "refund", "voucher": 1}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsRefundPayload(tc.in); got != tc.want {
				t.Fatalf("IsRefundPayload = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsClaimPayload(t *testing.T) {
	tests := []struct {
		name string
		in   map[string]interface{}
		want bool
	}{
		{"valid", map[string]interface{}{"type": "claim", "claims": []interface{}{}}, true},
		{"wrong type", map[string]interface{}{"type": "settle", "claims": []interface{}{}}, false},
		{"missing claims", map[string]interface{}{"type": "claim"}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsClaimPayload(tc.in); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsSettlePayload(t *testing.T) {
	tests := []struct {
		name string
		in   map[string]interface{}
		want bool
	}{
		{"valid", map[string]interface{}{"type": "settle", "receiver": "0x1", "token": "0x2"}, true},
		{"wrong type", map[string]interface{}{"type": "claim", "receiver": "0x1", "token": "0x2"}, false},
		{"missing receiver", map[string]interface{}{"type": "settle", "token": "0x2"}, false},
		{"missing token", map[string]interface{}{"type": "settle", "receiver": "0x1"}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsSettlePayload(tc.in); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsEnrichedRefundPayload(t *testing.T) {
	enriched := validRefundPayloadMap()
	enriched["amount"] = "100"
	enriched["refundNonce"] = "0"
	enriched["claims"] = []interface{}{}
	if !IsEnrichedRefundPayload(enriched) {
		t.Fatal("expected enriched refund to be detected")
	}
	if IsEnrichedRefundPayload(validRefundPayloadMap()) {
		t.Fatal("plain refund should not be detected as enriched")
	}
}

func TestIsBatchedPayload(t *testing.T) {
	if !IsBatchedPayload(validDepositPayloadMap()) {
		t.Fatal("deposit map should be batched")
	}
	if !IsBatchedPayload(validVoucherPayloadMap()) {
		t.Fatal("voucher map should be batched")
	}
	if !IsBatchedPayload(validRefundPayloadMap()) {
		t.Fatal("refund map should be batched")
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
	if p.Voucher.ChannelId != "0xabc" || p.Voucher.MaxClaimableAmount != "1000" {
		t.Fatalf("voucher fields = %+v", p.Voucher)
	}

	out := p.ToMap()
	if out["type"] != "deposit" {
		t.Fatalf("ToMap type = %v", out["type"])
	}
	voucher := out["voucher"].(map[string]interface{})
	if voucher["channelId"] != "0xabc" {
		t.Fatalf("ToMap voucher = %v", voucher)
	}
}

func TestDepositPayloadFromMap_MissingDeposit(t *testing.T) {
	in := map[string]interface{}{
		"type":          "deposit",
		"channelConfig": validChannelConfigMap(),
		"voucher":       validVoucherSubMap(),
	}
	if _, err := DepositPayloadFromMap(in); err == nil {
		t.Fatal("expected error")
	}
}

func TestDepositPayloadFromMap_MissingChannelConfig(t *testing.T) {
	in := map[string]interface{}{
		"type":    "deposit",
		"voucher": validVoucherSubMap(),
		"deposit": map[string]interface{}{"amount": "1"},
	}
	if _, err := DepositPayloadFromMap(in); err == nil {
		t.Fatal("expected error")
	}
}

func TestDepositPayloadFromMap_InvalidChannelConfig(t *testing.T) {
	bad := validChannelConfigMap()
	delete(bad, "payer")
	in := map[string]interface{}{
		"type":          "deposit",
		"channelConfig": bad,
		"voucher":       validVoucherSubMap(),
		"deposit":       map[string]interface{}{"amount": "1"},
	}
	if _, err := DepositPayloadFromMap(in); err == nil {
		t.Fatal("expected error")
	}
}

// ---------- VoucherPayloadFromMap / ToMap round-trip ----------

func TestVoucherPayloadFromMap_ToMap_RoundTrip(t *testing.T) {
	original := validVoucherPayloadMap()
	p, err := VoucherPayloadFromMap(original)
	if err != nil {
		t.Fatalf("VoucherPayloadFromMap: %v", err)
	}
	if p.Voucher.ChannelId != "0xabc" || p.Voucher.MaxClaimableAmount != "1000" || p.Voucher.Signature != "0xsig" {
		t.Fatalf("payload fields not parsed: %+v", p)
	}
	out := p.ToMap()
	if out["type"] != "voucher" {
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
	if _, err := VoucherClaimFromMap(map[string]interface{}{}); err == nil {
		t.Fatal("expected error: missing voucher")
	}
	if _, err := VoucherClaimFromMap(map[string]interface{}{"voucher": map[string]interface{}{}}); err == nil {
		t.Fatal("expected error: missing channel")
	}
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
	if _, err := VoucherClaimsFromList([]interface{}{"not a map"}); err == nil {
		t.Fatal("expected error")
	}
	if _, err := VoucherClaimsFromList([]interface{}{map[string]interface{}{}}); err == nil {
		t.Fatal("expected error")
	}
}

// ---------- ClaimPayloadFromMap ----------

func TestClaimPayloadFromMap(t *testing.T) {
	in := map[string]interface{}{
		"type":                     "claim",
		"claims":                   []interface{}{},
		"claimAuthorizerSignature": "0xauth",
	}
	p, err := ClaimPayloadFromMap(in)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if p.Type != "claim" || p.ClaimAuthorizerSignature != "0xauth" {
		t.Fatalf("parsed = %+v", p)
	}
	if _, err := ClaimPayloadFromMap(map[string]interface{}{}); err == nil {
		t.Fatal("expected error: missing claims")
	}
	bad := map[string]interface{}{"claims": []interface{}{"not a map"}}
	if _, err := ClaimPayloadFromMap(bad); err == nil {
		t.Fatal("expected error: bad claim")
	}
}

// ---------- SettlePayloadFromMap ----------

func TestSettlePayloadFromMap(t *testing.T) {
	p, err := SettlePayloadFromMap(map[string]interface{}{"type": "settle", "receiver": "0x1", "token": "0x2"})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if p.Receiver != "0x1" || p.Token != "0x2" || p.Type != "settle" {
		t.Fatalf("parsed = %+v", p)
	}
}

// ---------- EnrichedRefundPayloadFromMap ----------

func TestEnrichedRefundPayloadFromMap(t *testing.T) {
	in := map[string]interface{}{
		"type":                      "refund",
		"channelConfig":             validChannelConfigMap(),
		"voucher":                   validVoucherSubMap(),
		"amount":                    "100",
		"refundNonce":               "1",
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
	p, err := EnrichedRefundPayloadFromMap(in)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if p.Amount != "100" || p.RefundNonce != "1" || len(p.Claims) != 1 {
		t.Fatalf("parsed = %+v", p)
	}

	if _, err := EnrichedRefundPayloadFromMap(map[string]interface{}{}); err == nil {
		t.Fatal("expected error: missing channelConfig")
	}
	bad := validChannelConfigMap()
	delete(bad, "payer")
	if _, err := EnrichedRefundPayloadFromMap(map[string]interface{}{"channelConfig": bad}); err == nil {
		t.Fatal("expected error: invalid channelConfig")
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
	e := &BatchSettlementPaymentResponseExtra{
		ChargedAmount: "10",
		ChannelState: &BatchSettlementChannelStateExtra{
			ChannelId:               "0xabc",
			Balance:                 "900",
			TotalClaimed:            "50",
			WithdrawRequestedAt:     1234,
			RefundNonce:             "1",
			ChargedCumulativeAmount: "100",
		},
		VoucherState: &BatchSettlementVoucherStateExtra{
			SignedMaxClaimable: "200",
			Signature:          "0xdeadbeef",
		},
	}
	out := e.ToMap()
	parsed, err := PaymentResponseExtraFromMap(out)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if parsed.ChargedAmount != e.ChargedAmount {
		t.Fatalf("ChargedAmount = %q, want %q", parsed.ChargedAmount, e.ChargedAmount)
	}
	if !reflect.DeepEqual(parsed.ChannelState, e.ChannelState) {
		t.Fatalf("ChannelState mismatch:\nwant %+v\ngot  %+v", e.ChannelState, parsed.ChannelState)
	}
	if !reflect.DeepEqual(parsed.VoucherState, e.VoucherState) {
		t.Fatalf("VoucherState mismatch:\nwant %+v\ngot  %+v", e.VoucherState, parsed.VoucherState)
	}
}

func TestPaymentResponseExtra_FromMap_NumericWithdrawRequestedAt(t *testing.T) {
	for _, v := range []interface{}{float64(1234), int(1234)} {
		m := map[string]interface{}{
			"channelState": map[string]interface{}{
				"channelId":           "0xabc",
				"withdrawRequestedAt": v,
			},
		}
		parsed, err := PaymentResponseExtraFromMap(m)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if parsed.ChannelState == nil || parsed.ChannelState.WithdrawRequestedAt != 1234 {
			t.Fatalf("withdrawRequestedAt = %+v", parsed.ChannelState)
		}
	}
}

// ---------- RefundPayload round-trip ----------

func TestRefundPayloadFromMap_ToMap_RoundTrip(t *testing.T) {
	in := validRefundPayloadMap()
	in["amount"] = "250"
	p, err := RefundPayloadFromMap(in)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if p.Amount != "250" || p.Voucher.ChannelId != "0xabc" {
		t.Fatalf("parsed = %+v", p)
	}
	out := p.ToMap()
	if out["type"] != "refund" || out["amount"] != "250" {
		t.Fatalf("ToMap = %+v", out)
	}
	if _, ok := out["channelConfig"].(map[string]interface{}); !ok {
		t.Fatalf("missing channelConfig in %+v", out)
	}

	// Empty amount should be omitted.
	p.Amount = ""
	if _, hasAmount := p.ToMap()["amount"]; hasAmount {
		t.Fatal("expected amount omitted when empty")
	}
}

func TestRefundPayloadFromMap_Errors(t *testing.T) {
	if _, err := RefundPayloadFromMap(map[string]interface{}{}); err == nil {
		t.Fatal("expected error: missing channelConfig")
	}
	bad := map[string]interface{}{"channelConfig": map[string]interface{}{}}
	if _, err := RefundPayloadFromMap(bad); err == nil {
		t.Fatal("expected error: invalid channelConfig")
	}
	noVoucher := map[string]interface{}{"channelConfig": validChannelConfigMap()}
	if _, err := RefundPayloadFromMap(noVoucher); err == nil {
		t.Fatal("expected error: missing voucher")
	}
}

// ---------- Wire-format ToMap converters used by the channel manager ----------

func TestClaimPayload_ToMap(t *testing.T) {
	p := &BatchSettlementClaimPayload{Type: "claim"}
	if got := p.ToMap(); got["type"] != "claim" {
		t.Fatalf("ToMap = %+v", got)
	}
	if _, has := p.ToMap()["claimAuthorizerSignature"]; has {
		t.Fatal("expected claimAuthorizerSignature omitted when empty")
	}

	p.ClaimAuthorizerSignature = "0xsig"
	out := p.ToMap()
	if out["claimAuthorizerSignature"] != "0xsig" {
		t.Fatalf("ToMap = %+v", out)
	}
}

func TestSettlePayload_ToMap(t *testing.T) {
	p := &BatchSettlementSettlePayload{Type: "settle", Receiver: "0xrcv", Token: "0xtok"}
	out := p.ToMap()
	if out["type"] != "settle" || out["receiver"] != "0xrcv" || out["token"] != "0xtok" {
		t.Fatalf("ToMap = %+v", out)
	}
}

func TestEnrichedRefundPayload_ToMap(t *testing.T) {
	p := &BatchSettlementEnrichedRefundPayload{
		Type: "refund",
		ChannelConfig: ChannelConfig{
			Payer: "0x1", PayerAuthorizer: "0x2", Receiver: "0x3",
			ReceiverAuthorizer: "0x4", Token: "0x5", WithdrawDelay: 900,
			Salt: "0x6",
		},
		Voucher:     BatchSettlementVoucherFields{ChannelId: "0xabc", MaxClaimableAmount: "1000", Signature: "0xsig"},
		Amount:      "100",
		RefundNonce: "1",
		Claims:      []BatchSettlementVoucherClaim{},
	}
	out := p.ToMap()
	if out["type"] != "refund" || out["amount"] != "100" || out["refundNonce"] != "1" {
		t.Fatalf("ToMap = %+v", out)
	}
	if _, has := out["refundAuthorizerSignature"]; has {
		t.Fatal("expected refundAuthorizerSignature omitted when empty")
	}

	p.RefundAuthorizerSignature = "0xref"
	p.ClaimAuthorizerSignature = "0xclm"
	out = p.ToMap()
	if out["refundAuthorizerSignature"] != "0xref" || out["claimAuthorizerSignature"] != "0xclm" {
		t.Fatalf("ToMap with sigs = %+v", out)
	}
}

// ---------- ChannelState / VoucherState requirements ----------

func TestChannelStateRequirements_FromMapAndToMap(t *testing.T) {
	in := map[string]interface{}{
		"channelId":               "0xabc",
		"balance":                 "1000",
		"totalClaimed":            "100",
		"withdrawRequestedAt":     0,
		"refundNonce":             "1",
		"chargedCumulativeAmount": "200",
	}
	cs := ChannelStateRequirementsFromMap(in)
	if cs == nil || cs.ChannelId != "0xabc" || cs.ChargedCumulativeAmount != "200" {
		t.Fatalf("parsed = %+v", cs)
	}

	out := cs.ToMap()
	if out["channelId"] != "0xabc" || out["chargedCumulativeAmount"] != "200" {
		t.Fatalf("ToMap = %+v", out)
	}
	if out["balance"] != "1000" || out["totalClaimed"] != "100" {
		t.Fatalf("ToMap missing channel snapshot: %+v", out)
	}

	// Missing channelId returns nil.
	if got := ChannelStateRequirementsFromMap(map[string]interface{}{}); got != nil {
		t.Fatalf("expected nil for empty map, got %+v", got)
	}
	// Nil input returns nil.
	if got := ChannelStateRequirementsFromMap(nil); got != nil {
		t.Fatalf("expected nil for nil map, got %+v", got)
	}
	// Receiver-nil ToMap returns nil.
	var nilCS *BatchSettlementChannelStateExtra
	if got := nilCS.ToMap(); got != nil {
		t.Fatalf("expected nil ToMap for nil receiver, got %+v", got)
	}
	// Empty optional fields are omitted.
	cs2 := &BatchSettlementChannelStateExtra{ChannelId: "0xabc"}
	out2 := cs2.ToMap()
	if _, has := out2["chargedCumulativeAmount"]; has {
		t.Fatalf("expected optional fields omitted, got %+v", out2)
	}
}

func TestVoucherStateRequirements_FromMapAndToMap(t *testing.T) {
	in := map[string]interface{}{
		"signedMaxClaimable": "1000",
		"signature":          "0xsig",
	}
	vs := VoucherStateRequirementsFromMap(in)
	if vs == nil || vs.SignedMaxClaimable != "1000" || vs.Signature != "0xsig" {
		t.Fatalf("parsed = %+v", vs)
	}
	out := vs.ToMap()
	if out["signedMaxClaimable"] != "1000" || out["signature"] != "0xsig" {
		t.Fatalf("ToMap = %+v", out)
	}
	// Empty inputs return nil.
	if got := VoucherStateRequirementsFromMap(map[string]interface{}{}); got != nil {
		t.Fatalf("expected nil for empty map, got %+v", got)
	}
	// Receiver-nil ToMap returns nil.
	var nilVS *BatchSettlementVoucherStateExtra
	if got := nilVS.ToMap(); got != nil {
		t.Fatalf("expected nil ToMap for nil receiver, got %+v", got)
	}
	// Both fields empty produces nil ToMap.
	if got := (&BatchSettlementVoucherStateExtra{}).ToMap(); got != nil {
		t.Fatalf("expected nil ToMap when both fields empty, got %+v", got)
	}
}
