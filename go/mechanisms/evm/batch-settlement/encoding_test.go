package batchsettlement

import (
	"bytes"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
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

// ----- Permit2 collector data ------------------------------------------------

func TestBuildPermit2CollectorData_Deterministic(t *testing.T) {
	a, err := BuildPermit2CollectorData("100", "9999999999", "0xdeadbeef", nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	b, err := BuildPermit2CollectorData("100", "9999999999", "0xdeadbeef", []byte{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !bytes.Equal(a, b) {
		t.Fatalf("nil and empty eip2612PermitData should encode identically")
	}
	if len(a) == 0 {
		t.Fatal("empty encoding")
	}
}

func TestBuildPermit2CollectorData_AcceptsEip2612Segment(t *testing.T) {
	permit, err := BuildEip2612PermitData(Eip2612PermitInput{
		Value:    "1000000",
		Deadline: "9999999999",
		V:        27,
		R:        "0x" + strings.Repeat("11", 32),
		S:        "0x" + strings.Repeat("22", 32),
	})
	if err != nil {
		t.Fatalf("permit data: %v", err)
	}
	with, err := BuildPermit2CollectorData("1", "9999999999", "0xff", permit)
	if err != nil {
		t.Fatalf("with permit: %v", err)
	}
	without, err := BuildPermit2CollectorData("1", "9999999999", "0xff", nil)
	if err != nil {
		t.Fatalf("without permit: %v", err)
	}
	if bytes.Equal(with, without) {
		t.Fatal("eip2612 permit segment did not affect encoding")
	}
}

func TestBuildPermit2CollectorData_InvalidNonce(t *testing.T) {
	if _, err := BuildPermit2CollectorData("not-a-number", "1", "0xff", nil); err == nil {
		t.Fatal("expected error")
	}
}

func TestBuildPermit2CollectorData_InvalidDeadline(t *testing.T) {
	if _, err := BuildPermit2CollectorData("1", "not-a-number", "0xff", nil); err == nil {
		t.Fatal("expected error")
	}
}

// ----- EIP-2612 permit segment ----------------------------------------------

func TestBuildEip2612PermitData_Deterministic(t *testing.T) {
	in := Eip2612PermitInput{
		Value:    "1000",
		Deadline: "1234567890",
		V:        28,
		R:        "0x" + strings.Repeat("aa", 32),
		S:        "0x" + strings.Repeat("bb", 32),
	}
	a, err := BuildEip2612PermitData(in)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	b, err := BuildEip2612PermitData(in)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("non-deterministic encoding")
	}
}

func TestBuildEip2612PermitData_InvalidR(t *testing.T) {
	// hexToBytes32 only rejects hex strings longer than 32 bytes (64 chars).
	if _, err := BuildEip2612PermitData(Eip2612PermitInput{
		Value:    "1",
		Deadline: "1",
		V:        27,
		R:        "0x" + strings.Repeat("ff", 33),
		S:        "0x" + strings.Repeat("00", 32),
	}); err == nil {
		t.Fatal("expected error for over-long r")
	}
}

func TestBuildEip2612PermitData_InvalidValue(t *testing.T) {
	if _, err := BuildEip2612PermitData(Eip2612PermitInput{
		Value:    "not-a-number",
		Deadline: "1",
		V:        27,
		R:        "0x" + strings.Repeat("00", 32),
		S:        "0x" + strings.Repeat("00", 32),
	}); err == nil {
		t.Fatal("expected error for non-numeric value")
	}
}

func TestBuildErc3009CollectorData_UnwrapsERC6492Signature(t *testing.T) {
	innerSig := common.FromHex("0x" + strings.Repeat("ab", 65))
	wrapped := wrapERC6492Signature(t, innerSig)

	collectorData, err := BuildErc3009CollectorData("0", "9999999999", "0x01", "0x"+common.Bytes2Hex(wrapped))
	if err != nil {
		t.Fatalf("BuildErc3009CollectorData: %v", err)
	}

	signature, err := decodeErc3009CollectorSignature(collectorData)
	if err != nil {
		t.Fatalf("decode collector data: %v", err)
	}
	if string(signature) != string(innerSig) {
		t.Fatalf("expected inner signature, got %x", signature)
	}
}

func TestBuildPermit2CollectorData_UnwrapsERC6492Signature(t *testing.T) {
	innerSig := common.FromHex("0x" + strings.Repeat("ab", 65))
	wrapped := wrapERC6492Signature(t, innerSig)

	collectorData, err := BuildPermit2CollectorData("123", "9999999999", "0x"+common.Bytes2Hex(wrapped), nil)
	if err != nil {
		t.Fatalf("BuildPermit2CollectorData: %v", err)
	}

	signature, err := decodePermit2CollectorSignature(collectorData)
	if err != nil {
		t.Fatalf("decode collector data: %v", err)
	}
	if string(signature) != string(innerSig) {
		t.Fatalf("expected inner signature, got %x", signature)
	}
}

func wrapERC6492Signature(t *testing.T, innerSig []byte) []byte {
	t.Helper()
	addressTy, err := abi.NewType("address", "", nil)
	if err != nil {
		t.Fatalf("address type: %v", err)
	}
	bytesTy, err := abi.NewType("bytes", "", nil)
	if err != nil {
		t.Fatalf("bytes type: %v", err)
	}
	arguments := abi.Arguments{{Type: addressTy}, {Type: bytesTy}, {Type: bytesTy}}
	packed, err := arguments.Pack(
		common.HexToAddress("0xca11bde05977b3631167028862be2a173976ca11"),
		[]byte{0xde, 0xad, 0xbe, 0xef},
		innerSig,
	)
	if err != nil {
		t.Fatalf("pack: %v", err)
	}
	return append(packed, common.Hex2Bytes("6492649264926492649264926492649264926492649264926492649264926492")...)
}

func decodeErc3009CollectorSignature(collectorData []byte) ([]byte, error) {
	uint256Ty, _ := abi.NewType("uint256", "", nil)
	bytesTy, _ := abi.NewType("bytes", "", nil)
	args := abi.Arguments{{Type: uint256Ty}, {Type: uint256Ty}, {Type: uint256Ty}, {Type: bytesTy}}
	unpacked, err := args.Unpack(collectorData)
	if err != nil {
		return nil, err
	}
	return unpacked[3].([]byte), nil
}

func decodePermit2CollectorSignature(collectorData []byte) ([]byte, error) {
	uint256Ty, _ := abi.NewType("uint256", "", nil)
	bytesTy, _ := abi.NewType("bytes", "", nil)
	args := abi.Arguments{{Type: uint256Ty}, {Type: uint256Ty}, {Type: bytesTy}, {Type: bytesTy}}
	unpacked, err := args.Unpack(collectorData)
	if err != nil {
		return nil, err
	}
	return unpacked[2].([]byte), nil
}
