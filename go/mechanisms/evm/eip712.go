package evm

import (
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// HashTypedData hashes EIP-712 typed data according to the specification
//
// This function creates the EIP-712 hash that should be signed or verified.
// The hash is computed as: keccak256("\x19\x01" + domainSeparator + structHash)
//
// Args:
//
//	domain: The EIP-712 domain separator parameters
//	types: The type definitions for the structured data
//	primaryType: The name of the primary type being hashed
//	message: The message data to hash
//
// Returns:
//
//	32-byte hash suitable for signing or verification
//	error if hashing fails
func HashTypedData(
	domain TypedDataDomain,
	types map[string][]TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	// Convert our types to apitypes format for hashing
	typedData := apitypes.TypedData{
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

	// Convert field types
	for typeName, fields := range types {
		typedFields := make([]apitypes.Type, len(fields))
		for i, field := range fields {
			typedFields[i] = apitypes.Type{
				Name: field.Name,
				Type: field.Type,
			}
		}
		typedData.Types[typeName] = typedFields
	}

	// Add EIP712Domain type if not present
	if _, exists := typedData.Types["EIP712Domain"]; !exists {
		typedData.Types["EIP712Domain"] = []apitypes.Type{
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		}
	}

	// Hash the struct data
	dataHash, err := typedData.HashStruct(typedData.PrimaryType, typedData.Message)
	if err != nil {
		return nil, fmt.Errorf("failed to hash struct: %w", err)
	}

	// Hash the domain
	domainSeparator, err := typedData.HashStruct("EIP712Domain", typedData.Domain.Map())
	if err != nil {
		return nil, fmt.Errorf("failed to hash domain: %w", err)
	}

	// Create EIP-712 digest: 0x19 0x01 <domainSeparator> <dataHash>
	rawData := []byte{0x19, 0x01}
	rawData = append(rawData, domainSeparator...)
	rawData = append(rawData, dataHash...)
	digest := crypto.Keccak256(rawData)

	return digest, nil
}

// HashEIP3009Authorization hashes a TransferWithAuthorization message for EIP-3009
//
// This is a convenience function that wraps HashTypedData with the specific
// types and structure used by EIP-3009's transferWithAuthorization.
//
// Args:
//
//	authorization: The EIP-3009 authorization data
//	chainID: The chain ID for the EIP-712 domain
//	verifyingContract: The token contract address
//	tokenName: The token name (e.g., "USD Coin")
//	tokenVersion: The token version (e.g., "2")
//
// Returns:
//
//	32-byte hash suitable for signing or verification
//	error if hashing fails
func HashEIP3009Authorization(
	authorization ExactEIP3009Authorization,
	chainID *big.Int,
	verifyingContract string,
	tokenName string,
	tokenVersion string,
) ([]byte, error) {
	// Create EIP-712 domain
	domain := TypedDataDomain{
		Name:              tokenName,
		Version:           tokenVersion,
		ChainID:           chainID,
		VerifyingContract: verifyingContract,
	}

	// Define EIP-712 types
	types := map[string][]TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"TransferWithAuthorization": {
			{Name: "from", Type: "address"},
			{Name: "to", Type: "address"},
			{Name: "value", Type: "uint256"},
			{Name: "validAfter", Type: "uint256"},
			{Name: "validBefore", Type: "uint256"},
			{Name: "nonce", Type: "bytes32"},
		},
	}

	// Parse values for message
	value, ok := new(big.Int).SetString(authorization.Value, 10)
	if !ok {
		return nil, fmt.Errorf("invalid authorization value: %s", authorization.Value)
	}
	validAfter, ok := new(big.Int).SetString(authorization.ValidAfter, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validAfter: %s", authorization.ValidAfter)
	}
	validBefore, ok := new(big.Int).SetString(authorization.ValidBefore, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validBefore: %s", authorization.ValidBefore)
	}
	nonceBytes, err := HexToBytes(authorization.Nonce)
	if err != nil {
		return nil, fmt.Errorf("invalid nonce: %w", err)
	}

	// Ensure addresses are checksummed
	from := common.HexToAddress(authorization.From).Hex()
	to := common.HexToAddress(authorization.To).Hex()

	// Create message
	message := map[string]interface{}{
		"from":        from,
		"to":          to,
		"value":       value,
		"validAfter":  validAfter,
		"validBefore": validBefore,
		"nonce":       nonceBytes,
	}

	return HashTypedData(domain, types, "TransferWithAuthorization", message)
}

// BuildUptoPermit2WitnessMap returns the witness map for upto EIP-712 message construction.
// Includes the facilitator field absent from the exact witness.
func BuildUptoPermit2WitnessMap(to string, facilitator string, validAfter *big.Int) map[string]interface{} {
	return map[string]interface{}{
		"to":          to,
		"facilitator": facilitator,
		"validAfter":  validAfter,
	}
}

// HashUptoPermit2Authorization hashes a PermitWitnessTransferFrom message for the upto Permit2 scheme.
// Uses upto-specific witness types that include the facilitator address.
func HashUptoPermit2Authorization(
	authorization UptoPermit2Authorization,
	chainID *big.Int,
) ([]byte, error) {
	domain := TypedDataDomain{
		Name:              "Permit2",
		ChainID:           chainID,
		VerifyingContract: PERMIT2Address,
	}

	types := GetUptoPermit2EIP712Types()

	amount, ok := new(big.Int).SetString(authorization.Permitted.Amount, 10)
	if !ok {
		return nil, fmt.Errorf("invalid permitted amount: %s", authorization.Permitted.Amount)
	}
	nonce, ok := new(big.Int).SetString(authorization.Nonce, 10)
	if !ok {
		return nil, fmt.Errorf("invalid nonce: %s", authorization.Nonce)
	}
	deadline, ok := new(big.Int).SetString(authorization.Deadline, 10)
	if !ok {
		return nil, fmt.Errorf("invalid deadline: %s", authorization.Deadline)
	}
	validAfter, ok := new(big.Int).SetString(authorization.Witness.ValidAfter, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validAfter: %s", authorization.Witness.ValidAfter)
	}

	token := common.HexToAddress(authorization.Permitted.Token).Hex()
	spender := common.HexToAddress(authorization.Spender).Hex()
	to := common.HexToAddress(authorization.Witness.To).Hex()
	facilitator := common.HexToAddress(authorization.Witness.Facilitator).Hex()

	message := map[string]interface{}{
		"permitted": map[string]interface{}{
			"token":  token,
			"amount": amount,
		},
		"spender":  spender,
		"nonce":    nonce,
		"deadline": deadline,
		"witness":  BuildUptoPermit2WitnessMap(to, facilitator, validAfter),
	}

	return HashTypedData(domain, types, "PermitWitnessTransferFrom", message)
}

// BuildPermit2WitnessMap returns the witness map used in EIP-712 message construction.
// Centralizing this ensures eip712.go and exact/client/permit2.go stay in sync when
// the witness struct changes.
func BuildPermit2WitnessMap(to string, validAfter *big.Int) map[string]interface{} {
	return map[string]interface{}{
		"to":         to,
		"validAfter": validAfter,
	}
}

// HashPermit2Authorization hashes a PermitWitnessTransferFrom message for Permit2.
//
// This function creates the EIP-712 hash for Permit2's PermitWitnessTransferFrom
// with the x402 witness structure.
//
// Args:
//
//	authorization: The Permit2 authorization data
//	chainID: The chain ID for the EIP-712 domain
//
// Returns:
//
//	32-byte hash suitable for signing or verification
//	error if hashing fails
func HashPermit2Authorization(
	authorization Permit2Authorization,
	chainID *big.Int,
) ([]byte, error) {
	// Create EIP-712 domain (Permit2 uses fixed name, no version)
	domain := TypedDataDomain{
		Name:              "Permit2",
		ChainID:           chainID,
		VerifyingContract: PERMIT2Address,
	}

	// Use shared EIP-712 types to ensure consistency
	types := GetPermit2EIP712Types()

	// Parse values for message
	amount, ok := new(big.Int).SetString(authorization.Permitted.Amount, 10)
	if !ok {
		return nil, fmt.Errorf("invalid permitted amount: %s", authorization.Permitted.Amount)
	}
	nonce, ok := new(big.Int).SetString(authorization.Nonce, 10)
	if !ok {
		return nil, fmt.Errorf("invalid nonce: %s", authorization.Nonce)
	}
	deadline, ok := new(big.Int).SetString(authorization.Deadline, 10)
	if !ok {
		return nil, fmt.Errorf("invalid deadline: %s", authorization.Deadline)
	}
	validAfter, ok := new(big.Int).SetString(authorization.Witness.ValidAfter, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validAfter: %s", authorization.Witness.ValidAfter)
	}

	// Ensure addresses are checksummed
	token := common.HexToAddress(authorization.Permitted.Token).Hex()
	spender := common.HexToAddress(authorization.Spender).Hex()
	to := common.HexToAddress(authorization.Witness.To).Hex()

	// Create message with nested structs
	message := map[string]interface{}{
		"permitted": map[string]interface{}{
			"token":  token,
			"amount": amount,
		},
		"spender":  spender,
		"nonce":    nonce,
		"deadline": deadline,
		"witness":  BuildPermit2WitnessMap(to, validAfter),
	}

	return HashTypedData(domain, types, "PermitWitnessTransferFrom", message)
}
