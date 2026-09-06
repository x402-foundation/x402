package signinwithx

// Schema returns the JSON Schema for validating SIWX client payloads.
func Schema() map[string]interface{} {
	return map[string]interface{}{
		"$schema": "https://json-schema.org/draft/2020-12/schema",
		"type":    "object",
		"properties": map[string]interface{}{
			"domain": map[string]interface{}{
				"type": "string",
			},
			"address": map[string]interface{}{
				"type": "string",
			},
			"statement": map[string]interface{}{
				"type": "string",
			},
			"uri": map[string]interface{}{
				"type":   "string",
				"format": "uri",
			},
			"version": map[string]interface{}{
				"type": "string",
			},
			"chainId": map[string]interface{}{
				"type": "string",
			},
			"type": map[string]interface{}{
				"type": "string",
			},
			"nonce": map[string]interface{}{
				"type": "string",
			},
			"issuedAt": map[string]interface{}{
				"type":   "string",
				"format": "date-time",
			},
			"expirationTime": map[string]interface{}{
				"type":   "string",
				"format": "date-time",
			},
			"notBefore": map[string]interface{}{
				"type":   "string",
				"format": "date-time",
			},
			"requestId": map[string]interface{}{
				"type": "string",
			},
			"resources": map[string]interface{}{
				"type": "array",
				"items": map[string]interface{}{
					"type":   "string",
					"format": "uri",
				},
			},
			"signature": map[string]interface{}{
				"type": "string",
			},
		},
		"required": []string{
			"domain",
			"address",
			"uri",
			"version",
			"chainId",
			"type",
			"nonce",
			"issuedAt",
			"signature",
		},
	}
}
