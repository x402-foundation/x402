package client

import (
	"context"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

func (c *BatchSettlementEvmScheme) resolveRPCURL(network string) string {
	return evm.ResolveRPCURL(&evm.RPCConfig{
		RPCURL:       c.config.RPCURL,
		RPCByChainID: c.config.RPCByChainID,
	}, network)
}

func (c *BatchSettlementEvmScheme) resolveReadSigner(
	ctx context.Context,
	network string,
) (evm.ClientEvmSignerWithReadContract, error) {
	return evm.ResolveReadSigner(ctx, c.signer, c.resolveRPCURL(network))
}

func (c *BatchSettlementEvmScheme) resolveTxSigner(
	ctx context.Context,
	network string,
) (evm.ClientEvmSignerWithTxSigning, error) {
	return evm.ResolveTxSigner(ctx, c.signer, c.resolveRPCURL(network))
}
