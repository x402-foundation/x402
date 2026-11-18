package buildercode

import "fmt"

// BUILDER_CODE_SCHEMA is the JSON Schema advertised alongside the app code in
// PaymentRequired.extensions.
var BUILDER_CODE_SCHEMA = map[string]interface{}{
	"$schema": "https://json-schema.org/draft/2020-12/schema",
	"type":    "object",
	"properties": map[string]interface{}{
		"a": map[string]interface{}{
			"type":        "string",
			"pattern":     "^[a-z0-9_]{1,32}$",
			"description": "App builder code",
		},
		"w": map[string]interface{}{
			"type":        "string",
			"pattern":     "^[a-z0-9_]{1,32}$",
			"description": "Wallet builder code",
		},
		"s": map[string]interface{}{
			"type":     "array",
			"maxItems": MAX_SERVICE_CODES,
			"items": map[string]interface{}{
				"type":    "string",
				"pattern": "^[a-z0-9_]{1,32}$",
			},
			"description": "Service builder codes",
		},
	},
	"additionalProperties": false,
}

// DeclareBuilderCodeExtension declares the builder-code extension for inclusion
// in PaymentRequired.extensions, advertising the service's app code and,
// optionally, up to MAX_SERVER_SERVICE_CODES service code(s) (e.g. attribution
// for a server-side SDK the service depends on). Client-provided service codes
// are merged with these by the core client, client entries first.
//
// It panics when appCode or any serviceCode is not a valid builder code (1-32
// lowercase alphanumeric and underscore characters)
func DeclareBuilderCodeExtension(appCode string, serviceCodes ...string) map[string]interface{} {
	if !validateCode(appCode) {
		panic(fmt.Sprintf("invalid builder code: %q. Must be 1-32 characters, lowercase alphanumeric and underscores only.", appCode))
	}

	info := map[string]interface{}{"a": appCode}
	if len(serviceCodes) > 0 {
		if len(serviceCodes) > MAX_SERVER_SERVICE_CODES {
			panic(fmt.Sprintf("too many service codes: %d exceeds the maximum of %d", len(serviceCodes), MAX_SERVER_SERVICE_CODES))
		}
		for _, code := range serviceCodes {
			if !validateCode(code) {
				panic(fmt.Sprintf("invalid builder code: %q. Must be 1-32 characters, lowercase alphanumeric and underscores only.", code))
			}
		}
		info["s"] = serviceCodes
	}

	return map[string]interface{}{
		BUILDER_CODE: map[string]interface{}{
			"info":   info,
			"schema": BUILDER_CODE_SCHEMA,
		},
	}
}
