package signinwithx

import (
	"context"
	"fmt"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

// verifyEVM verifies an EIP-191 personal_sign signature over an EIP-4361
// message. By default it recovers an EOA signature with no RPC. When opts
// provides an EVMVerifier, smart-wallet signatures (EIP-1271 / ERC-6492) are
// verified via that facilitator signer's RPC client.
func verifyEVM(ctx context.Context, message string, p Payload, opts *VerifyOptions) VerifyResult {
	if !common.IsHexAddress(p.Address) {
		return VerifyResult{Error: fmt.Sprintf("invalid EVM address: %s", p.Address)}
	}
	sig, err := hexutil.Decode(p.Signature)
	if err != nil {
		return VerifyResult{Error: fmt.Sprintf("invalid signature hex: %v", err)}
	}

	hash := accounts.TextHash([]byte(message))
	address := common.HexToAddress(p.Address)

	if opts != nil && opts.EVMVerifier != nil {
		var hash32 [32]byte
		copy(hash32[:], hash)
		valid, _, err := evm.VerifyUniversalSignature(
			ctx, opts.EVMVerifier, p.Address, hash32, sig, opts.AllowUndeployedSmartWallet,
		)
		if err != nil {
			return VerifyResult{Error: fmt.Sprintf("smart-wallet verification failed: %v", err)}
		}
		if !valid {
			return VerifyResult{Error: "signature verification failed"}
		}
		return VerifyResult{Valid: true, Address: address.Hex()}
	}

	valid, err := evm.VerifyEOASignature(hash, sig, address)
	if err != nil {
		return VerifyResult{Error: fmt.Sprintf("signature verification failed: %v", err)}
	}
	if !valid {
		return VerifyResult{Error: "signature verification failed"}
	}
	return VerifyResult{Valid: true, Address: address.Hex()}
}
