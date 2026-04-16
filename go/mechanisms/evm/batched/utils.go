package batched

import (
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// channelConfigABIType is the ABI tuple type for ChannelConfig, used for encoding.
var channelConfigABIType abi.Arguments

func init() {
	addressTy, _ := abi.NewType("address", "", nil)
	uint40Ty, _ := abi.NewType("uint40", "", nil)
	bytes32Ty, _ := abi.NewType("bytes32", "", nil)

	channelConfigABIType = abi.Arguments{
		{Name: "payer", Type: addressTy},
		{Name: "payerAuthorizer", Type: addressTy},
		{Name: "receiver", Type: addressTy},
		{Name: "receiverAuthorizer", Type: addressTy},
		{Name: "token", Type: addressTy},
		{Name: "withdrawDelay", Type: uint40Ty},
		{Name: "salt", Type: bytes32Ty},
	}
}

// ComputeChannelId computes the channel ID from a ChannelConfig.
// Matches the on-chain getChannelId: keccak256(abi.encode(channelConfig)).
func ComputeChannelId(config ChannelConfig) (string, error) {
	payer := common.HexToAddress(config.Payer)
	payerAuthorizer := common.HexToAddress(config.PayerAuthorizer)
	receiver := common.HexToAddress(config.Receiver)
	receiverAuthorizer := common.HexToAddress(config.ReceiverAuthorizer)
	token := common.HexToAddress(config.Token)
	withdrawDelay := new(big.Int).SetInt64(int64(config.WithdrawDelay))

	saltBytes, err := hexToBytes32(config.Salt)
	if err != nil {
		return "", fmt.Errorf("invalid salt: %w", err)
	}

	encoded, err := channelConfigABIType.Pack(
		payer,
		payerAuthorizer,
		receiver,
		receiverAuthorizer,
		token,
		withdrawDelay,
		saltBytes,
	)
	if err != nil {
		return "", fmt.Errorf("failed to ABI-encode channel config: %w", err)
	}

	hash := crypto.Keccak256(encoded)
	return fmt.Sprintf("0x%x", hash), nil
}

// NormalizeChannelId lowercases and normalizes a channel ID hex string.
func NormalizeChannelId(channelId string) string {
	return strings.ToLower(channelId)
}

// hexToBytes32 converts a hex string to a [32]byte array.
func hexToBytes32(hex string) ([32]byte, error) {
	var result [32]byte
	hex = strings.TrimPrefix(hex, "0x")
	if len(hex) > 64 {
		return result, fmt.Errorf("hex string too long for bytes32: %s", hex)
	}
	// Left-pad with zeros
	hex = strings.Repeat("0", 64-len(hex)) + hex
	b := common.FromHex("0x" + hex)
	copy(result[:], b)
	return result, nil
}
