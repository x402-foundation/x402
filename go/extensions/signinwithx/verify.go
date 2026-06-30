package signinwithx

import (
	"context"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	siwe "github.com/signinwithethereum/siwe-go"
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
	if strings.HasPrefix(payload.ChainID, "solana:") {
		return verifySolanaPayload(payload)
	}
	return VerifyResult{
		Valid: false,
		Error: fmt.Sprintf("Unsupported chain namespace: %s. Supported: eip155:* (EVM), solana:* (Solana)", payload.ChainID),
	}
}

func verifyEVMPayload(ctx context.Context, payload Payload, options VerifyOptions) VerifyResult {
	message, err := createSIWEMessage(payload)
	if err != nil {
		return VerifyResult{Valid: false, Error: err.Error()}
	}

	valid, err := verifyEVMMessage(ctx, message, payload.Signature, options)
	if err != nil {
		return VerifyResult{Valid: false, Error: err.Error()}
	}
	if !valid {
		return VerifyResult{Valid: false, Error: "Signature verification failed"}
	}

	return VerifyResult{Valid: true, Address: message.GetAddress().Hex()}
}

func verifyEVMMessage(
	ctx context.Context,
	message *siwe.Message,
	signature string,
	options VerifyOptions,
) (bool, error) {
	if options.EVMVerifier != nil {
		return options.EVMVerifier(ctx, message.GetAddress().Hex(), message.PrepareMessage(), signature)
	}
	if _, err := message.VerifyEIP191(signature); err == nil {
		return true, nil
	}
	if options.EVMContractVerifier == nil {
		return false, nil
	}
	return options.EVMContractVerifier.VerifyContractSignature(
		ctx,
		message.GetAddress(),
		message.EIP191Hash(),
		common.FromHex(signature),
		message.GetChainID(),
	)
}

// VerifyEVMSignature verifies an EIP-191 message signature against an EVM address.
func VerifyEVMSignature(message string, address string, signature string) (bool, error) {
	parsed, err := siwe.ParseMessage(message)
	if err != nil {
		return false, fmt.Errorf("invalid SIWE message: %w", err)
	}
	if !strings.EqualFold(parsed.GetAddress().Hex(), common.HexToAddress(address).Hex()) {
		return false, fmt.Errorf("address mismatch: message address %s, expected %s", parsed.GetAddress().Hex(), address)
	}
	_, err = parsed.VerifyEIP191(signature)
	return err == nil, err
}

func verifySolanaPayload(payload Payload) VerifyResult {
	message, err := FormatSIWSMessage(payload)
	if err != nil {
		return VerifyResult{Valid: false, Error: err.Error()}
	}

	signature, err := DecodeBase58(payload.Signature)
	if err != nil {
		return VerifyResult{Valid: false, Error: fmt.Sprintf("Invalid Base58 encoding: %s", err.Error())}
	}
	publicKey, err := DecodeBase58(payload.Address)
	if err != nil {
		return VerifyResult{Valid: false, Error: fmt.Sprintf("Invalid Base58 encoding: %s", err.Error())}
	}

	if len(signature) != 64 {
		return VerifyResult{Valid: false, Error: fmt.Sprintf("Invalid signature length: expected 64 bytes, got %d", len(signature))}
	}
	if len(publicKey) != 32 {
		return VerifyResult{Valid: false, Error: fmt.Sprintf("Invalid public key length: expected 32 bytes, got %d", len(publicKey))}
	}
	if !VerifySolanaSignature(message, signature, publicKey) {
		return VerifyResult{Valid: false, Error: "Solana signature verification failed"}
	}

	return VerifyResult{Valid: true, Address: payload.Address}
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
