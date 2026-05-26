package evm

import (
	"bytes"
	"fmt"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

// erc6492MagicBytes is the 32-byte magic value suffix for ERC-6492 signatures
// This is bytes32(uint256(keccak256("erc6492.invalid.signature")) - 1)
var erc6492MagicBytes = common.Hex2Bytes(
	"6492649264926492649264926492649264926492649264926492649264926492",
)

// IsERC6492Signature checks if a signature has the ERC-6492 magic suffix
//
// ERC-6492 signatures are wrapped signatures for counterfactual smart contract accounts.
// They end with a specific 32-byte magic value to distinguish them from regular signatures.
//
// Args:
//
//	sig: The signature bytes to check
//
// Returns:
//
//	true if the signature ends with the ERC-6492 magic value
func IsERC6492Signature(sig []byte) bool {
	if len(sig) < 32 {
		return false
	}
	return bytes.Equal(sig[len(sig)-32:], erc6492MagicBytes)
}

// ParseERC6492Signature unwraps an ERC-6492 signature to extract its components
//
// ERC-6492 Format:
//
//	abi.encode((address factory, bytes factoryCalldata, bytes signature)) + magicBytes
//
// If the signature is not ERC-6492 format, it returns the original signature
// as the InnerSignature with empty Factory and FactoryCalldata.
//
// Args:
//
//	sig: The signature bytes (may or may not be ERC-6492 wrapped)
//
// Returns:
//
//	ERC6492SignatureData containing the parsed components
//	error if the ERC-6492 format is invalid
func ParseERC6492Signature(sig []byte) (*ERC6492SignatureData, error) {
	// If not ERC-6492, return original signature
	if !IsERC6492Signature(sig) {
		return &ERC6492SignatureData{
			InnerSignature: sig,
		}, nil
	}

	// Strip magic value
	payload := sig[:len(sig)-32]

	// Define ABI types for (address, bytes, bytes)
	addressTy, err := abi.NewType("address", "", nil)
	if err != nil {
		return nil, err
	}
	bytesTy, err := abi.NewType("bytes", "", nil)
	if err != nil {
		return nil, err
	}

	arguments := abi.Arguments{
		{Type: addressTy}, // factory
		{Type: bytesTy},   // factoryCalldata
		{Type: bytesTy},   // originalSignature
	}

	// Unpack the ABI-encoded data
	unpacked, err := arguments.Unpack(payload)
	if err != nil {
		return nil, err
	}

	if len(unpacked) != 3 {
		return nil, fmt.Errorf("invalid ERC-6492 signature: expected 3 fields, got %d", len(unpacked))
	}

	factory, ok := unpacked[0].(common.Address)
	if !ok {
		return nil, fmt.Errorf("invalid ERC-6492 signature: factory is not an address")
	}

	factoryCalldata, ok := unpacked[1].([]byte)
	if !ok {
		return nil, fmt.Errorf("invalid ERC-6492 signature: factoryCalldata is not bytes")
	}

	innerSignature, ok := unpacked[2].([]byte)
	if !ok {
		return nil, fmt.Errorf("invalid ERC-6492 signature: innerSignature is not bytes")
	}

	// Convert factory address to [20]byte
	var factoryBytes [20]byte
	copy(factoryBytes[:], factory.Bytes())

	return &ERC6492SignatureData{
		Factory:         factoryBytes,
		FactoryCalldata: factoryCalldata,
		InnerSignature:  innerSignature,
	}, nil
}
