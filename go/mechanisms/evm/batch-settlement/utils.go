package batchsettlement

import (
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
)

// ComputeChannelId computes the chain-bound channel ID from a ChannelConfig
// via EIP-712 hashTypedData. The networkOrChainID argument may be either a
// CAIP-2 network identifier (e.g. "eip155:84532") or a numeric chain id as
// a *big.Int.
func ComputeChannelId(config ChannelConfig, networkOrChainID interface{}) (string, error) {
	chainID, err := resolveChainID(networkOrChainID)
	if err != nil {
		return "", err
	}

	saltBytes, err := hexToBytes32(config.Salt)
	if err != nil {
		return "", fmt.Errorf("invalid salt: %w", err)
	}

	message := map[string]interface{}{
		"payer":              common.HexToAddress(config.Payer).Hex(),
		"payerAuthorizer":    common.HexToAddress(config.PayerAuthorizer).Hex(),
		"receiver":           common.HexToAddress(config.Receiver).Hex(),
		"receiverAuthorizer": common.HexToAddress(config.ReceiverAuthorizer).Hex(),
		"token":              common.HexToAddress(config.Token).Hex(),
		"withdrawDelay":      big.NewInt(int64(config.WithdrawDelay)),
		"salt":               saltBytes[:],
	}

	hash, err := evm.HashTypedData(
		GetBatchSettlementEip712Domain(chainID),
		ChannelConfigTypes,
		"ChannelConfig",
		message,
	)
	if err != nil {
		return "", fmt.Errorf("failed to hash channel config: %w", err)
	}
	return fmt.Sprintf("0x%x", hash), nil
}

// resolveChainID accepts either a CAIP-2 network string (e.g. "eip155:84532"),
// a numeric chain id (*big.Int, int, int64, uint64), or anything that
// converts via fmt.Sprint to a CAIP-2 string.
func resolveChainID(networkOrChainID interface{}) (*big.Int, error) {
	switch v := networkOrChainID.(type) {
	case nil:
		return nil, fmt.Errorf("networkOrChainID is required")
	case string:
		return evm.GetEvmChainId(v)
	case *big.Int:
		if v == nil {
			return nil, fmt.Errorf("networkOrChainID is required")
		}
		return new(big.Int).Set(v), nil
	case int:
		return big.NewInt(int64(v)), nil
	case int64:
		return big.NewInt(v), nil
	case uint64:
		return new(big.Int).SetUint64(v), nil
	default:
		return nil, fmt.Errorf("unsupported networkOrChainID type %T", networkOrChainID)
	}
}

// NormalizeChannelId lowercases and normalizes a channel ID hex string.
func NormalizeChannelId(channelId string) string {
	return strings.ToLower(channelId)
}

// GetBatchSettlementEip712Domain returns the EIP-712 domain for the
// batch-settlement contract on the given chain.
func GetBatchSettlementEip712Domain(chainID *big.Int) evm.TypedDataDomain {
	return evm.TypedDataDomain{
		Name:              BatchSettlementDomain.Name,
		Version:           BatchSettlementDomain.Version,
		ChainID:           chainID,
		VerifyingContract: common.HexToAddress(BatchSettlementAddress).Hex(),
	}
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
