package evm

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func TestIsERC7702Delegation(t *testing.T) {
	delegate := common.HexToAddress("0x1234567890abcdef1234567890abcdef12345678")
	validCode := append([]byte{0xef, 0x01, 0x00}, delegate.Bytes()...)

	cases := []struct {
		name string
		code []byte
		want bool
	}{
		{"valid delegation", validCode, true},
		{"empty code", []byte{}, false},
		{"wrong prefix byte 0", append([]byte{0xee, 0x01, 0x00}, delegate.Bytes()...), false},
		{"wrong prefix byte 1", append([]byte{0xef, 0x02, 0x00}, delegate.Bytes()...), false},
		{"wrong prefix byte 2", append([]byte{0xef, 0x01, 0x01}, delegate.Bytes()...), false},
		{"too short (19 bytes)", append([]byte{0xef, 0x01, 0x00}, delegate.Bytes()[:19]...), false},
		{"too long (24 bytes)", append(append([]byte{0xef, 0x01, 0x00}, delegate.Bytes()...), 0x00), false},
		{"regular contract bytecode", []byte{0x60, 0x80, 0x60, 0x40, 0x52}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := IsERC7702Delegation(tc.code)
			if got != tc.want {
				t.Errorf("IsERC7702Delegation(%x) = %v, want %v", tc.code, got, tc.want)
			}
		})
	}
}

func TestGetERC7702DelegateAddress(t *testing.T) {
	delegate := common.HexToAddress("0x1234567890abcdef1234567890abcdef12345678")
	validCode := append([]byte{0xef, 0x01, 0x00}, delegate.Bytes()...)

	t.Run("valid delegation", func(t *testing.T) {
		addr, ok := GetERC7702DelegateAddress(validCode)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if addr != delegate {
			t.Errorf("got %s, want %s", addr.Hex(), delegate.Hex())
		}
	})

	t.Run("invalid code returns false", func(t *testing.T) {
		_, ok := GetERC7702DelegateAddress([]byte{0x60, 0x80})
		if ok {
			t.Error("expected ok=false for non-7702 code")
		}
	})

	t.Run("empty code returns false", func(t *testing.T) {
		_, ok := GetERC7702DelegateAddress([]byte{})
		if ok {
			t.Error("expected ok=false for empty code")
		}
	})
}
