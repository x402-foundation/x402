package batchsettlement

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math/big"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

// CloseAuthorizationBinding is the set of fields a close authorization commits to.
type CloseAuthorizationBinding struct {
	Network            string
	FeePayer           string
	ChannelID          string
	MaxClaimableAmount *big.Int
	VoucherExpiresAt   int64
	ValidBefore        int64
	ProgramID          string
}

// EncodeCloseAuthorizationDigest returns the SHA-256 digest the receiver authorizer signs.
// The preimage binds the network, program, sponsor, channel, final voucher, and expiry.
func EncodeCloseAuthorizationDigest(binding CloseAuthorizationBinding) ([]byte, error) {
	network := []byte(binding.Network)
	if len(network) == 0 || len(network) > 0xffff {
		return nil, fmt.Errorf("close authorization network must encode to 1 through 65535 bytes")
	}
	programID := binding.ProgramID
	if programID == "" {
		programID = paymentchannels.ProgramIDBase58
	}
	keys := make([]solana.PublicKey, 3)
	for i, address := range []string{programID, binding.FeePayer, binding.ChannelID} {
		key, err := decodeKey(address)
		if err != nil {
			return nil, fmt.Errorf("close authorization keys must decode to 32 bytes")
		}
		keys[i] = key
	}
	if binding.MaxClaimableAmount == nil || binding.MaxClaimableAmount.Sign() < 0 || !binding.MaxClaimableAmount.IsUint64() {
		return nil, fmt.Errorf("close authorization maxClaimableAmount must fit in a u64")
	}
	if binding.ValidBefore <= 0 || binding.ValidBefore > maxSafeInteger {
		return nil, fmt.Errorf("close authorization validBefore must be a positive safe integer")
	}

	message := make([]byte, len(CloseDomain)+1+2+len(network)+96+24)
	offset := copy(message, CloseDomain)
	message[offset] = 0x00
	offset++
	binary.LittleEndian.PutUint16(message[offset:], uint16(len(network)))
	offset += 2
	offset += copy(message[offset:], network)
	for _, key := range keys {
		offset += copy(message[offset:], key.Bytes())
	}
	binary.LittleEndian.PutUint64(message[offset:], binding.MaxClaimableAmount.Uint64())
	offset += 8
	binary.LittleEndian.PutUint64(message[offset:], uint64(binding.VoucherExpiresAt))
	offset += 8
	binary.LittleEndian.PutUint64(message[offset:], uint64(binding.ValidBefore))

	sum := sha256.Sum256(message)
	return sum[:], nil
}

// SignCloseAuthorization signs a close authorization with the server's receiver authorizer.
func SignCloseAuthorization(
	ctx context.Context,
	authorizer svm.ReceiverAuthorizerSigner,
	binding CloseAuthorizationBinding,
) (CloseAuthorization, error) {
	digest, err := EncodeCloseAuthorizationDigest(binding)
	if err != nil {
		return CloseAuthorization{}, err
	}
	signature, err := authorizer.SignMessage(ctx, digest)
	if err != nil {
		return CloseAuthorization{}, err
	}
	if len(signature) != 64 {
		return CloseAuthorization{}, fmt.Errorf("receiver authorizer did not return a close signature")
	}
	return CloseAuthorization{
		ValidBefore: binding.ValidBefore,
		Signature:   solana.SignatureFromBytes(signature).String(),
	}, nil
}

// VerifyCloseAuthorization reports whether authorization was signed by receiverAuthorizer
// and now < validBefore <= now + maxTimeoutSeconds.
func VerifyCloseAuthorization(
	authorization CloseAuthorization,
	binding CloseAuthorizationBinding,
	receiverAuthorizer string,
	maxTimeoutSeconds int64,
	nowSeconds int64,
) bool {
	if authorization.ValidBefore <= 0 || authorization.ValidBefore > maxSafeInteger {
		return false
	}
	if authorization.ValidBefore <= nowSeconds || authorization.ValidBefore > nowSeconds+maxTimeoutSeconds {
		return false
	}
	binding.ValidBefore = authorization.ValidBefore
	digest, err := EncodeCloseAuthorizationDigest(binding)
	if err != nil {
		return false
	}
	return paymentchannels.VerifyEd25519Signature(mustKey(receiverAuthorizer), mustSig(authorization.Signature), digest) == nil
}
