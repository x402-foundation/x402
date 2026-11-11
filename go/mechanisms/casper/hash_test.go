package casper_test

import (
	"encoding/hex"
	"math/big"
	"testing"

	eip712 "github.com/casper-ecosystem/casper-eip-712/go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/x402-foundation/x402/go/v2/mechanisms/casper"
)

func TestTransferWithAuthorizationDigest_Vector(t *testing.T) {
	contractPackageHash, err := hex.DecodeString("aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788")
	require.NoError(t, err)
	var cpHash [32]byte
	copy(cpHash[:], contractPackageHash)

	fromAddr, err := eip712.NewAddressFromHex("0x01aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788")
	require.NoError(t, err)
	toAddr, err := eip712.NewAddressFromHex("0x00aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788")
	require.NoError(t, err)

	var nonceBytes [32]byte
	nonceRaw, err := hex.DecodeString("aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788")
	require.NoError(t, err)
	copy(nonceBytes[:], nonceRaw)

	types := eip712.TypeDefinitions{
		"TransferWithAuthorization": {
			{Name: "from", Type: "address"},
			{Name: "to", Type: "address"},
			{Name: "value", Type: "uint256"},
			{Name: "validAfter", Type: "uint256"},
			{Name: "validBefore", Type: "uint256"},
			{Name: "nonce", Type: "bytes32"},
		},
	}

	message := map[string]interface{}{
		"from":        fromAddr,
		"to":          toAddr,
		"value":       big.NewInt(1000000),
		"validAfter":  big.NewInt(1700000000),
		"validBefore": big.NewInt(1700001000),
		"nonce":       nonceBytes,
	}

	// Expected values use direct Keccak-256 hashing of the CEP-3009 encoded slots,
	// independently of the EIP-712 package's domain and typed-data helpers.
	for _, vector := range []struct{ network, domainHash, digest string }{
		{casper.CasperTestnetCAIP2, "dec1e63a2e5166322c3479e08e51e3b20649e7e2f6a7d231943b1ea2636348ea", "6582fa2ee7b85d7dc2ef117b2d4ed6fe1e3181f6c987703d3cbf6848003d8a1d"},
		{casper.CasperMainnetCAIP2, "c4e1942755677d2a25aeabb566447351d08beb81b28a71735d306a3b4eec736c", "4558ebff71a3217915a91a6df7ca0797d19a2b35fce8947be1edec8049b47bb2"},
	} {
		t.Run(vector.network, func(t *testing.T) {
			domain := eip712.BuildDomain("TestToken", "1", vector.network, cpHash)
			opts := &eip712.TypedDataOptions{DomainTypes: eip712.CasperDomainTypes}
			domainHash, err := eip712.HashDomainSeparator(domain, opts)
			require.NoError(t, err)
			assert.Equal(t, vector.domainHash, hex.EncodeToString(domainHash[:]))
			digest, err := eip712.HashTypedData(domain, types, "TransferWithAuthorization", message, opts)
			require.NoError(t, err)
			assert.Equal(t, vector.digest, hex.EncodeToString(digest[:]))
		})
	}
}
