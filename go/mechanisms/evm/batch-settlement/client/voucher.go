package client

import (
	"context"
	"fmt"
	"math/big"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
)

// SignVoucher signs a cumulative voucher using EIP-712.
// Voucher(bytes32 channelId, uint128 maxClaimableAmount)
func SignVoucher(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	channelId string,
	maxClaimableAmount string,
	network string,
) (*batchsettlement.BatchSettlementVoucherFields, error) {
	chainId, err := evm.GetEvmChainId(network)
	if err != nil {
		return nil, fmt.Errorf("failed to get chain ID for %s: %w", network, err)
	}

	maxClaimable, ok := new(big.Int).SetString(maxClaimableAmount, 10)
	if !ok {
		return nil, fmt.Errorf("invalid maxClaimableAmount: %s", maxClaimableAmount)
	}

	channelIdBytes, err := evm.HexToBytes(channelId)
	if err != nil {
		return nil, fmt.Errorf("invalid channelId: %w", err)
	}

	domain := batchsettlement.GetBatchSettlementEip712Domain(chainId)

	types := map[string][]evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"Voucher": batchsettlement.VoucherTypes["Voucher"],
	}

	message := map[string]interface{}{
		"channelId":          channelIdBytes,
		"maxClaimableAmount": maxClaimable,
	}

	signature, err := signer.SignTypedData(ctx, domain, types, "Voucher", message)
	if err != nil {
		return nil, fmt.Errorf("failed to sign voucher: %w", err)
	}

	return &batchsettlement.BatchSettlementVoucherFields{
		ChannelId:          channelId,
		MaxClaimableAmount: maxClaimableAmount,
		Signature:          evm.BytesToHex(signature),
	}, nil
}
