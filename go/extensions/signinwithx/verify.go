package signinwithx

import (
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// VerifySignature verifies a SIWX payload signature.
func VerifySignature(payload Payload) VerifyResult {
	if strings.HasPrefix(payload.ChainID, "eip155:") {
		return verifyEVMPayload(payload)
	}
	return VerifyResult{
		Valid: false,
		Error: fmt.Sprintf("Unsupported chain namespace: %s. Supported: eip155:* (EVM)", payload.ChainID),
	}
}

func verifyEVMPayload(payload Payload) VerifyResult {
	message, err := FormatSIWEMessage(payload)
	if err != nil {
		return VerifyResult{Valid: false, Error: err.Error()}
	}

	valid, err := VerifyEVMSignature(message, payload.Address, payload.Signature)
	if err != nil {
		return VerifyResult{Valid: false, Error: err.Error()}
	}
	if !valid {
		return VerifyResult{Valid: false, Error: "Signature verification failed"}
	}

	return VerifyResult{Valid: true, Address: common.HexToAddress(payload.Address).Hex()}
}

// VerifyEVMSignature verifies an EIP-191 message signature against an EVM address.
func VerifyEVMSignature(message string, address string, signature string) (bool, error) {
	if !common.IsHexAddress(address) {
		return false, fmt.Errorf("invalid EVM address: %s", address)
	}

	sig := common.FromHex(signature)
	if len(sig) != 65 {
		return false, fmt.Errorf("invalid EVM signature length: expected 65 bytes")
	}

	v := sig[64]
	if v >= 27 {
		sig[64] = v - 27
	}
	if sig[64] != 0 && sig[64] != 1 {
		return false, fmt.Errorf("invalid EVM signature recovery id")
	}

	pubKey, err := crypto.SigToPub(accounts.TextHash([]byte(message)), sig)
	if err != nil {
		return false, err
	}

	recovered := crypto.PubkeyToAddress(*pubKey)
	return recovered == common.HexToAddress(address), nil
}
