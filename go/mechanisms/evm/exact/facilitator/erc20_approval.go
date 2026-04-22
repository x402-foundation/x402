package facilitator

import (
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/x402-foundation/x402/go/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
)

// approveSelector is the 4-byte function selector for ERC-20 approve(address,uint256).
// keccak256("approve(address,uint256)") = 0x095ea7b3...
var approveSelector = []byte{0x09, 0x5e, 0xa7, 0xb3}

// ValidateErc20ApprovalForPayment validates the ERC-20 approval extension data.
// Returns ("", "") if valid, or (reason, message) on failure where reason is the
// error constant and message is a human-readable contextual description.
func ValidateErc20ApprovalForPayment(info *erc20approvalgassponsor.Info, payer, tokenAddress string) (reason, message string) {
	if !erc20approvalgassponsor.ValidateInfo(info) {
		return ErrErc20ApprovalInvalidFormat, "ERC-20 approval extension info failed format validation"
	}

	if !strings.EqualFold(info.From, payer) {
		return ErrErc20ApprovalFromMismatch, fmt.Sprintf("expected from=%s, got %s", payer, info.From)
	}

	if !strings.EqualFold(info.Asset, tokenAddress) {
		return ErrErc20ApprovalAssetMismatch, fmt.Sprintf("expected asset=%s, got %s", tokenAddress, info.Asset)
	}

	if !strings.EqualFold(info.Spender, evm.PERMIT2Address) {
		return ErrErc20ApprovalWrongSpender, fmt.Sprintf("expected spender=%s, got %s", evm.PERMIT2Address, info.Spender)
	}

	txHex := strings.TrimPrefix(info.SignedTransaction, "0x")
	txBytes, err := hex.DecodeString(txHex)
	if err != nil {
		return ErrErc20ApprovalTxParseFailed, "failed to hex-decode signed transaction"
	}

	tx := new(types.Transaction)
	if err := tx.UnmarshalBinary(txBytes); err != nil {
		return ErrErc20ApprovalTxParseFailed, "failed to RLP-decode signed transaction"
	}

	txTo := ""
	if tx.To() != nil {
		txTo = tx.To().Hex()
	}
	if tx.To() == nil || !strings.EqualFold(txTo, tokenAddress) {
		return ErrErc20ApprovalWrongTarget, fmt.Sprintf("transaction targets %s, expected %s", txTo, tokenAddress)
	}

	data := tx.Data()
	if len(data) < 4 {
		return ErrErc20ApprovalWrongSelector, "transaction calldata too short for approve() selector"
	}
	for i, b := range approveSelector {
		if data[i] != b {
			return ErrErc20ApprovalWrongSelector, "transaction calldata does not start with approve() selector 0x095ea7b3"
		}
	}

	if len(data) < 36 {
		return ErrErc20ApprovalWrongCalldata, "transaction calldata too short to contain spender parameter"
	}
	calldataSpender := common.BytesToAddress(data[4:36])
	if !strings.EqualFold(calldataSpender.Hex(), evm.PERMIT2Address) {
		return ErrErc20ApprovalWrongCalldata, fmt.Sprintf("approve() spender is %s, expected Permit2 %s", calldataSpender.Hex(), evm.PERMIT2Address)
	}

	chainID := tx.ChainId()
	signer := types.LatestSignerForChainID(chainID)
	from, err := types.Sender(signer, tx)
	if err != nil {
		return ErrErc20ApprovalInvalidSig, "failed to recover signer from the signed transaction"
	}
	if !strings.EqualFold(from.Hex(), payer) {
		return ErrErc20ApprovalSignerMismatch, fmt.Sprintf("transaction signed by %s, expected payer %s", from.Hex(), payer)
	}

	return "", ""
}
