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
			"maxItems": 5,
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
// in PaymentRequired.extensions, advertising the service's app code.
//
// It panics when appCode is not a valid builder code (1-32 lowercase
// alphanumeric and underscore characters)
func DeclareBuilderCodeExtension(appCode string) map[string]interface{} {
	if !validateCode(appCode) {
		panic(fmt.Sprintf("invalid builder code: %q. Must be 1-32 characters, lowercase alphanumeric and underscores only.", appCode))
	}

	return map[string]interface{}{
		BUILDER_CODE: map[string]interface{}{
			"info":   map[string]interface{}{"a": appCode},
			"schema": BUILDER_CODE_SCHEMA,
		},
	}
}
