package eip2612gassponsor

// DeclareEip2612GasSponsoringExtension creates the extension declaration
// for inclusion in PaymentRequired.extensions.
//
// The server advertises that it (or its facilitator) supports EIP-2612
// gasless Permit2 approval. The client will populate the info with the
// actual permit signature data.
//
// Returns a map keyed by the extension identifier.
//
// Example:
//
//	extensions := eip2612gassponsor.DeclareEip2612GasSponsoringExtension()
//	// Include in PaymentRequired.Extensions
func DeclareEip2612GasSponsoringExtension() map[string]interface{} {
	return map[string]interface{}{
		EIP2612GasSponsoring.Key(): Extension{
			Info: ServerInfo{
				Description: "The facilitator accepts EIP-2612 gasless Permit to `Permit2` canonical contract.",
				Version:     "1",
			},
			Schema: eip2612GasSponsoringSchema(),
		},
	}
}

// eip2612GasSponsoringSchema returns the JSON Schema for the extension info.
func eip2612GasSponsoringSchema() map[string]interface{} {
	return map[string]interface{}{
		"$schema": "https://json-schema.org/draft/2020-12/schema",
		"type":    "object",
		"properties": map[string]interface{}{
			"from": map[string]interface{}{
				"type":        "string",
				"pattern":     "^0x[a-fA-F0-9]{40}$",
				"description": "The address of the sender.",
			},
			"asset": map[string]interface{}{
				"type":        "string",
				"pattern":     "^0x[a-fA-F0-9]{40}$",
				"description": "The address of the ERC-20 token contract.",
			},
			"spender": map[string]interface{}{
				"type":        "string",
				"pattern":     "^0x[a-fA-F0-9]{40}$",
				"description": "The address of the spender (Canonical Permit2).",
			},
			"amount": map[string]interface{}{
				"type":        "string",
				"pattern":     "^[0-9]+$",
				"description": "The amount to approve (uint256). Typically MaxUint.",
			},
			"nonce": map[string]interface{}{
				"type":        "string",
				"pattern":     "^[0-9]+$",
				"description": "The current nonce of the sender.",
			},
			"deadline": map[string]interface{}{
				"type":        "string",
				"pattern":     "^[0-9]+$",
				"description": "The timestamp at which the signature expires.",
			},
			"signature": map[string]interface{}{
				"type":        "string",
				"pattern":     "^0x[a-fA-F0-9]+$",
				"description": "The 65-byte concatenated signature (r, s, v) as a hex string.",
			},
			"version": map[string]interface{}{
				"type":        "string",
				"pattern":     `^[0-9]+(\.[0-9]+)*$`,
				"description": "Schema version identifier.",
			},
		},
		"required": []string{
			"from", "asset", "spender", "amount", "nonce", "deadline", "signature", "version",
		},
	}
}
