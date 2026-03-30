package client

import (
	"context"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/coinbase/x402/go/extensions/erc20approvalgassponsor"
	"github.com/coinbase/x402/go/mechanisms/evm"
)

// SignErc20ApprovalTransaction creates a signed (but unbroadcast) EIP-1559 transaction
// that calls approve(Permit2, MaxUint256) on the given ERC-20 token.
//
// The returned Info contains the RLP-encoded signed transaction which the facilitator
// will broadcast before calling settle().
func SignErc20ApprovalTransaction(
	ctx context.Context,
	signer evm.ClientEvmSignerWithTxSigning,
	tokenAddress string,
	chainID *big.Int,
) (*erc20approvalgassponsor.Info, error) {
	owner := signer.Address()
	normalizedToken := evm.NormalizeAddress(tokenAddress)
	spender := evm.PERMIT2Address

	// Encode calldata: approve(spender, MaxUint256)
	contractABI, err := abi.JSON(strings.NewReader(string(evm.ERC20ApproveABI)))
	if err != nil {
		return nil, fmt.Errorf("failed to parse approve ABI: %w", err)
	}
	maxUint256 := evm.MaxUint256()
	calldata, err := contractABI.Pack("approve", common.HexToAddress(spender), maxUint256)
	if err != nil {
		return nil, fmt.Errorf("failed to encode approve calldata: %w", err)
	}

	// Get nonce
	nonce, err := signer.GetTransactionCount(ctx, owner)
	if err != nil {
		return nil, fmt.Errorf("failed to get transaction count: %w", err)
	}

	// EstimateFeesPerGas returns usable fallback values even on RPC error,
	// but guard against nil to avoid panic in DynamicFeeTx construction.
	maxFeePerGas, maxPriorityFeePerGas, feeErr := signer.EstimateFeesPerGas(ctx)
	if feeErr != nil && (maxFeePerGas == nil || maxPriorityFeePerGas == nil) {
		return nil, fmt.Errorf("failed to estimate fees and no fallback available: %w", feeErr)
	}

	// Build EIP-1559 transaction
	toAddr := common.HexToAddress(normalizedToken)
	tx := types.NewTx(&types.DynamicFeeTx{
		ChainID:   chainID,
		Nonce:     nonce,
		GasTipCap: maxPriorityFeePerGas,
		GasFeeCap: maxFeePerGas,
		Gas:       evm.ERC20ApproveGasLimit,
		To:        &toAddr,
		Value:     big.NewInt(0),
		Data:      calldata,
	})

	// Sign the transaction
	rlpBytes, err := signer.SignTransaction(ctx, tx)
	if err != nil {
		return nil, fmt.Errorf("failed to sign approve transaction: %w", err)
	}

	signedTxHex := "0x" + hex.EncodeToString(rlpBytes)

	return &erc20approvalgassponsor.Info{
		From:              owner,
		Asset:             normalizedToken,
		Spender:           spender,
		Amount:            maxUint256.String(),
		SignedTransaction: signedTxHex,
		Version:           erc20approvalgassponsor.ERC20ApprovalGasSponsoringVersion,
	}, nil
}
