package evm

import (
	"context"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/common"
)

// HasEIP6492Deployment reports whether sigData carries ERC-6492 factory deployment
// information (a non-zero factory address and non-empty factory calldata).
//
// Shared across facilitator schemes (exact, batch-settlement) so the counterfactual
// deployment routing is identical everywhere.
func HasEIP6492Deployment(sigData *ERC6492SignatureData) bool {
	if sigData == nil {
		return false
	}
	var zeroFactory [20]byte
	return sigData.Factory != zeroFactory && len(sigData.FactoryCalldata) > 0
}

// IsContractRevert reports whether err looks like an on-chain contract revert (as opposed to
// a transport/RPC failure). Used to avoid misreporting an RPC blip during a post-deploy
// simulation as a deterministic "signature unsupported" rejection. Matches the revert-substring
// heuristic the EIP-3009 revert-reason parsers already rely on.
func IsContractRevert(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "revert")
}

// IsFactoryAllowed reports whether factory is present in allowedFactories (case-insensitive).
// An empty allowlist denies all factories, preventing unconstrained arbitrary call injection.
func IsFactoryAllowed(factory [20]byte, allowedFactories []string) bool {
	factoryHex := strings.ToLower(common.BytesToAddress(factory[:]).Hex())
	for _, allowed := range allowedFactories {
		if strings.ToLower(strings.TrimSpace(allowed)) == factoryHex {
			return true
		}
	}
	return false
}

// SendFactoryDeployTransaction submits the ERC-6492 factory deployment transaction and
// waits for the receipt, returning an error if the deployment transaction reverted.
// It is a no-op (nil) when sigData carries no deployment information.
func SendFactoryDeployTransaction(
	ctx context.Context,
	signer FacilitatorEvmSigner,
	sigData *ERC6492SignatureData,
) error {
	if !HasEIP6492Deployment(sigData) {
		return nil
	}

	txHash, err := signer.SendTransaction(
		ctx,
		common.BytesToAddress(sigData.Factory[:]).Hex(),
		sigData.FactoryCalldata,
	)
	if err != nil {
		return fmt.Errorf("factory deployment transaction failed: %w", err)
	}

	receipt, err := signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return fmt.Errorf("failed to wait for deployment receipt: %w", err)
	}
	if receipt.Status != TxStatusSuccess {
		return fmt.Errorf("deployment transaction reverted")
	}
	return nil
}
