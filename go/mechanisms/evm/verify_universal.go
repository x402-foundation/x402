package evm

import (
	"context"
	"errors"

	"github.com/ethereum/go-ethereum/common"
)

// VerifyUniversalSignature verifies signatures from EOA, EIP-1271, and ERC-6492 sources.
//
// This function mirrors on-chain SignatureChecker semantics — routing is determined by
// code.length at the signer address, not by the byte-length of the signature. The old
// 65-byte EOA fast-path (that skipped GetCode) was removed because it caused pre-verify
// to accept signatures that on-chain verifiers routed to isValidSignature and rejected,
// most visibly for ERC-7702-delegated EOAs whose delegate rejects raw owner ECDSA.
//
// The verification flow:
//  1. Parse ERC-6492 wrapper if present to extract inner signature
//  2. GetCode — always required; determines whether to use ECDSA or EIP-1271
//  3. If undeployed + has deployment info + allowUndeployed: classify as counterfactual,
//     do not treat as valid until a later onchain simulation succeeds
//  4. If undeployed without deployment info: ECDSA fallback (covers plain EOAs)
//  5. If deployed (any address with code, including ERC-7702): strict EIP-1271
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

	// Step 2: Always fetch code first. Routing is determined by whether the address
	// has bytecode — matching on-chain SignatureChecker (Permit2, USDC v2.2, OZ).
	// We no longer fast-path to ECDSA before GetCode: for ERC-7702 delegated EOAs,
	// the address has code (the delegation designation) and the on-chain verifier
	// routes to isValidSignature, not ecrecover. Pre-verify must do the same.
	code, err := facilitatorSigner.GetCode(ctx, signerAddress)
	if err != nil {
		return false, nil, err
	}

	isDeployed := len(code) > 0
	zeroFactory := [20]byte{}

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
