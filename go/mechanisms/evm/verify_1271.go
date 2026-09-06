package evm

import (
	"context"
	"errors"
)

// eip1271ABI is the minimal ABI for EIP-1271's isValidSignature function
const eip1271ABI = `[{
	"inputs": [
		{"type": "bytes32", "name": "hash"},
		{"type": "bytes", "name": "signature"}
	],
	"name": "isValidSignature",
	"outputs": [{"type": "bytes4", "name": "magicValue"}],
	"stateMutability": "view",
	"type": "function"
}]`

// eip1271MagicValue is the bytes4 magic value returned by isValidSignature on success
// This is bytes4(keccak256("isValidSignature(bytes32,bytes)"))
var eip1271MagicValue = [4]byte{0x16, 0x26, 0xba, 0x7e}

// VerifyEIP1271Signature verifies a signature from a smart contract wallet using EIP-1271
//
// EIP-1271 defines a standard way for contracts to verify signatures. This function
// calls the isValidSignature(bytes32,bytes) function on the smart contract wallet
// and checks if it returns the magic value 0x1626ba7e.
//
// Args:
//
//	ctx: Context for cancellation and timeout control
//	signer: The facilitator signer that can perform contract calls
//	wallet: The smart contract wallet address (as hex string)
//	hash: The 32-byte message hash that was signed
//	signature: The signature bytes (format is wallet-specific)
//
// Returns:
//
//	true if the contract returns the EIP-1271 magic value
//	error if the contract call fails or returns an invalid response
func VerifyEIP1271Signature(
	ctx context.Context,
	signer FacilitatorEvmSigner,
	wallet string,
	hash [32]byte,
	signature []byte,
) (bool, error) {
	// Call isValidSignature on the smart contract wallet
	result, err := signer.ReadContract(
		ctx,
		wallet,
		[]byte(eip1271ABI),
		"isValidSignature",
		hash,
		signature,
	)
	if err != nil {
		return false, err
	}

	// The result should be bytes4 (4 bytes)
	// ReadContract returns interface{}, so we need to handle the actual type
	resultBytes, ok := result.([]byte)
	if !ok {
		// Try to handle if it's returned as a byte array
		if resultArray, ok := result.([4]byte); ok {
			resultBytes = resultArray[:]
		} else {
			return false, errors.New("invalid return type from isValidSignature: expected bytes4")
		}
	}

	if len(resultBytes) < 4 {
		return false, errors.New("invalid return value from isValidSignature: too short")
	}

	// Extract first 4 bytes as the magic value
	var returnedMagic [4]byte
	copy(returnedMagic[:], resultBytes[:4])

	// Check if it matches the expected EIP-1271 magic value
	return returnedMagic == eip1271MagicValue, nil
}
