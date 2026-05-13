package core

import (
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
)

// ComputeAuthCaptureNonce computes the deterministic payer-agnostic nonce for the authCapture scheme.
// This mirrors the on-chain _getHashPayerAgnostic logic:
//
//	paymentInfoZeroPayer = paymentInfo with payer = address(0)
//	paymentInfoHash = keccak256(abi.encode(PAYMENT_INFO_TYPEHASH, paymentInfoZeroPayer))
//	nonce = keccak256(abi.encode(chainId, escrowAddress, paymentInfoHash))
func ComputeAuthCaptureNonce(chainID *big.Int, escrowAddress string, paymentInfo evm.AuthCapturePaymentInfo) (string, error) {
	typehash := crypto.Keccak256([]byte(PaymentInfoTypehash))

	operator := common.HexToAddress(paymentInfo.Operator)
	payer := common.HexToAddress("0x0000000000000000000000000000000000000000")
	receiver := common.HexToAddress(paymentInfo.Receiver)
	token := common.HexToAddress(paymentInfo.Token)

	maxAmount, ok := new(big.Int).SetString(paymentInfo.MaxAmount, 10)
	if !ok {
		return "", fmt.Errorf("invalid maxAmount: %s", paymentInfo.MaxAmount)
	}

	preApprovalExpiry := new(big.Int).SetUint64(paymentInfo.PreApprovalExpiry)
	authorizationExpiry := new(big.Int).SetUint64(paymentInfo.AuthorizationExpiry)
	refundExpiry := new(big.Int).SetUint64(paymentInfo.RefundExpiry)
	minFeeBps := new(big.Int).SetUint64(uint64(paymentInfo.MinFeeBps))
	maxFeeBps := new(big.Int).SetUint64(uint64(paymentInfo.MaxFeeBps))
	feeReceiver := common.HexToAddress(paymentInfo.FeeReceiver)

	var salt *big.Int
	if strings.HasPrefix(paymentInfo.Salt, "0x") || strings.HasPrefix(paymentInfo.Salt, "0X") {
		salt, ok = new(big.Int).SetString(strings.TrimPrefix(strings.TrimPrefix(paymentInfo.Salt, "0x"), "0X"), 16)
	} else {
		salt, ok = new(big.Int).SetString(paymentInfo.Salt, 10)
	}
	if !ok {
		return "", fmt.Errorf("invalid salt: %s", paymentInfo.Salt)
	}

	encoded := make([]byte, 0, 13*32)
	encoded = append(encoded, common.LeftPadBytes(typehash, 32)...)
	encoded = append(encoded, common.LeftPadBytes(operator.Bytes(), 32)...)
	encoded = append(encoded, common.LeftPadBytes(payer.Bytes(), 32)...)
	encoded = append(encoded, common.LeftPadBytes(receiver.Bytes(), 32)...)
	encoded = append(encoded, common.LeftPadBytes(token.Bytes(), 32)...)
	encoded = append(encoded, common.LeftPadBytes(maxAmount.Bytes(), 32)...)
	encoded = append(encoded, common.LeftPadBytes(preApprovalExpiry.Bytes(), 32)...)
	encoded = append(encoded, common.LeftPadBytes(authorizationExpiry.Bytes(), 32)...)
	encoded = append(encoded, common.LeftPadBytes(refundExpiry.Bytes(), 32)...)
	encoded = append(encoded, common.LeftPadBytes(minFeeBps.Bytes(), 32)...)
	encoded = append(encoded, common.LeftPadBytes(maxFeeBps.Bytes(), 32)...)
	encoded = append(encoded, common.LeftPadBytes(feeReceiver.Bytes(), 32)...)
	encoded = append(encoded, common.LeftPadBytes(salt.Bytes(), 32)...)

	paymentInfoHash := crypto.Keccak256(encoded)

	escrow := common.HexToAddress(escrowAddress)
	nonceEncoded := make([]byte, 0, 3*32)
	nonceEncoded = append(nonceEncoded, common.LeftPadBytes(chainID.Bytes(), 32)...)
	nonceEncoded = append(nonceEncoded, common.LeftPadBytes(escrow.Bytes(), 32)...)
	nonceEncoded = append(nonceEncoded, common.LeftPadBytes(paymentInfoHash, 32)...)

	nonce := crypto.Keccak256(nonceEncoded)
	return evm.BytesToHex(nonce), nil
}
