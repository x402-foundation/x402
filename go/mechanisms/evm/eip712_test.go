package evm

import (
	"math/big"
	"testing"
)

// TestHashTypedData_Permit2NoVersionDomain is a regression test for the EIP-712
// domain hashing bug where the auto-injected EIP712Domain type unconditionally
// declared `version: string`. Permit2's domain has no version, so the typed-data
// domain map omits "version", and HashStruct then fails with:
//
//	"provided data '<nil>' doesn't match type 'string'"
//
// This propagates as `invalid_batch_settlement_evm_permit2_invalid_signature`
// on the facilitator and breaks every Permit2-based batch-settlement flow. The fix
// dynamically constructs the EIP712Domain type list from which domain fields
// are actually populated, matching viem's behavior.
func TestHashTypedData_Permit2NoVersionDomain(t *testing.T) {
	domain := TypedDataDomain{
		Name:              "Permit2",
		ChainID:           big.NewInt(84532),
		VerifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
	}
	types := map[string][]TypedDataField{
		"PermitWitnessTransferFrom": {
			{Name: "permitted", Type: "TokenPermissions"},
			{Name: "spender", Type: "address"},
			{Name: "nonce", Type: "uint256"},
			{Name: "deadline", Type: "uint256"},
			{Name: "witness", Type: "Witness"},
		},
		"TokenPermissions": {
			{Name: "token", Type: "address"},
			{Name: "amount", Type: "uint256"},
		},
		"Witness": {
			{Name: "channelId", Type: "bytes32"},
		},
	}
	channelId := make([]byte, 32)
	channelId[31] = 0x01
	message := map[string]interface{}{
		"permitted": map[string]interface{}{
			"token":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			"amount": big.NewInt(1_000_000),
		},
		"spender":  "0x0000000000000000000000000000000000000001",
		"nonce":    big.NewInt(1),
		"deadline": big.NewInt(1_000_000_000_000),
		"witness": map[string]interface{}{
			"channelId": channelId,
		},
	}

	digest, err := HashTypedData(domain, types, "PermitWitnessTransferFrom", message)
	if err != nil {
		t.Fatalf("HashTypedData with no-version domain failed: %v", err)
	}
	if len(digest) != 32 {
		t.Fatalf("expected 32-byte digest, got %d bytes", len(digest))
	}
}

// TestHashTypedData_FullDomainStillHashes makes sure the dynamic EIP712Domain
// generation didn't regress the standard EIP-3009 case (name + version + chainId
// + verifyingContract).
func TestHashTypedData_FullDomainStillHashes(t *testing.T) {
	domain := TypedDataDomain{
		Name:              "USD Coin",
		Version:           "2",
		ChainID:           big.NewInt(84532),
		VerifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
	}
	types := map[string][]TypedDataField{
		"TransferWithAuthorization": {
			{Name: "from", Type: "address"},
			{Name: "to", Type: "address"},
			{Name: "value", Type: "uint256"},
			{Name: "validAfter", Type: "uint256"},
			{Name: "validBefore", Type: "uint256"},
			{Name: "nonce", Type: "bytes32"},
		},
	}
	nonce := make([]byte, 32)
	nonce[0] = 0xab
	message := map[string]interface{}{
		"from":        "0x0000000000000000000000000000000000000001",
		"to":          "0x0000000000000000000000000000000000000002",
		"value":       big.NewInt(1_000_000),
		"validAfter":  big.NewInt(0),
		"validBefore": big.NewInt(1_000_000_000_000),
		"nonce":       nonce,
	}

	digest, err := HashTypedData(domain, types, "TransferWithAuthorization", message)
	if err != nil {
		t.Fatalf("HashTypedData with full domain failed: %v", err)
	}
	if len(digest) != 32 {
		t.Fatalf("expected 32-byte digest, got %d", len(digest))
	}
}
