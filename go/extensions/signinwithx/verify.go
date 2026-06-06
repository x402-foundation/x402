package signinwithx

import (
	"context"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

// VerifySignature verifies a SIWX payload signature.
func VerifySignature(payload Payload) VerifyResult {
	return VerifySignatureWithOptions(context.Background(), payload, VerifyOptions{})
}

// VerifySignatureWithOptions verifies a SIWX payload signature with optional chain-specific verifiers.
func VerifySignatureWithOptions(ctx context.Context, payload Payload, options VerifyOptions) VerifyResult {
	if strings.HasPrefix(payload.ChainID, "eip155:") {
		return verifyEVMPayload(ctx, payload, options)
	}
	return VerifyResult{
		Valid: false,
		Error: fmt.Sprintf("Unsupported chain namespace: %s. Supported: eip155:* (EVM)", payload.ChainID),
	}
}

func verifyEVMPayload(ctx context.Context, payload Payload, options VerifyOptions) VerifyResult {
	message, err := FormatSIWEMessage(payload)
	if err != nil {
		return VerifyResult{Valid: false, Error: err.Error()}
	}

	valid, err := verifyEVMMessage(ctx, message, payload.Address, payload.Signature, options)
	if err != nil {
		return VerifyResult{Valid: false, Error: err.Error()}
	}
	if !valid {
		return VerifyResult{Valid: false, Error: "Signature verification failed"}
	}

	return VerifyResult{Valid: true, Address: common.HexToAddress(payload.Address).Hex()}
}

func verifyEVMMessage(
	ctx context.Context,
	message string,
	address string,
	signature string,
	options VerifyOptions,
) (bool, error) {
	if options.EVMVerifier != nil {
		return options.EVMVerifier(ctx, address, message, signature)
	}
	return VerifyEVMSignature(message, address, signature)
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

// NewUniversalEVMVerifier creates an EVM verifier for EOA and deployed EIP-1271 signatures.
func NewUniversalEVMVerifier(signer evm.FacilitatorEvmSigner) EVMMessageVerifier {
	return func(ctx context.Context, address string, message string, signature string) (bool, error) {
		if signer == nil {
			return false, fmt.Errorf("EVM verifier signer is required")
		}
		if !common.IsHexAddress(address) {
			return false, fmt.Errorf("invalid EVM address: %s", address)
		}

		hash := accounts.TextHash([]byte(message))
		var hash32 [32]byte
		copy(hash32[:], hash)

		valid, _, err := evm.VerifyUniversalSignature(
			ctx,
			signer,
			address,
			hash32,
			common.FromHex(signature),
			false,
		)
		return valid, err
	}
}
