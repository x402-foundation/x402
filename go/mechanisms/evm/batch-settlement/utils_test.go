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
		"0xABCDEF":         "0xabcdef",
		"0xabc":            "0xabc",
		"0x":               "0x",
		"0xMixedCASE12345": "0xmixedcase12345",
	}
	for in, want := range cases {
		if got := NormalizeChannelId(in); got != want {
			t.Fatalf("NormalizeChannelId(%q) = %q, want %q", in, got, want)
		}
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
