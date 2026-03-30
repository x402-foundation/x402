package evm

import (
	"errors"
	"math/big"
	"strings"
	"time"

	"github.com/coinbase/x402/go/extensions/eip2612gassponsor"
)

// ValidateEip2612PermitForPayment validates EIP-2612 extension data for a Permit2 payment.
// Returns an empty string if valid, or an error-reason string on failure.
func ValidateEip2612PermitForPayment(info *eip2612gassponsor.Info, payer string, tokenAddress string) string {
	if !eip2612gassponsor.ValidateEip2612GasSponsoringInfo(info) {
		return "invalid_eip2612_extension_format"
	}

	if !strings.EqualFold(info.From, payer) {
		return "eip2612_from_mismatch"
	}

	if !strings.EqualFold(info.Asset, tokenAddress) {
		return "eip2612_asset_mismatch"
	}

	if !strings.EqualFold(info.Spender, PERMIT2Address) {
		return "eip2612_spender_not_permit2"
	}

	// Use a 6-second buffer consistent with Permit2's on-chain deadline check.
	now := time.Now().Unix()
	deadline, ok := new(big.Int).SetString(info.Deadline, 10)
	if !ok || deadline.Int64() < now+Permit2DeadlineBuffer {
		return "eip2612_deadline_expired"
	}

	return ""
}

// SplitEip2612Signature splits a 65-byte hex-encoded signature into v, r, s components.
func SplitEip2612Signature(signature string) (uint8, [32]byte, [32]byte, error) {
	sigBytes, err := HexToBytes(signature)
	if err != nil {
		return 0, [32]byte{}, [32]byte{}, err
	}

	if len(sigBytes) != 65 {
		return 0, [32]byte{}, [32]byte{}, errors.New("signature must be 65 bytes")
	}

	var r, s [32]byte
	copy(r[:], sigBytes[0:32])
	copy(s[:], sigBytes[32:64])
	v := sigBytes[64]

	return v, r, s, nil
}
