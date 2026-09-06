package batchsettlement

import (
	"math/big"
	"strings"
	"testing"
)

func sampleConfig() ChannelConfig {
	return ChannelConfig{
		Payer:              "0x1111111111111111111111111111111111111111",
		PayerAuthorizer:    "0x2222222222222222222222222222222222222222",
		Receiver:           "0x3333333333333333333333333333333333333333",
		ReceiverAuthorizer: "0x4444444444444444444444444444444444444444",
		Token:              "0x5555555555555555555555555555555555555555",
		WithdrawDelay:      900,
		Salt:               "0x0000000000000000000000000000000000000000000000000000000000000001",
	}
}

const testNetwork = "eip155:8453"

func TestComputeChannelId_Deterministic(t *testing.T) {
	cfg := sampleConfig()
	a, err := ComputeChannelId(cfg, testNetwork)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	b, err := ComputeChannelId(cfg, testNetwork)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if a != b {
		t.Fatalf("non-deterministic: %s vs %s", a, b)
	}
	if !strings.HasPrefix(a, "0x") || len(a) != 66 {
		t.Fatalf("expected 0x-prefixed 32-byte hex; got %q", a)
	}
}

func TestComputeChannelId_DistinctConfigsDiffer(t *testing.T) {
	a, _ := ComputeChannelId(sampleConfig(), testNetwork)
	cfg2 := sampleConfig()
	cfg2.Salt = "0x0000000000000000000000000000000000000000000000000000000000000002"
	b, _ := ComputeChannelId(cfg2, testNetwork)
	if a == b {
		t.Fatal("different salts produced same channelId")
	}

	cfg3 := sampleConfig()
	cfg3.WithdrawDelay = 901
	c, _ := ComputeChannelId(cfg3, testNetwork)
	if a == c {
		t.Fatal("different withdrawDelay produced same channelId")
	}
}

func TestComputeChannelId_AcceptsShortSalt(t *testing.T) {
	cfg := sampleConfig()
	cfg.Salt = "0x01"
	if _, err := ComputeChannelId(cfg, testNetwork); err != nil {
		t.Fatalf("short salt rejected: %v", err)
	}
}

func TestComputeChannelId_RejectsTooLongSalt(t *testing.T) {
	cfg := sampleConfig()
	cfg.Salt = "0x" + strings.Repeat("ab", 33)
	if _, err := ComputeChannelId(cfg, testNetwork); err == nil {
		t.Fatal("expected error")
	}
}

func TestNormalizeChannelId(t *testing.T) {
	cases := map[string]string{
		"0xABCDEF0000000000000000000000000000000000000000000000000000000000": "0xabcdef0000000000000000000000000000000000000000000000000000000000",
		"0x00000000000000000000000000000000000000000000000000000000000000ab": "0x00000000000000000000000000000000000000000000000000000000000000ab",
		"0xAbCdEf1234567890AbCdEf1234567890AbCdEf1234567890AbCdEf1234567890": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
	}
	for in, want := range cases {
		got, err := NormalizeChannelId(in)
		if err != nil {
			t.Fatalf("NormalizeChannelId(%q): unexpected err %v", in, err)
		}
		if got != want {
			t.Fatalf("NormalizeChannelId(%q) = %q, want %q", in, got, want)
		}
	}

	invalid := []string{"0xABCDEF", "0xabc", "0x", "not-a-channel-id", "", "../../../etc/passwd", "/etc/passwd"}
	for _, in := range invalid {
		if _, err := NormalizeChannelId(in); err == nil {
			t.Fatalf("NormalizeChannelId(%q): expected error", in)
		}
	}
}

func TestIsCanonicalChannelId(t *testing.T) {
	if !IsCanonicalChannelId("0xAbCdEf1234567890AbCdEf1234567890AbCdEf1234567890AbCdEf1234567890") {
		t.Fatal("expected mixed-case 64-hex to be canonical")
	}
	for _, in := range []string{"0x1234", "", "0x" + strings.Repeat("g", 64), "../../../etc/passwd"} {
		if IsCanonicalChannelId(in) {
			t.Fatalf("IsCanonicalChannelId(%q) = true", in)
		}
	}
}

func TestChannelIdBindingError(t *testing.T) {
	cfg := sampleConfig()
	id, err := ComputeChannelId(cfg, testNetwork)
	if err != nil {
		t.Fatalf("ComputeChannelId: %v", err)
	}
	if got := ChannelIdBindingError(cfg, id, testNetwork); got != "" {
		t.Fatalf("expected empty binding error, got %q", got)
	}
	if got := ChannelIdBindingError(cfg, "0x"+strings.ToUpper(id[2:]), testNetwork); got != "" {
		t.Fatalf("mixed-case id should bind, got %q", got)
	}
	if got := ChannelIdBindingError(cfg, "0xabcd", testNetwork); got != ErrInvalidChannelId {
		t.Fatalf("malformed = %q, want %q", got, ErrInvalidChannelId)
	}
	wrong := "0x" + strings.Repeat("11", 32)
	if got := ChannelIdBindingError(cfg, wrong, testNetwork); got != ErrChannelIdMismatch {
		t.Fatalf("mismatch = %q, want %q", got, ErrChannelIdMismatch)
	}
}

func TestGetBatchSettlementEip712Domain(t *testing.T) {
	chainId := big.NewInt(8453)
	d := GetBatchSettlementEip712Domain(chainId)
	if d.Name != BatchSettlementDomain.Name {
		t.Fatalf("Name = %q", d.Name)
	}
	if d.Version != BatchSettlementDomain.Version {
		t.Fatalf("Version = %q", d.Version)
	}
	if d.ChainID == nil || d.ChainID.Cmp(chainId) != 0 {
		t.Fatalf("ChainID = %v", d.ChainID)
	}
	if d.VerifyingContract != BatchSettlementAddress {
		t.Fatalf("VerifyingContract = %q", d.VerifyingContract)
	}
}

func TestHexToBytes32_LeftPads(t *testing.T) {
	out, err := hexToBytes32("0x01")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	for i := range 31 {
		if out[i] != 0 {
			t.Fatalf("byte %d should be zero, got %x", i, out[i])
		}
	}
	if out[31] != 1 {
		t.Fatalf("byte 31 = %x, want 0x01", out[31])
	}
}

func TestHexToBytes32_NoPrefix(t *testing.T) {
	out, err := hexToBytes32("01")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out[31] != 1 {
		t.Fatalf("byte 31 = %x", out[31])
	}
}

func TestHexToBytes32_TooLong(t *testing.T) {
	if _, err := hexToBytes32("0x" + strings.Repeat("a", 65)); err == nil {
		t.Fatal("expected error")
	}
}
