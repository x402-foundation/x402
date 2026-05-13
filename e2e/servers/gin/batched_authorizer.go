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

// batchedAuthorizerSigner implements server.AuthorizerSigner using a local
// ECDSA key. Mirrors the nethttp e2e server's `batched_authorizer.go`. Used
// when the e2e harness opts into self-managed receiver authorization via
// EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY.
type batchedAuthorizerSigner struct {
	privateKey *ecdsa.PrivateKey
	address    common.Address
}

func newBatchedAuthorizerSigner(privateKeyHex string) (*batchedAuthorizerSigner, error) {
	pk, err := crypto.HexToECDSA(strings.TrimPrefix(privateKeyHex, "0x"))
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	return &batchedAuthorizerSigner{
		privateKey: pk,
		address:    crypto.PubkeyToAddress(pk.PublicKey),
	}, nil
}

func (s *batchedAuthorizerSigner) Address() string { return s.address.Hex() }

func (s *batchedAuthorizerSigner) SignTypedData(
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
			Name:              toStr(domain.Name),
			Version:           toStr(domain.Version),
			ChainId:           (*math.HexOrDecimal256)(toBig(domain.ChainID)),
			VerifyingContract: toStr(domain.VerifyingContract),
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
	// Conditional EIP712Domain field declaration: matches the populated
	// domain values so HashStruct doesn't fail with "<nil>" when fields like
	// `version` are intentionally omitted (Permit2 uses no version, though
	// the batch-settlement EIP-712 domain itself has both name and version
	// so this branch is mostly defensive parity with the SDK and nethttp).
	if _, ok := td.Types["EIP712Domain"]; !ok {
		domainFields := make([]apitypes.Type, 0, 4)
		if td.Domain.Name != "" {
			domainFields = append(domainFields, apitypes.Type{Name: "name", Type: "string"})
		}
		if td.Domain.Version != "" {
			domainFields = append(domainFields, apitypes.Type{Name: "version", Type: "string"})
		}
		if td.Domain.ChainId != nil {
			domainFields = append(domainFields, apitypes.Type{Name: "chainId", Type: "uint256"})
		}
		if td.Domain.VerifyingContract != "" {
			domainFields = append(domainFields, apitypes.Type{Name: "verifyingContract", Type: "address"})
		}
		td.Types["EIP712Domain"] = domainFields
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
	sig[64] += 27
	return sig, nil
}

func toStr(v interface{}) string {
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

func toBig(v interface{}) *big.Int {
	switch n := v.(type) {
	case *big.Int:
		return n
	case int64:
		return big.NewInt(n)
	case string:
		b, ok := new(big.Int).SetString(n, 10)
		if ok {
			return b
		}
	}
	return big.NewInt(0)
}
