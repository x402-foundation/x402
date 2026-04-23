package batched

import (
	"bytes"
	"strings"
	"testing"
)

func TestBuildErc3009DepositNonce_Deterministic(t *testing.T) {
	const channelId = "0x1111111111111111111111111111111111111111111111111111111111111111"
	const salt = "0x02"

	a, err := BuildErc3009DepositNonce(channelId, salt)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	b, err := BuildErc3009DepositNonce(channelId, salt)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if a != b {
		t.Fatalf("non-deterministic: %s vs %s", a, b)
	}
	if !strings.HasPrefix(a, "0x") || len(a) != 66 {
		t.Fatalf("expected 0x-prefixed 32-byte hex; got %q (len %d)", a, len(a))
	}
}

func TestBuildErc3009DepositNonce_DifferentInputs(t *testing.T) {
	const channelId = "0x" + "11"
	a, err := BuildErc3009DepositNonce(channelId, "0x01")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	b, err := BuildErc3009DepositNonce(channelId, "0x02")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if a == b {
		t.Fatalf("different salts produced same hash: %s", a)
	}
}

func TestBuildErc3009DepositNonce_AcceptsShortChannelId(t *testing.T) {
	// hexToBytes32 left-pads, so short hex is accepted
	if _, err := BuildErc3009DepositNonce("0x01", "0x01"); err != nil {
		t.Fatalf("short channelId rejected: %v", err)
	}
}

func TestBuildErc3009DepositNonce_InvalidChannelId(t *testing.T) {
	long := "0x" + strings.Repeat("ab", 33)
	if _, err := BuildErc3009DepositNonce(long, "0x01"); err == nil {
		t.Fatal("expected error for too-long channelId")
	}
}

func TestBuildErc3009DepositNonce_InvalidSalt(t *testing.T) {
	if _, err := BuildErc3009DepositNonce("0x01", "not-hex"); err == nil {
		t.Fatal("expected error for invalid salt")
	}
}

func TestBuildErc3009CollectorData_Deterministic(t *testing.T) {
	a, err := BuildErc3009CollectorData("0", "9999999999", "0x01", "0xdeadbeef")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	b, err := BuildErc3009CollectorData("0", "9999999999", "0x01", "0xdeadbeef")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("non-deterministic encoding")
	}
	if len(a) == 0 {
		t.Fatal("empty encoding")
	}
}

func TestBuildErc3009CollectorData_DifferentInputsDiffer(t *testing.T) {
	a, _ := BuildErc3009CollectorData("0", "1", "0x01", "0xff")
	b, _ := BuildErc3009CollectorData("0", "2", "0x01", "0xff")
	if bytes.Equal(a, b) {
		t.Fatal("validBefore change did not affect encoding")
	}
}

func TestBuildErc3009CollectorData_InvalidValidAfter(t *testing.T) {
	if _, err := BuildErc3009CollectorData("not-a-number", "0", "0x01", "0xff"); err == nil {
		t.Fatal("expected error")
	}
}

func TestBuildErc3009CollectorData_InvalidValidBefore(t *testing.T) {
	if _, err := BuildErc3009CollectorData("0", "not-a-number", "0x01", "0xff"); err == nil {
		t.Fatal("expected error")
	}
}

func TestBuildErc3009CollectorData_InvalidSalt(t *testing.T) {
	if _, err := BuildErc3009CollectorData("0", "1", "not-hex", "0xff"); err == nil {
		t.Fatal("expected error")
	}
}
