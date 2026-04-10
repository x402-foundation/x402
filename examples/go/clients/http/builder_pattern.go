package main

import (
	x402 "github.com/x402-foundation/x402/go"
	exactevm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/client"
	uptoevm "github.com/x402-foundation/x402/go/mechanisms/evm/upto/client"
	exactsvm "github.com/x402-foundation/x402/go/mechanisms/svm/exact/client"
	evmsigners "github.com/x402-foundation/x402/go/signers/evm"
	svmsigners "github.com/x402-foundation/x402/go/signers/svm"
)

/**
 * Builder Pattern Client
 *
 * This demonstrates the basic way to configure an x402 client by chaining
 * Register() calls to map network patterns to scheme clients.
 *
 * This approach gives you fine-grained control over which networks use
 * which signers and schemes.
 */

func createBuilderPatternClient(evmPrivateKey, svmPrivateKey string) (*x402.X402Client, error) {
	// Create signers from private keys
	evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
	if err != nil {
		return nil, err
	}

	// Create client and register schemes using builder pattern
	client := x402.Newx402Client()

	// Register EVM schemes for all EVM networks
	client.Register("eip155:*", exactevm.NewExactEvmScheme(evmSigner, nil))
	client.Register("eip155:*", uptoevm.NewUptoEvmScheme(evmSigner, nil))

	// You can also register specific networks for fine-grained control
	// For example, use a different signer for Ethereum mainnet:
	// ethereumSigner := evmsigners.NewClientSignerFromPrivateKey(ethereumKey)
	// client.Register("eip155:1", exactevm.NewExactEvmScheme(ethereumSigner, nil))

	// Register SVM scheme if key is provided
	if svmPrivateKey != "" {
		svmSigner, err := svmsigners.NewClientSignerFromPrivateKey(svmPrivateKey)
		if err != nil {
			return nil, err
		}

		// Register for all Solana networks
		client.Register("solana:*", exactsvm.NewExactSvmScheme(svmSigner))

		// Could also register specific networks:
		// client.Register("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", exactsvm.NewExactSvmScheme(solanaMainnetSigner))
		// client.Register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", exactsvm.NewExactSvmScheme(solanaDevnetSigner))
	}

	return client, nil
}
