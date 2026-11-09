package facilitator

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

func addrToBytes(hex string) [20]byte {
	var b [20]byte
	copy(b[:], common.HexToAddress(hex).Bytes())
	return b
}

func TestIsFactoryAllowed(t *testing.T) {
	factory := addrToBytes("0x1111111111111111111111111111111111111111")

	t.Run("nil allowlist denies all factories", func(t *testing.T) {
		if evm.IsFactoryAllowed(factory, nil) {
			t.Error("expected false for nil allowlist")
		}
	})

	t.Run("empty allowlist denies all factories", func(t *testing.T) {
		if evm.IsFactoryAllowed(factory, []string{}) {
			t.Error("expected false for empty allowlist")
		}
	})

	t.Run("exact match allows factory", func(t *testing.T) {
		allowed := []string{"0x1111111111111111111111111111111111111111"}
		if !evm.IsFactoryAllowed(factory, allowed) {
			t.Error("expected true for exact match")
		}
	})

	t.Run("comparison is case-insensitive", func(t *testing.T) {
		upper := []string{"0X1111111111111111111111111111111111111111"}
		if !evm.IsFactoryAllowed(factory, upper) {
			t.Error("expected true for uppercase 0X prefix")
		}

		mixed := []string{"0x1111111111111111111111111111111111111111"}
		if !evm.IsFactoryAllowed(factory, mixed) {
			t.Error("expected true for mixed-case address")
		}
	})

	t.Run("non-matching address is denied", func(t *testing.T) {
		different := []string{"0x2222222222222222222222222222222222222222"}
		if evm.IsFactoryAllowed(factory, different) {
			t.Error("expected false for non-matching address")
		}
	})

	t.Run("matches one entry in multi-address allowlist", func(t *testing.T) {
		allowlist := []string{
			"0x2222222222222222222222222222222222222222",
			"0x1111111111111111111111111111111111111111",
			"0x3333333333333333333333333333333333333333",
		}
		if !evm.IsFactoryAllowed(factory, allowlist) {
			t.Error("expected true when factory matches one of many entries")
		}
	})

	t.Run("zero address is denied when not in allowlist", func(t *testing.T) {
		var zero [20]byte
		if evm.IsFactoryAllowed(zero, []string{"0x1111111111111111111111111111111111111111"}) {
			t.Error("expected false for zero address not in allowlist")
		}
	})
}
