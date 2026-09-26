package casper_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/x402-foundation/x402/go/v2/mechanisms/casper"
	casperSigners "github.com/x402-foundation/x402/go/v2/signers/casper"
)

func TestFacilitatorSigner_NativeChainName(t *testing.T) {
	for _, test := range []struct{ network, chainName string }{
		{casper.CasperMainnetCAIP2, "casper"},
		{casper.CasperTestnetCAIP2, "casper-test"},
		{"casper:custom-chain", "custom-chain"},
	} {
		t.Run(test.network, func(t *testing.T) {
			signer := casperSigners.NewFacilitatorSigner(casperSigners.FacilitatorSignerConfig{
				RpcURLs: map[string]string{test.network: "http://localhost/rpc"},
			})
			config, err := signer.GetNetworkConfig(context.Background(), test.network)
			require.NoError(t, err)
			assert.Equal(t, test.chainName, config.ChainName)
			assert.Equal(t, "http://localhost/rpc", config.RPCURL)
		})
	}
}
