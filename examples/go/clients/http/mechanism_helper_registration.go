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
 * Mechanism Helper Registration Client
 *
 * This demonstrates a convenient pattern using mechanism helpers with wildcard
 * network registration for clean, readable client configuration.
 *
 * This approach is simpler than the builder pattern when you want to register
 * all networks of a particular type with the same signer.
 */

func createMechanismHelperRegistrationClient(evmPrivateKey, svmPrivateKey string) (*x402.X402Client, error) {
	// Create signers from private keys
	evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
	if err != nil {
		return nil, err
	}

	// Start with a new client
	client := x402.Newx402Client()

	// Register EVM schemes for all EVM networks using wildcard
	client.Register("eip155:*", exactevm.NewExactEvmScheme(evmSigner, nil))
	client.Register("eip155:*", uptoevm.NewUptoEvmScheme(evmSigner, nil))

	// Register SVM scheme if key is provided
	if svmPrivateKey != "" {
		svmSigner, err := svmsigners.NewClientSignerFromPrivateKey(svmPrivateKey)
		if err != nil {
			return nil, err
		}

		// Register for all Solana networks using wildcard
		// This registers:
		// - solana:* (all Solana networks in v2)
		client.Register("solana:*", exactsvm.NewExactSvmScheme(svmSigner))
	}

	// The fluent API allows chaining for clean code:
	// client := x402.Newx402Client().
	//     Register("eip155:*", exactevm.NewExactEvmScheme(evmSigner, nil)).
	//     Register("solana:*", exactsvm.NewExactSvmScheme(svmSigner))

	return client, nil
}
