package batchsettlement

import (
	"context"
	"encoding/binary"
	"fmt"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

// EncodeBatchAuthorizationMessage encodes the channel-bound proof an operator meters against.
func EncodeBatchAuthorizationMessage(channelID, payer, operator, requestID string, authorizedAmount uint64, expiresAt int64) ([]byte, error) {
	channel, err := decodeKey(channelID)
	if err != nil {
		return nil, fmt.Errorf("batch authorization keys must decode to 32 bytes")
	}
	payerKey, err := decodeKey(payer)
	if err != nil {
		return nil, fmt.Errorf("batch authorization keys must decode to 32 bytes")
	}
	operatorKey, err := decodeKey(operator)
	if err != nil {
		return nil, fmt.Errorf("batch authorization keys must decode to 32 bytes")
	}
	if expiresAt <= 0 || expiresAt > maxSafeInteger {
		return nil, fmt.Errorf("batch authorization expiresAt must be a positive safe integer")
	}
	request := []byte(requestID)
	if len(request) == 0 || len(request) > 256 {
		return nil, fmt.Errorf("batch authorization requestId must encode to 1 through 256 bytes")
	}
	message := make([]byte, len(AuthorizationDomain)+114+len(request))
	offset := copy(message, AuthorizationDomain)
	offset += copy(message[offset:], channel[:])
	offset += copy(message[offset:], payerKey[:])
	offset += copy(message[offset:], operatorKey[:])
	binary.LittleEndian.PutUint16(message[offset:], uint16(len(request)))
	offset += 2
	offset += copy(message[offset:], request)
	binary.LittleEndian.PutUint64(message[offset:], authorizedAmount)
	offset += 8
	binary.LittleEndian.PutUint64(message[offset:], uint64(expiresAt))
	return message, nil
}

// SignBatchAuthorization signs an expiring authorization for one operator-bound channel.
func SignBatchAuthorization(
	ctx context.Context,
	payer svm.ReceiverAuthorizerSigner,
	channelID, operator, requestID string,
	authorizedAmount uint64,
	expiresAt int64,
) (BatchAuthorization, error) {
	message, err := EncodeBatchAuthorizationMessage(channelID, payer.Address().String(), operator, requestID, authorizedAmount, expiresAt)
	if err != nil {
		return BatchAuthorization{}, err
	}
	signature, err := payer.SignMessage(ctx, message)
	if err != nil {
		return BatchAuthorization{}, err
	}
	if len(signature) != 64 {
		return BatchAuthorization{}, fmt.Errorf("payer did not return a batch authorization signature")
	}
	return BatchAuthorization{
		Type:             AuthorizationTypeProof,
		ChannelID:        channelID,
		Payer:            payer.Address().String(),
		RequestID:        requestID,
		AuthorizedAmount: FormatU64(authorizedAmount),
		ExpiresAt:        expiresAt,
		Signature:        solana.SignatureFromBytes(signature).String(),
	}, nil
}

// VerifyBatchAuthorization reports whether an unexpired server-mode authorization was signed by the channel payer.
func VerifyBatchAuthorization(authorization BatchAuthorization, operator string, nowSeconds int64) bool {
	if authorization.ExpiresAt <= nowSeconds {
		return false
	}
	amount, err := paymentchannels.ParseU64(authorization.AuthorizedAmount, "amount")
	if err != nil {
		return false
	}
	message, err := EncodeBatchAuthorizationMessage(
		authorization.ChannelID,
		authorization.Payer,
		operator,
		authorization.RequestID,
		amount,
		authorization.ExpiresAt,
	)
	if err != nil {
		return false
	}
	return paymentchannels.VerifyEd25519Signature(mustKey(authorization.Payer), mustSig(authorization.Signature), message) == nil
}

func decodeKey(address string) (solana.PublicKey, error) {
	key, err := solana.PublicKeyFromBase58(address)
	if err != nil || len(key.Bytes()) != 32 {
		return solana.PublicKey{}, fmt.Errorf("key must decode to 32 bytes")
	}
	return key, nil
}
