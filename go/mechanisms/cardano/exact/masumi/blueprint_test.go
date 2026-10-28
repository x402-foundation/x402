package masumi

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

const specEscrow = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g"

func TestEscrowAddressMatchesSpec(t *testing.T) {
	hash, err := EscrowScriptHash(DefaultDeployment())
	require.NoError(t, err)
	assert.Equal(t, "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad", hash)

	preprod, err := EscrowAddress(cardano.CardanoPreprodCAIP2, DefaultDeployment())
	require.NoError(t, err)
	assert.Equal(t, specEscrow, preprod)

	mainnet, err := EscrowAddress(cardano.CardanoMainnetCAIP2, DefaultDeployment())
	require.NoError(t, err)
	assert.Equal(t, "addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d", mainnet)
}
