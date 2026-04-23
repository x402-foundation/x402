package main

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
)

func toString(v interface{}) string {
	switch s := v.(type) {
	case string:
		return s
	case *string:
		if s != nil {
			return *s
		}
	}
	return ""
}

func toHexBigInt(v interface{}) *math.HexOrDecimal256 {
	switch n := v.(type) {
	case *big.Int:
		return (*math.HexOrDecimal256)(n)
	case int64:
		return (*math.HexOrDecimal256)(big.NewInt(n))
	case string:
		b, ok := new(big.Int).SetString(n, 10)
		if ok {
			return (*math.HexOrDecimal256)(b)
		}
	}
	return (*math.HexOrDecimal256)(big.NewInt(0))
}

// receiverAuthorizerSigner implements server.AuthorizerSigner using a local
// ECDSA key. In production you'd wrap your KMS / HSM here instead.
type receiverAuthorizerSigner struct {
	privateKey *ecdsa.PrivateKey
	address    common.Address
}

func newReceiverAuthorizerSigner(privateKeyHex string) (*receiverAuthorizerSigner, error) {
	pk, err := crypto.HexToECDSA(strings.TrimPrefix(privateKeyHex, "0x"))
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	return &receiverAuthorizerSigner{
		privateKey: pk,
		address:    crypto.PubkeyToAddress(pk.PublicKey),
	}, nil
}

func (s *receiverAuthorizerSigner) Address() string {
	return s.address.Hex()
}

func (s *receiverAuthorizerSigner) SignTypedData(
	_ context.Context,
	domain evm.TypedDataDomain,
	types map[string][]evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	td := apitypes.TypedData{
		Types:       apitypes.Types{},
		PrimaryType: primaryType,
		Domain: apitypes.TypedDataDomain{
			Name:              toString(domain.Name),
			Version:           toString(domain.Version),
			ChainId:           toHexBigInt(domain.ChainID),
			VerifyingContract: toString(domain.VerifyingContract),
		},
		Message: message,
	}
	for name, fields := range types {
		conv := make([]apitypes.Type, len(fields))
		for i, f := range fields {
			conv[i] = apitypes.Type{Name: f.Name, Type: f.Type}
		}
		td.Types[name] = conv
	}
	if _, ok := td.Types["EIP712Domain"]; !ok {
		td.Types["EIP712Domain"] = []apitypes.Type{
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		}
	}

	dataHash, err := td.HashStruct(td.PrimaryType, td.Message)
	if err != nil {
		return nil, fmt.Errorf("hash struct: %w", err)
	}
	domainSep, err := td.HashStruct("EIP712Domain", td.Domain.Map())
	if err != nil {
		return nil, fmt.Errorf("hash domain: %w", err)
	}

	digest := crypto.Keccak256(append([]byte{0x19, 0x01}, append(domainSep, dataHash...)...))
	sig, err := crypto.Sign(digest, s.privateKey)
	if err != nil {
		return nil, fmt.Errorf("sign: %w", err)
	}
	// EIP-155 v adjustment.
	sig[64] += 27
	return sig, nil
}
