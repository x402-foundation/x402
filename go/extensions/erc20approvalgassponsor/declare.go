package erc20approvalgassponsor

// DeclareExtension creates the extension declaration for inclusion in PaymentRequired.extensions.
//
// The server advertises that it (or its facilitator) supports ERC-20 approval gas sponsoring.
// The client will sign and attach the approve transaction data.
//
// Returns a map keyed by the extension identifier.
//
// Example:
//
//	extensions := erc20approvalgassponsor.DeclareExtension()
//	// Include in PaymentRequired.Extensions
func DeclareExtension() map[string]interface{} {
	return map[string]interface{}{
		ERC20ApprovalGasSponsoring.Key(): Extension{
			Info: ServerInfo{
				Description: "The facilitator accepts a pre-signed ERC-20 approve(Permit2, MaxUint256) transaction for tokens without EIP-2612.",
				Version:     ERC20ApprovalGasSponsoringVersion,
			},
			Schema: erc20ApprovalGasSponsoringSchema(),
		},
	}
}

// erc20ApprovalGasSponsoringSchema returns the JSON Schema for the extension info.
func erc20ApprovalGasSponsoringSchema() map[string]interface{} {
	return map[string]interface{}{
		"$schema": "https://json-schema.org/draft/2020-12/schema",
		"type":    "object",
		"properties": map[string]interface{}{
			"from": map[string]interface{}{
				"type":        "string",
				"pattern":     "^0x[a-fA-F0-9]{40}$",
				"description": "The address of the sender (token owner).",
			},
			"asset": map[string]interface{}{
				"type":        "string",
				"pattern":     "^0x[a-fA-F0-9]{40}$",
				"description": "The address of the ERC-20 token contract.",
			},
			"spender": map[string]interface{}{
				"type":        "string",
				"pattern":     "^0x[a-fA-F0-9]{40}$",
				"description": "The address being approved (Canonical Permit2).",
			},
			"amount": map[string]interface{}{
				"type":        "string",
				"pattern":     "^[0-9]+$",
				"description": "The approval amount (uint256 as decimal string). Typically MaxUint256.",
			},
			"signedTransaction": map[string]interface{}{
				"type":        "string",
				"pattern":     "^0x[a-fA-F0-9]+$",
				"description": "The RLP-encoded signed approve transaction as a hex string.",
			},
			"version": map[string]interface{}{
				"type":        "string",
				"pattern":     `^[0-9]+(\.[0-9]+)*$`,
				"description": "Schema version identifier.",
			},
		},
		"required": []string{
			"from", "asset", "spender", "amount", "signedTransaction", "version",
		},
	}
}
