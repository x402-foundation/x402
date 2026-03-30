package client

import (
	"context"

	"github.com/coinbase/x402/go/mechanisms/evm"
)

// UptoEvmChainConfig configures RPC behavior for one chain.
type UptoEvmChainConfig = evm.RPCChainConfig

// UptoEvmSchemeConfig configures RPC behavior for Upto EVM clients.
// If both RPCByChainID and RPCURL are set, chain-specific entries take precedence.
type UptoEvmSchemeConfig = evm.RPCConfig

func (c *UptoEvmScheme) resolveRPCURL(network string) string {
	return evm.ResolveRPCURL(c.config, network)
}

func (c *UptoEvmScheme) resolveReadSigner(
	ctx context.Context,
	network string,
) (evm.ClientEvmSignerWithReadContract, error) {
	return evm.ResolveReadSigner(ctx, c.signer, c.resolveRPCURL(network))
}

func (c *UptoEvmScheme) resolveTxSigner(
	ctx context.Context,
	network string,
) (evm.ClientEvmSignerWithTxSigning, error) {
	return evm.ResolveTxSigner(ctx, c.signer, c.resolveRPCURL(network))
}
