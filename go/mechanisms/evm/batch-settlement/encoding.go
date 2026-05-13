package batchsettlement

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

// permit2CollectorDataABI is the ABI tuple (uint256, uint256, bytes, bytes)
// used as collectorData for Permit2DepositCollector.collect:
// (nonce, deadline, permit2Signature, optionalEip2612PermitData).
var permit2CollectorDataABI abi.Arguments

// eip2612PermitDataABI is the ABI tuple (uint256, uint256, uint8, bytes32, bytes32)
// for the optional EIP-2612 permit segment consumed by Permit2DepositCollector.
var eip2612PermitDataABI abi.Arguments

func init() {
	bytes32Ty, _ := abi.NewType("bytes32", "", nil)
	uint8Ty, _ := abi.NewType("uint8", "", nil)
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

	permit2CollectorDataABI = abi.Arguments{
		{Type: uint256Ty}, // nonce
		{Type: uint256Ty}, // deadline
		{Type: bytesTy},   // permit2Signature
		{Type: bytesTy},   // eip2612PermitData (or empty `0x`)
	}

	eip2612PermitDataABI = abi.Arguments{
		{Type: uint256Ty}, // value
		{Type: uint256Ty}, // deadline
		{Type: uint8Ty},   // v
		{Type: bytes32Ty}, // r
		{Type: bytes32Ty}, // s
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

// Eip2612PermitInput is the optional EIP-2612 permit segment consumed by
// Permit2DepositCollector when the deposit goes through the Permit2 path with
// a paired EIP-2612 approval.
type Eip2612PermitInput struct {
	Value    string
	Deadline string
	V        uint8
	R        string // 32-byte hex (with or without 0x prefix)
	S        string
}

// BuildEip2612PermitData ABI-encodes (value, deadline, v, r, s) for the
// optional EIP-2612 permit segment consumed by Permit2DepositCollector.
func BuildEip2612PermitData(input Eip2612PermitInput) ([]byte, error) {
	value, ok := new(big.Int).SetString(input.Value, 10)
	if !ok {
		return nil, fmt.Errorf("invalid permit value: %s", input.Value)
	}
	deadline, ok := new(big.Int).SetString(input.Deadline, 10)
	if !ok {
		return nil, fmt.Errorf("invalid permit deadline: %s", input.Deadline)
	}
	r, err := hexToBytes32(input.R)
	if err != nil {
		return nil, fmt.Errorf("invalid permit r: %w", err)
	}
	s, err := hexToBytes32(input.S)
	if err != nil {
		return nil, fmt.Errorf("invalid permit s: %w", err)
	}

	encoded, err := eip2612PermitDataABI.Pack(value, deadline, input.V, r, s)
	if err != nil {
		return nil, fmt.Errorf("failed to ABI-encode permit data: %w", err)
	}
	return encoded, nil
}

// BuildPermit2CollectorData ABI-encodes (nonce, deadline, permit2Signature,
// eip2612PermitData) as the collectorData passed to deposit(..., collector,
// collectorData) when using the Permit2 transfer method. Pass an empty
// `eip2612PermitData` ([]byte{} or `0x`) when no EIP-2612 permit accompanies
// the Permit2 authorization.
func BuildPermit2CollectorData(nonce, deadline, permit2Signature string, eip2612PermitData []byte) ([]byte, error) {
	n, ok := new(big.Int).SetString(nonce, 10)
	if !ok {
		return nil, fmt.Errorf("invalid permit2 nonce: %s", nonce)
	}
	d, ok := new(big.Int).SetString(deadline, 10)
	if !ok {
		return nil, fmt.Errorf("invalid permit2 deadline: %s", deadline)
	}
	sigBytes := common.FromHex(permit2Signature)
	if eip2612PermitData == nil {
		eip2612PermitData = []byte{}
	}

	encoded, err := permit2CollectorDataABI.Pack(n, d, sigBytes, eip2612PermitData)
	if err != nil {
		return nil, fmt.Errorf("failed to ABI-encode permit2 collector data: %w", err)
	}
	return encoded, nil
}
