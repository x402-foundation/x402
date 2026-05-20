package facilitator

import (
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
)

func TestBuildPermit2SettleArgs_UnwrapsERC6492Signature(t *testing.T) {
	innerSig := common.FromHex("0x" + strings.Repeat("ab", 65))
	wrapped := wrapERC6492Signature(t, innerSig)

	args, err := BuildPermit2SettleArgs(&evm.ExactPermit2Payload{
		Signature: "0x" + common.Bytes2Hex(wrapped),
		Permit2Authorization: evm.Permit2Authorization{
			From: "0x1234567890123456789012345678901234567890",
			Permitted: evm.Permit2TokenPermissions{
				Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
				Amount: "1000000",
			},
			Nonce:    "123",
			Deadline: "9999999999",
			Witness: evm.Permit2Witness{
				To:         "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
				ValidAfter: "0",
			},
		},
	})
	if err != nil {
		t.Fatalf("BuildPermit2SettleArgs: %v", err)
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
