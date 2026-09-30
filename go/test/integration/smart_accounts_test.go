package integration_test

import (
	"context"
	"encoding/binary"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"

	x402evm "github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

const (
	coinbaseSmartWalletFactory = "0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842"
	nexusK1Validator           = "0x0000000002d3cC5642A748B6783F32C032616E03"
	eip1271MagicValue          = "0x1626ba7e"
)

// coinbaseSmartWalletSigner wraps an owner signer and produces Coinbase Smart Wallet signatures.
type coinbaseSmartWalletSigner struct {
	inner             x402evm.ClientEvmSigner
	smartAccountAddr  string
	smartAccountChain *big.Int
}

func newCoinbaseSmartWalletSigner(inner x402evm.ClientEvmSigner, smartAccountAddr string, chainID *big.Int) *coinbaseSmartWalletSigner {
	return &coinbaseSmartWalletSigner{
		inner:             inner,
		smartAccountAddr:  smartAccountAddr,
		smartAccountChain: chainID,
	}
}

func (s *coinbaseSmartWalletSigner) Address() string { return s.smartAccountAddr }

func (s *coinbaseSmartWalletSigner) SignTypedData(
	ctx context.Context,
	domain x402evm.TypedDataDomain,
	types map[string][]x402evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	originalHash, err := hashTypedDataDigest(domain, types, primaryType, message)
	if err != nil {
		return nil, err
	}

	replayDomain := x402evm.TypedDataDomain{
		Name:              "Coinbase Smart Wallet",
		Version:           "1",
		ChainID:           s.smartAccountChain,
		VerifyingContract: s.smartAccountAddr,
	}
	replayTypes := map[string][]x402evm.TypedDataField{
		"CoinbaseSmartWalletMessage": {{Name: "hash", Type: "bytes32"}},
	}
	replayMessage := map[string]interface{}{
		"hash": originalHash,
	}

	innerSig, err := s.inner.SignTypedData(ctx, replayDomain, replayTypes, "CoinbaseSmartWalletMessage", replayMessage)
	if err != nil {
		return nil, fmt.Errorf("sign replay-safe hash: %w", err)
	}
	return wrapCoinbaseSignature(innerSig, 0)
}

// nexusSmartAccountSigner wraps an owner signer and produces Biconomy Nexus ERC-7739 signatures.
type nexusSmartAccountSigner struct {
	inner          x402evm.ClientEvmSigner
	nexusAddr      string
	validatorAddr  string
	verifierDomain apitypes.TypedDataDomain
}

func newNexusSmartAccountSigner(
	inner x402evm.ClientEvmSigner,
	nexusAddr string,
	validatorAddr string,
	verifierDomain apitypes.TypedDataDomain,
) *nexusSmartAccountSigner {
	return &nexusSmartAccountSigner{
		inner:          inner,
		nexusAddr:      nexusAddr,
		validatorAddr:  validatorAddr,
		verifierDomain: verifierDomain,
	}
}

func (s *nexusSmartAccountSigner) Address() string { return s.nexusAddr }

func (s *nexusSmartAccountSigner) SignTypedData(
	ctx context.Context,
	domain x402evm.TypedDataDomain,
	types map[string][]x402evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	nestedTypes := cloneTypes(types)
	nestedTypes["TypedDataSign"] = []x402evm.TypedDataField{
		{Name: "contents", Type: primaryType},
		{Name: "name", Type: "string"},
		{Name: "version", Type: "string"},
		{Name: "chainId", Type: "uint256"},
		{Name: "verifyingContract", Type: "address"},
		{Name: "salt", Type: "bytes32"},
	}
	nestedMessage := map[string]interface{}{
		"contents":          message,
		"name":              s.verifierDomain.Name,
		"version":           s.verifierDomain.Version,
		"chainId":           s.verifierDomain.ChainId,
		"verifyingContract": s.verifierDomain.VerifyingContract,
		"salt":              s.verifierDomain.Salt,
	}

	innerSig, err := s.inner.SignTypedData(ctx, domain, nestedTypes, "TypedDataSign", nestedMessage)
	if err != nil {
		return nil, fmt.Errorf("sign erc7739 nested typed data: %w", err)
	}

	wrapped, err := wrapErc7739TypedDataSignature(domain, types, primaryType, message, innerSig)
	if err != nil {
		return nil, err
	}

	validator := common.Address{}
	out := append(validator.Bytes(), wrapped...)
	return out, nil
}

func hashTypedDataDigest(
	domain x402evm.TypedDataDomain,
	types map[string][]x402evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([32]byte, error) {
	td, err := toApitypes(domain, types, primaryType, message)
	if err != nil {
		return [32]byte{}, err
	}
	domainSeparator, err := td.HashStruct("EIP712Domain", td.Domain.Map())
	if err != nil {
		return [32]byte{}, err
	}
	structHash, err := td.HashStruct(primaryType, message)
	if err != nil {
		return [32]byte{}, err
	}
	raw := append([]byte{0x19, 0x01}, domainSeparator...)
	raw = append(raw, structHash...)
	return crypto.Keccak256Hash(raw), nil
}

func toApitypes(
	domain x402evm.TypedDataDomain,
	types map[string][]x402evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
) (apitypes.TypedData, error) {
	td := apitypes.TypedData{
		Types:       make(apitypes.Types),
		PrimaryType: primaryType,
		Domain: apitypes.TypedDataDomain{
			Name:              domain.Name,
			Version:           domain.Version,
			ChainId:           (*math.HexOrDecimal256)(domain.ChainID),
			VerifyingContract: domain.VerifyingContract,
		},
		Message: message,
	}
	for typeName, fields := range types {
		typedFields := make([]apitypes.Type, len(fields))
		for i, field := range fields {
			typedFields[i] = apitypes.Type{Name: field.Name, Type: field.Type}
		}
		td.Types[typeName] = typedFields
	}
	if _, exists := td.Types["EIP712Domain"]; !exists {
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
	return td, nil
}

func wrapCoinbaseSignature(sig []byte, ownerIndex uint8) ([]byte, error) {
	if len(sig) != 65 {
		return nil, fmt.Errorf("expected 65-byte signature, got %d", len(sig))
	}
	signatureData := append(append([]byte{}, sig[0:32]...), sig[32:64]...)
	signatureData = append(signatureData, sig[64])
	tupleType, err := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "ownerIndex", Type: "uint8"},
		{Name: "signatureData", Type: "bytes"},
	})
	if err != nil {
		return nil, err
	}
	args := abi.Arguments{{Type: tupleType}}
	return args.Pack(struct {
		OwnerIndex    uint8
		SignatureData []byte
	}{OwnerIndex: ownerIndex, SignatureData: signatureData})
}

func wrapErc7739TypedDataSignature(
	domain x402evm.TypedDataDomain,
	types map[string][]x402evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
	signature []byte,
) ([]byte, error) {
	td, err := toApitypes(domain, types, primaryType, message)
	if err != nil {
		return nil, err
	}
	hashedDomain, err := td.HashStruct("EIP712Domain", td.Domain.Map())
	if err != nil {
		return nil, err
	}
	hashedContents, err := td.HashStruct(primaryType, message)
	if err != nil {
		return nil, err
	}
	encodedType, err := encodeType(primaryType, td.Types)
	if err != nil {
		return nil, err
	}
	typeHex := []byte(encodedType)
	var lenBuf [2]byte
	binary.BigEndian.PutUint16(lenBuf[:], uint16(len(typeHex)))

	out := append([]byte{}, signature...)
	out = append(out, hashedDomain...)
	out = append(out, hashedContents...)
	out = append(out, typeHex...)
	out = append(out, lenBuf[:]...)
	return out, nil
}

func encodeType(primaryType string, types apitypes.Types) (string, error) {
	deps := make([]string, 0)
	depSet := map[string]struct{}{}
	var collect func(string) error
	collect = func(typeName string) error {
		if _, ok := depSet[typeName]; ok {
			return nil
		}
		depSet[typeName] = struct{}{}
		fields, ok := types[typeName]
		if !ok {
			return fmt.Errorf("unknown type %s", typeName)
		}
		for _, field := range fields {
			base := strings.Split(field.Type, "[")[0]
			if _, isStruct := types[base]; isStruct && base != "EIP712Domain" {
				if err := collect(base); err != nil {
					return err
				}
			}
		}
		if typeName != "EIP712Domain" {
			deps = append(deps, typeName)
		}
		return nil
	}
	if err := collect(primaryType); err != nil {
		return "", err
	}
	var b strings.Builder
	for _, dep := range deps {
		b.WriteString(dep)
		b.WriteByte('(')
		for i, field := range types[dep] {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(field.Type)
			b.WriteByte(' ')
			b.WriteString(field.Name)
		}
		b.WriteByte(')')
	}
	return b.String(), nil
}

func cloneTypes(in map[string][]x402evm.TypedDataField) map[string][]x402evm.TypedDataField {
	out := make(map[string][]x402evm.TypedDataField, len(in)+1)
	for k, v := range in {
		copied := make([]x402evm.TypedDataField, len(v))
		copy(copied, v)
		out[k] = copied
	}
	return out
}

// fetchNexusVerifierDomain reads eip712Domain() from a deployed Nexus account.
func fetchNexusVerifierDomain(ctx context.Context, signer *realFacilitatorEvmSigner, nexusAddr string) (apitypes.TypedDataDomain, error) {
	const eip712DomainABI = `[{"name":"eip712Domain","type":"function","stateMutability":"view","inputs":[],"outputs":[{"name":"fields","type":"bytes1"},{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"},{"name":"salt","type":"bytes32"},{"name":"extensions","type":"uint256[]"}]}]`
	result, err := callContractAndDecode(ctx, signer.ethClient, nexusAddr, []byte(eip712DomainABI), "eip712Domain")
	if err != nil {
		return apitypes.TypedDataDomain{}, err
	}
	outputs, ok := result.([]interface{})
	if !ok || len(outputs) < 6 {
		return apitypes.TypedDataDomain{}, fmt.Errorf("unexpected eip712Domain result")
	}
	name, _ := outputs[1].(string)
	version, _ := outputs[2].(string)
	chainID, _ := outputs[3].(*big.Int)
	verifyingContract, _ := outputs[4].(common.Address)
	salt, _ := outputs[5].([32]byte)
	return apitypes.TypedDataDomain{
		Name:              name,
		Version:           version,
		ChainId:           (*math.HexOrDecimal256)(chainID),
		VerifyingContract: verifyingContract.Hex(),
		Salt:              hexutil.Encode(salt[:]),
	}, nil
}

// verifyIsValidSignature calls isValidSignature on-chain and checks for 0x1626ba7e.
func verifyIsValidSignature(ctx context.Context, signer *realFacilitatorEvmSigner, accountAddr string, digest [32]byte, signature []byte) (bool, error) {
	const isValidSigABI = `[{"name":"isValidSignature","type":"function","stateMutability":"view","inputs":[{"name":"hash","type":"bytes32"},{"name":"signature","type":"bytes"}],"outputs":[{"type":"bytes4"}]}]`
	result, err := callContractAndDecode(ctx, signer.ethClient, accountAddr, []byte(isValidSigABI), "isValidSignature", digest, signature)
	if err != nil {
		return false, err
	}
	if b, ok := result.([]byte); ok && len(b) >= 4 {
		return strings.EqualFold(hexutil.Encode(b[:4]), eip1271MagicValue), nil
	}
	if magic, ok := result.([4]byte); ok {
		return strings.EqualFold(hexutil.Encode(magic[:]), eip1271MagicValue), nil
	}
	return false, fmt.Errorf("unexpected isValidSignature result type")
}
