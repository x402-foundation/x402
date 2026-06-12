package signinwithx

import "github.com/x402-foundation/x402/go/v2/extensions/types"

// BuildSchema returns the JSON Schema (Draft 2020-12) for the client proof
// payload, included in the extension declaration.
func BuildSchema() types.JSONSchema {
	str := map[string]interface{}{"type": "string"}
	uri := map[string]interface{}{"type": "string", "format": "uri"}
	dateTime := map[string]interface{}{"type": "string", "format": "date-time"}

	return types.JSONSchema{
		"$schema": "https://json-schema.org/draft/2020-12/schema",
		"type":    "object",
		"properties": map[string]interface{}{
			"domain":         str,
			"address":        str,
			"statement":      str,
			"uri":            uri,
			"version":        str,
			"chainId":        str,
			"type":           str,
			"nonce":          str,
			"issuedAt":       dateTime,
			"expirationTime": dateTime,
			"notBefore":      dateTime,
			"requestId":      str,
			"resources":      map[string]interface{}{"type": "array", "items": uri},
			"signature":      str,
		},
		"required": []string{
			"domain", "address", "uri", "version", "chainId", "type", "nonce", "issuedAt", "signature",
		},
	}
}
