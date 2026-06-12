package signinwithx

import (
	"crypto/ecdsa"
	"crypto/ed25519"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/mr-tron/base58"
)

// CompleteInfo is a server challenge (Info) with one chain selected by the
// client. It is the input to the BuildPayload helpers.
type CompleteInfo struct {
	Info
	ChainID         string
	Type            SignatureType
	SignatureScheme SignatureScheme
}

func (info CompleteInfo) fields(address string) messageFields {
	return messageFields{
		domain: info.Domain, address: address, uri: info.URI, statement: info.Statement,
		version: info.Version, chainID: info.ChainID, nonce: info.Nonce, issuedAt: info.IssuedAt,
		expirationTime: info.ExpirationTime, notBefore: info.NotBefore, requestID: info.RequestID,
		resources: info.Resources,
	}
}

func (info CompleteInfo) payload(address, signature string) Payload {
	return Payload{
		Domain: info.Domain, Address: address, Statement: info.Statement, URI: info.URI,
		Version: info.Version, ChainID: info.ChainID, Type: info.Type, Nonce: info.Nonce,
		IssuedAt: info.IssuedAt, ExpirationTime: info.ExpirationTime, NotBefore: info.NotBefore,
		RequestID: info.RequestID, Resources: info.Resources, SignatureScheme: info.SignatureScheme,
		Signature: signature,
	}
}

func buildAndSign(info CompleteInfo, address string, sign func(message string) (string, error)) (Payload, error) {
	message, err := CreateMessage(info.ChainID, info.fields(address))
	if err != nil {
		return Payload{}, err
	}
	signature, err := sign(message)
	if err != nil {
		return Payload{}, err
	}
	return info.payload(address, signature), nil
}

// SignMessageEVM signs an EIP-4361 message with an EOA key via EIP-191
// personal_sign, returning the 0x-hex 65-byte signature (v = 27/28).
func SignMessageEVM(message string, key *ecdsa.PrivateKey) (string, error) {
	sig, err := crypto.Sign(accounts.TextHash([]byte(message)), key)
	if err != nil {
		return "", err
	}
	sig[64] += 27
	return hexutil.Encode(sig), nil
}

// BuildPayloadEVM constructs and signs an EVM proof for info's selected chain.
func BuildPayloadEVM(info CompleteInfo, key *ecdsa.PrivateKey) (Payload, error) {
	address := crypto.PubkeyToAddress(key.PublicKey).Hex()
	return buildAndSign(info, address, func(message string) (string, error) {
		return SignMessageEVM(message, key)
	})
}

// BuildPayloadSolana constructs and signs a Solana proof for info's selected
// chain. The signature and address are base58-encoded.
func BuildPayloadSolana(info CompleteInfo, key ed25519.PrivateKey) (Payload, error) {
	address := base58.Encode(key.Public().(ed25519.PublicKey))
	return buildAndSign(info, address, func(message string) (string, error) {
		return base58.Encode(ed25519.Sign(key, []byte(message))), nil
	})
}
