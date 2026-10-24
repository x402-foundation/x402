package casper_test

import (
	"encoding/hex"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/x402-foundation/x402/go/v2/mechanisms/casper"
)

func TestGetNetworkConfig_Mainnet(t *testing.T) {
	cfg, err := casper.GetNetworkConfig("casper:casper")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.ChainName != "casper" {
		t.Errorf("ChainName = %q, want %q", cfg.ChainName, "casper")
	}
}

func TestGetNetworkConfig_Testnet(t *testing.T) {
	cfg, err := casper.GetNetworkConfig("casper:casper-test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.ChainName != "casper-test" {
		t.Errorf("ChainName = %q, want %q", cfg.ChainName, "casper-test")
	}
}

func TestGetNetworkConfig_Unsupported(t *testing.T) {
	_, err := casper.GetNetworkConfig("casper:unknown")
	if err == nil {
		t.Error("expected error for unsupported network, got nil")
	}
}

func TestIsValidAccountHash_Valid(t *testing.T) {
	valid := "00" + "aabbccddeeff0011223344556677889900aabbccddeeff0011223344556677889900"[:64]
	if !casper.IsValidAddress(valid) {
		t.Errorf("expected %q to be valid", valid)
	}

	valid2 := "01" + "aabbccddeeff0011223344556677889900aabbccddeeff0011223344556677889900"[:64]
	if !casper.IsValidAddress(valid2) {
		t.Errorf("expected %q to be valid", valid2)
	}
}

func TestIsValidAccountHash_Invalid(t *testing.T) {
	cases := []struct {
		name  string
		input string
	}{
		{"too short", "00aabb"},
		{"wrong prefix", "02" + "aabbccddeeff0011223344556677889900aabbccddeeff0011223344556677889900"[:64]},
		{"not hex", "0z" + "aabbccddeeff0011223344556677889900aabbccddeeff0011223344556677889900"[:64]},
		{"empty", ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if casper.IsValidAddress(tc.input) {
				t.Errorf("expected %q to be invalid", tc.input)
			}
		})
	}
}

func TestIsValidContractPackageHash_Valid(t *testing.T) {
	valid := "aabbccddeeff0011223344556677889900aabbccddeeff0011223344556677889900"[:64]
	if !casper.IsValidContractPackageHash(valid) {
		t.Errorf("expected %q to be valid", valid)
	}
}

func TestIsValidContractPackageHash_Invalid(t *testing.T) {
	cases := []string{
		"tooshort",
		"aabbccddeeff0011223344556677889900aabbccddeeff0011223344556677889900",
		"ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
		"",
	}

	for _, c := range cases {
		if casper.IsValidContractPackageHash(c) {
			t.Errorf("expected %q to be invalid", c)
		}
	}
}

func TestParseAmount_Whole(t *testing.T) {
	result, err := casper.ParseAmount("1000000", 6)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assert.Equal(t, uint64(1000000_000000), result, "ParseAmount(\"1000000\", 6) should equal 1000000")
}

func TestParseAmount_Decimal(t *testing.T) {
	result, err := casper.ParseAmount("1.5", 6)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assert.Equal(t, uint64(1_500000), result, "ParseAmount(\"1.5\", 6) should equal 1500000")
}

func TestParseAmount_Invalid(t *testing.T) {
	_, err := casper.ParseAmount("not-a-number", 6)
	if err == nil {
		t.Error("expected error for invalid amount")
	}
}

func TestChainNameFromNetwork(t *testing.T) {
	tests := []struct {
		network   string
		chainName string
	}{
		{"casper:casper", "casper"},
		{"casper:casper-test", "casper-test"},
	}

	for _, tt := range tests {
		got := casper.ChainNameFromNetwork(tt.network)
		if got != tt.chainName {
			t.Errorf("ChainNameFromNetwork(%q) = %q, want %q", tt.network, got, tt.chainName)
		}
	}
}

func TestDecodeContractPackageHash(t *testing.T) {
	hex64 := "aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788"
	got, err := casper.DecodeContractPackageHash(hex64)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 32 {
		t.Errorf("expected 32-byte array, got %d bytes", len(got))
	}
	if got == ([32]byte{}) {
		t.Error("decoded contract package hash must not be zero")
	}
}

func TestValidateSignatureFormat_Secp256k1ScalarBounds(t *testing.T) {
	const (
		zero             = "0000000000000000000000000000000000000000000000000000000000000000"
		one              = "0000000000000000000000000000000000000000000000000000000000000001"
		halfOrder        = "7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0"
		halfOrderPlusOne = "7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a1"
		orderMinusOne    = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140"
		order            = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
		orderPlusOne     = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142"
	)
	for _, test := range []struct{ name, r, s, reason string }{
		{"minimum scalars", one, one, ""},
		{"s at half order", one, halfOrder, ""},
		{"maximum r and low-s", orderMinusOne, halfOrder, ""},
		{"r zero", zero, one, "r scalar"},
		{"r at order", order, one, "r scalar"},
		{"r overflows to one", orderPlusOne, one, "r scalar"},
		{"s zero", one, zero, "s scalar"},
		{"s at order", one, order, "s scalar"},
		{"s overflows to one", one, orderPlusOne, "s scalar"},
		{"s just above half order", one, halfOrderPlusOne, "low-s"},
		{"s at order minus one", one, orderMinusOne, "low-s"},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw, err := hex.DecodeString("02" + test.r + test.s)
			require.NoError(t, err)
			var signature [65]byte
			copy(signature[:], raw)
			err = casper.ValidateSignatureFormat(signature)
			if test.reason == "" {
				require.NoError(t, err)
				return
			}
			require.ErrorContains(t, err, test.reason)
		})
	}
}

func TestValidateSignatureFormat_AlgorithmTags(t *testing.T) {
	var signature [65]byte
	for i := range signature {
		signature[i] = 0xff
	}
	signature[0] = 0x01
	require.NoError(t, casper.ValidateSignatureFormat(signature), "ed25519 bytes must not be interpreted as secp256k1 scalars")
	for _, tag := range []byte{0x00, 0x03, 0xff} {
		signature[0] = tag
		require.ErrorContains(t, casper.ValidateSignatureFormat(signature), "unsupported Casper signature algorithm tag")
	}
}

func TestGetAssetInfo_OnlyUsesMatchingAsset(t *testing.T) {
	for _, asset := range []string{"", casper.CSPRUSDTestnetAsset, strings.ToUpper(casper.CSPRUSDTestnetAsset)} {
		info, err := casper.GetAssetInfo(casper.CasperTestnetCAIP2, asset)
		require.NoError(t, err)
		assert.Equal(t, casper.CSPRUSDTestnetAsset, info.Asset)
		assert.Equal(t, casper.CSPRUSDDecimals, info.Decimals)
	}
	for _, network := range []string{casper.CasperTestnetCAIP2, "casper:custom"} {
		info, err := casper.GetAssetInfo(network, strings.Repeat("ab", 32))
		require.Error(t, err)
		assert.Nil(t, info)
	}
}

func TestParseAmount_RejectsLossyConversion(t *testing.T) {
	for _, test := range []struct {
		amount   string
		decimals int
	}{
		{"18446744073709.551616", 6},
		{"18446744073709.551617", 6},
		{"1.0000001", 6},
		{"1", -1},
		{"1", 256},
	} {
		t.Run(test.amount, func(t *testing.T) {
			_, err := casper.ParseAmount(test.amount, test.decimals)
			require.Error(t, err)
		})
	}
	value, err := casper.ParseAmount("18446744073709.551615", 6)
	require.NoError(t, err)
	assert.Equal(t, ^uint64(0), value)
}
