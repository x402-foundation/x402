package evm

import (
	"context"
	"errors"

	"github.com/ethereum/go-ethereum/common"
)

// VerifyUniversalSignature verifies signatures from EOA, EIP-1271, and ERC-6492 sources
//
// This function provides a unified verification interface that automatically detects
// and handles three types of Ethereum signatures:
// - EOA (Externally Owned Account): Standard ECDSA signatures
// - EIP-1271: Smart contract wallet signatures (deployed contracts)
// - ERC-6492: Counterfactual signatures (undeployed contracts with deployment info)
//
// The verification flow:
//  1. Parse ERC-6492 wrapper if present to extract inner signature
//  2. If inner signature is exactly 65 bytes AND no factory: EOA path (optimization - skips GetCode)
//  3. Otherwise: check if contract is deployed (GetCode)
//  4. If undeployed + has deployment info + allowUndeployed: classify as counterfactual,
//     but do not treat it as valid until a later onchain simulation succeeds
//  5. If undeployed without deployment info: fallback to EOA verification
//  6. If deployed: use EIP-1271 verification
//
// Args:
//
//	ctx: Context for cancellation and timeout control
//	facilitatorSigner: The facilitator signer for blockchain interactions
//	signerAddress: The address that should have signed (hex string)
//	hash: The 32-byte message hash that was signed
//	signature: The signature bytes (may be wrapped in ERC-6492 format)
//	allowUndeployed: Whether to accept ERC-6492 signatures from undeployed wallets
//
// Returns:
//
//	valid: true if the signature is valid
//	sigData: Parsed ERC-6492 data (if applicable)
//	error: Any error that occurred during verification
func VerifyUniversalSignature(
	ctx context.Context,
	facilitatorSigner FacilitatorEvmSigner,
	signerAddress string,
	hash [32]byte,
	signature []byte,
	allowUndeployed bool,
) (bool, *ERC6492SignatureData, error) {
	// Step 1: Parse ERC-6492 wrapper if present
	sigData, err := ParseERC6492Signature(signature)
	if err != nil {
		return false, nil, err
	}

	// Step 2: Detect if this is likely a smart wallet signature
	// EOA signatures are exactly 65 bytes
	// Smart wallet signatures can be any other length or have ERC-6492 deployment info
	zeroFactory := [20]byte{}
	isEOASignature := len(sigData.InnerSignature) == 65 && sigData.Factory == zeroFactory

	// Step 3: If clearly an EOA signature, skip to EOA verification (optimization)
	if isEOASignature {
		// EOA signature - use ECDSA recovery directly (avoids GetCode call)
		signerAddr := common.HexToAddress(signerAddress)
		valid, err := VerifyEOASignature(hash[:], sigData.InnerSignature, signerAddr)
		if err == nil {
			return valid, sigData, nil
		}
		// EOA verification failed - could be smart wallet with 65-byte sig, fall through to check GetCode
	}

	// Step 4: Potential smart wallet signature - check if contract is deployed
	code, err := facilitatorSigner.GetCode(ctx, signerAddress)
	if err != nil {
		return false, nil, err
	}

	isDeployed := len(code) > 0

	// Step 5: Handle undeployed address
	if !isDeployed {
		// Check if there's ERC-6492 deployment information
		hasDeploymentInfo := sigData.Factory != zeroFactory &&
			len(sigData.FactoryCalldata) > 0

		if hasDeploymentInfo {
			// Undeployed smart wallet with ERC-6492 deployment info
			if !allowUndeployed {
				return false, nil, errors.New(ErrUndeployedSmartWallet + ": undeployed not allowed")
			}
			// Preserve deployment info for callers, but require a later simulation
			// to prove the inner signature would succeed onchain.
			return false, sigData, nil
		}

		// No deployment info - try EOA verification as fallback
		// This handles the case where someone sends a non-65-byte signature from an EOA
		signerAddr := common.HexToAddress(signerAddress)
		valid, err := VerifyEOASignature(hash[:], sigData.InnerSignature, signerAddr)
		if err != nil {
			return false, sigData, err
		}
		return valid, sigData, nil
	}

	// Step 6: Deployed smart contract - use EIP-1271 verification
	valid, err := VerifyEIP1271Signature(
		ctx,
		facilitatorSigner,
		signerAddress,
		hash,
		sigData.InnerSignature,
	)
	return valid, sigData, err
}
