package facilitator

import (
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

func TestBuildUptoPermit2SettleArgs_UnwrapsERC6492Signature(t *testing.T) {
	innerSig := common.FromHex("0x" + strings.Repeat("ab", 65))
	wrapped := wrapERC6492Signature(t, innerSig)

	p := buildValidUptoPayload(testFacilitatorAddr)
	p.Signature = "0x" + common.Bytes2Hex(wrapped)

	args, err := BuildUptoPermit2SettleArgs(p, nil)
	if err != nil {
		t.Fatalf("BuildUptoPermit2SettleArgs: %v", err)
	}
	if string(args.Signature) != string(innerSig) {
		t.Fatalf("expected inner signature, got %x", args.Signature)
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
