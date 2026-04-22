package batched

import (
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// erc3009DepositNonceABI is the ABI tuple (bytes32, uint256) used to derive
// the ERC-3009 deposit nonce: keccak256(abi.encode(channelId, salt)).
var erc3009DepositNonceABI abi.Arguments

// erc3009CollectorDataABI is the ABI tuple (uint256, uint256, uint256, bytes)
// used as collectorData passed to deposit(..., collector, collectorData).
var erc3009CollectorDataABI abi.Arguments

func init() {
	bytes32Ty, _ := abi.NewType("bytes32", "", nil)
	uint256Ty, _ := abi.NewType("uint256", "", nil)
	bytesTy, _ := abi.NewType("bytes", "", nil)

	erc3009DepositNonceABI = abi.Arguments{
		{Type: bytes32Ty},
		{Type: uint256Ty},
	}

	erc3009CollectorDataABI = abi.Arguments{
		{Type: uint256Ty}, // validAfter
		{Type: uint256Ty}, // validBefore
		{Type: uint256Ty}, // salt
		{Type: bytesTy},   // signature
	}
}

// BuildErc3009DepositNonce computes the ERC-3009 nonce used by the deposit
// collector: keccak256(abi.encode(channelId, salt)).
func BuildErc3009DepositNonce(channelId string, salt string) (string, error) {
	channelIdBytes, err := hexToBytes32(channelId)
	if err != nil {
		return "", fmt.Errorf("invalid channelId: %w", err)
	}
	saltBig, ok := new(big.Int).SetString(strings.TrimPrefix(salt, "0x"), 16)
	if !ok {
		return "", fmt.Errorf("invalid salt: %s", salt)
	}

	encoded, err := erc3009DepositNonceABI.Pack(channelIdBytes, saltBig)
	if err != nil {
		return "", fmt.Errorf("failed to ABI-encode deposit nonce inputs: %w", err)
	}
	return fmt.Sprintf("0x%x", crypto.Keccak256(encoded)), nil
}

// BuildErc3009CollectorData ABI-encodes (validAfter, validBefore, salt, signature)
// for ERC3009DepositCollector.collect().
func BuildErc3009CollectorData(validAfter, validBefore, salt, signature string) ([]byte, error) {
	va, ok := new(big.Int).SetString(validAfter, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validAfter: %s", validAfter)
	}
	vb, ok := new(big.Int).SetString(validBefore, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validBefore: %s", validBefore)
	}
	saltBig, ok := new(big.Int).SetString(strings.TrimPrefix(salt, "0x"), 16)
	if !ok {
		return nil, fmt.Errorf("invalid salt: %s", salt)
	}
	sigBytes := common.FromHex(signature)

	encoded, err := erc3009CollectorDataABI.Pack(va, vb, saltBig, sigBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to ABI-encode collector data: %w", err)
	}
	return encoded, nil
}
