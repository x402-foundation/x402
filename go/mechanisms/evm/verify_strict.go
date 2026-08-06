package evm

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// VerifySignatureStrict verifies a raw 32-byte digest against an address using the same
// code-routing rule as on-chain SignatureChecker (Permit2, USDC v2.2, OpenZeppelin):
//
//   - address has no bytecode → ecrecover (EOA path)
//   - address has bytecode   → IERC1271.isValidSignature (strict EIP-1271, no ECDSA fallback)
//
// This prevents the pre-verify/on-chain divergence that arises when an ECDSA fallback accepts
// signatures that the on-chain verifier routes to EIP-1271 and rejects — most visibly for
// ERC-7702 delegated EOAs whose delegate does not accept raw owner ECDSA.
func VerifySignatureStrict(
	ctx context.Context,
	signer FacilitatorEvmSigner,
	address string,
	hash [32]byte,
	signature []byte,
) (bool, error) {
	code, err := signer.GetCode(ctx, address)
	if err != nil {
		return false, fmt.Errorf("VerifySignatureStrict: GetCode failed: %w", err)
	}
	if len(code) == 0 {
		// EOA path: pure ecrecover. A malformed or unrecoverable signature is simply
		// invalid (false), not a system error — discard the verification error.
		valid, _ := VerifyEOASignature(hash[:], signature, common.HexToAddress(address))
		return valid, nil
	}
	// Has code (contract or ERC-7702 delegation): strict EIP-1271, no ECDSA fallback.
	// Propagate errors rather than converting them to (false, nil) — callers need to
	// distinguish transient RPC failures from genuinely invalid signatures so they can
	// surface 5xx errors instead of permanently rejecting valid payments.
	valid, err := VerifyEIP1271Signature(ctx, signer, address, hash, signature)
	if err != nil {
		return false, fmt.Errorf("EIP-1271 verification failed: %w", err)
	}
	return valid, nil
}

// HashEIP712TypedData computes the canonical EIP-712 digest:
// keccak256("\x19\x01" || domainSeparator || hashStruct(message))
func HashEIP712TypedData(
	domain TypedDataDomain,
	types map[string][]TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([32]byte, error) {
	td := apitypes.TypedData{
		Types:       make(apitypes.Types),
		PrimaryType: primaryType,
		Message:     apitypes.TypedDataMessage(message),
	}

	td.Domain = apitypes.TypedDataDomain{
		Name:              domain.Name,
		Version:           domain.Version,
		VerifyingContract: domain.VerifyingContract,
	}
	if domain.ChainID != nil {
		td.Domain.ChainId = (*math.HexOrDecimal256)(new(big.Int).Set(domain.ChainID))
	}

	domainFields := []apitypes.Type{}
	if domain.Name != "" {
		domainFields = append(domainFields, apitypes.Type{Name: "name", Type: "string"})
	}
	if domain.Version != "" {
		domainFields = append(domainFields, apitypes.Type{Name: "version", Type: "string"})
	}
	if domain.ChainID != nil {
		domainFields = append(domainFields, apitypes.Type{Name: "chainId", Type: "uint256"})
	}
	if domain.VerifyingContract != "" {
		domainFields = append(domainFields, apitypes.Type{Name: "verifyingContract", Type: "address"})
	}
	td.Types["EIP712Domain"] = domainFields

	for typeName, fields := range types {
		apiFields := make([]apitypes.Type, len(fields))
		for i, f := range fields {
			apiFields[i] = apitypes.Type{Name: f.Name, Type: f.Type}
		}
		td.Types[typeName] = apiFields
	}

	msgHash, _, err := apitypes.TypedDataAndHash(td)
	if err != nil {
		return [32]byte{}, fmt.Errorf("HashEIP712TypedData: %w", err)
	}
	var hash32 [32]byte
	copy(hash32[:], msgHash)
	return hash32, nil
}

// VerifyTypedDataStrict verifies an EIP-712 typed-data signature using the strict
// code-routed primitive. Replaces signer.VerifyTypedData in facilitator code paths
// where the on-chain verifier routes by code.length (Permit2, USDC v2.2, OZ SignatureChecker).
func VerifyTypedDataStrict(
	ctx context.Context,
	signer FacilitatorEvmSigner,
	address string,
	domain TypedDataDomain,
	types map[string][]TypedDataField,
	primaryType string,
	message map[string]interface{},
	signature []byte,
) (bool, error) {
	hash, err := HashEIP712TypedData(domain, types, primaryType, message)
	if err != nil {
		return false, err
	}
	return VerifySignatureStrict(ctx, signer, address, hash, signature)
}

// VerifyEOATypedData verifies an EIP-712 typed-data signature using pure ECDSA (no on-chain
// call). Use this for the payerAuthorizer path in batch-settlement where the on-chain contract
// also uses ECDSA.recoverCalldata — regardless of code presence at the address.
func VerifyEOATypedData(
	address string,
	domain TypedDataDomain,
	types map[string][]TypedDataField,
	primaryType string,
	message map[string]interface{},
	signature []byte,
) (bool, error) {
	hash, err := HashEIP712TypedData(domain, types, primaryType, message)
	if err != nil {
		return false, err
	}
	if len(signature) != 65 {
		return false, nil
	}
	v := signature[64]
	if v >= 27 {
		v -= 27
	}
	sig := make([]byte, 65)
	copy(sig, signature)
	sig[64] = v
	pub, err2 := crypto.SigToPub(hash[:], sig)
	if err2 != nil {
		return false, err2
	}
	recovered := crypto.PubkeyToAddress(*pub)
	return recovered == common.HexToAddress(address), nil
}
