package client

import (
	"context"

	"github.com/coinbase/x402/go/mechanisms/evm"
)

// ExactEvmChainConfig configures RPC behavior for one chain.
type ExactEvmChainConfig = evm.RPCChainConfig

// ExactEvmSchemeConfig configures RPC behavior for Exact EVM clients.
// If both RPCByChainID and RPCURL are set, chain-specific entries take precedence.
type ExactEvmSchemeConfig = evm.RPCConfig

func (c *ExactEvmScheme) resolveRPCURL(network string) string {
	return evm.ResolveRPCURL(c.config, network)
}

func (c *ExactEvmScheme) resolveReadSigner(
	ctx context.Context,
	network string,
) (evm.ClientEvmSignerWithReadContract, error) {
	return evm.ResolveReadSigner(ctx, c.signer, c.resolveRPCURL(network))
}

func (c *ExactEvmScheme) resolveTxSigner(
	ctx context.Context,
	network string,
) (evm.ClientEvmSignerWithTxSigning, error) {
	return evm.ResolveTxSigner(ctx, c.signer, c.resolveRPCURL(network))
}
