package bazaar

import (
	"fmt"

	"github.com/x402-foundation/x402/go/extensions/types"
)

// DeclareDiscoveryExtension creates a discovery extension for any HTTP method
//
// This function helps servers declare how their endpoint should be called,
// including the expected input parameters/body and output format.
//
// Args:
//   - method: HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD)
//   - input: Example input data (query params for GET/HEAD/DELETE, body for POST/PUT/PATCH)
//   - inputSchema: JSON Schema for the input
//   - bodyType: Body type for POST/PUT/PATCH methods (optional, defaults to "json")
//   - output: Output configuration (optional)
//
// Returns:
//   - DiscoveryExtension with both info and schema
//
// Example:
//
//	// For a GET endpoint with query params
//	extension, err := bazaar.DeclareDiscoveryExtension(
//	    bazaar.MethodGET,
//	    map[string]interface{}{"query": "example"},
//	    bazaar.JSONSchema{
//	        "properties": map[string]interface{}{
//	            "query": map[string]interface{}{"type": "string"},
//	        },
//	        "required": []string{"query"},
//	    },
//	    "",
//	    nil,
//	)
//
//	// For a POST endpoint with JSON body
//	extension, err := bazaar.DeclareDiscoveryExtension(
//	    bazaar.MethodPOST,
//	    map[string]interface{}{"name": "John", "age": 30},
//	    bazaar.JSONSchema{
//	        "properties": map[string]interface{}{
//	            "name": map[string]interface{}{"type": "string"},
//	            "age": map[string]interface{}{"type": "number"},
//	        },
//	        "required": []string{"name"},
//	    },
//	    bazaar.BodyTypeJSON,
//	    &bazaar.OutputConfig{
//	        Example: map[string]interface{}{"success": true, "id": "123"},
//	    },
//	)
//
// DeclareDiscoveryExtensionOpts holds optional parameters for DeclareDiscoveryExtension.
type DeclareDiscoveryExtensionOpts struct {
	PathParamsSchema types.JSONSchema
}

func DeclareDiscoveryExtension(
	method interface{}, // QueryParamMethods or BodyMethods
	input interface{},
	inputSchema types.JSONSchema,
	bodyType types.BodyType,
	output *types.OutputConfig,
	opts ...DeclareDiscoveryExtensionOpts,
) (types.DiscoveryExtension, error) {
	var pathParamsSchema types.JSONSchema
	if len(opts) > 0 {
		pathParamsSchema = opts[0].PathParamsSchema
	}

	// Convert method to string
	var methodStr string
	switch m := method.(type) {
	case types.QueryParamMethods:
		methodStr = string(m)
	case types.BodyMethods:
		methodStr = string(m)
	case string:
		methodStr = m
	default:
		return types.DiscoveryExtension{}, fmt.Errorf("unsupported method type: %T", method)
	}

	if types.IsQueryMethod(methodStr) {
		return createQueryDiscoveryExtension(types.QueryParamMethods(methodStr), input, inputSchema, pathParamsSchema, output)
	} else if types.IsBodyMethod(methodStr) {
		if bodyType == "" {
			bodyType = types.BodyTypeJSON
		}
		return createBodyDiscoveryExtension(types.BodyMethods(methodStr), input, inputSchema, pathParamsSchema, bodyType, output)
	}

	return types.DiscoveryExtension{}, fmt.Errorf("unsupported HTTP method: %s", methodStr)
}

// createQueryDiscoveryExtension creates a query discovery extension
func createQueryDiscoveryExtension(
	method types.QueryParamMethods,
	input interface{},
	inputSchema types.JSONSchema,
	pathParamsSchema types.JSONSchema,
	output *types.OutputConfig,
) (types.DiscoveryExtension, error) {
	// Convert input to map if provided
	var queryParams map[string]interface{}
	if input != nil {
		if params, ok := input.(map[string]interface{}); ok {
			queryParams = params
		}
	}

	// Initialize inputSchema if nil
	if inputSchema == nil {
		inputSchema = types.JSONSchema{"properties": map[string]interface{}{}}
	}

	// Build the info
	queryInfo := types.QueryDiscoveryInfo{
		Input: types.QueryInput{
			Type:        "http",
			Method:      method,
			QueryParams: queryParams,
		},
	}

	if output != nil && output.Example != nil {
		queryInfo.Output = &types.OutputInfo{
			Type:    "json",
			Example: output.Example,
		}
	}

	// Build the schema
	schemaProperties := map[string]interface{}{
		"input": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"type": map[string]interface{}{
					"type":  "string",
					"const": "http",
				},
				"method": map[string]interface{}{
					"type": "string",
					"enum": []string{string(method)},
				},
			},
			"required": []string{"type", "method"},
			// pathParams and method are not declared here at schema build time —
			// the server extension's EnrichDeclaration adds them to both info and schema
			// atomically at request time, keeping data and schema consistent.
			"additionalProperties": false,
		},
	}

	// Add queryParams schema if provided
	if len(inputSchema) > 0 {
		inputProps := schemaProperties["input"].(map[string]interface{})
		props := inputProps["properties"].(map[string]interface{})
		props["queryParams"] = map[string]interface{}{
			"type": "object",
		}
		// Merge inputSchema into queryParams
		for k, v := range inputSchema {
			props["queryParams"].(map[string]interface{})[k] = v
		}
	}

	if len(pathParamsSchema) > 0 {
		inputProps := schemaProperties["input"].(map[string]interface{})
		props := inputProps["properties"].(map[string]interface{})
		pp := map[string]interface{}{"type": "object"}
		for k, v := range pathParamsSchema {
			pp[k] = v
		}
		props["pathParams"] = pp
	}

	// Add output schema if provided
	if output != nil && output.Example != nil {
		outputSchema := map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"type": map[string]interface{}{
					"type": "string",
				},
				"example": map[string]interface{}{
					"type": "object",
				},
			},
			"required": []string{"type"},
		}

		// Merge output schema if provided
		if output.Schema != nil {
			for k, v := range output.Schema {
				outputSchema["properties"].(map[string]interface{})["example"].(map[string]interface{})[k] = v
			}
		}

		schemaProperties["output"] = outputSchema
	}

	schema := types.JSONSchema{
		"$schema":    "https://json-schema.org/draft/2020-12/schema",
		"type":       "object",
		"properties": schemaProperties,
		"required":   []string{"input"},
	}

	return types.DiscoveryExtension{
		Info: types.DiscoveryInfo{
			Input:  queryInfo.Input,
			Output: queryInfo.Output,
		},
		Schema: schema,
	}, nil
}

// createBodyDiscoveryExtension creates a body discovery extension
func createBodyDiscoveryExtension(
	method types.BodyMethods,
	input interface{},
	inputSchema types.JSONSchema,
	pathParamsSchema types.JSONSchema,
	bodyType types.BodyType,
	output *types.OutputConfig,
) (types.DiscoveryExtension, error) {
	// Initialize inputSchema if nil
	if inputSchema == nil {
		inputSchema = types.JSONSchema{"properties": map[string]interface{}{}}
	}

	// Build the info
	bodyInfo := types.BodyDiscoveryInfo{
		Input: types.BodyInput{
			Type:     "http",
			Method:   method,
			BodyType: bodyType,
			Body:     input,
		},
	}

	if output != nil && output.Example != nil {
		bodyInfo.Output = &types.OutputInfo{
			Type:    "json",
			Example: output.Example,
		}
	}

	// Build the schema
	schemaProperties := map[string]interface{}{
		"input": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"type": map[string]interface{}{
					"type":  "string",
					"const": "http",
				},
				"method": map[string]interface{}{
					"type": "string",
					"enum": []string{string(method)},
				},
				"bodyType": map[string]interface{}{
					"type": "string",
					"enum": []string{"json", "form-data", "text"},
				},
				"body": inputSchema,
			},
			"required": []string{"type", "method", "bodyType", "body"},
			// pathParams and method are not declared here at schema build time —
			// the server extension's EnrichDeclaration adds them to both info and schema
			// atomically at request time, keeping data and schema consistent.
			"additionalProperties": false,
		},
	}

	if len(pathParamsSchema) > 0 {
		inputProps := schemaProperties["input"].(map[string]interface{})
		props := inputProps["properties"].(map[string]interface{})
		pp := map[string]interface{}{"type": "object"}
		for k, v := range pathParamsSchema {
			pp[k] = v
		}
		props["pathParams"] = pp
	}

	// Add output schema if provided
	if output != nil && output.Example != nil {
		outputSchema := map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"type": map[string]interface{}{
					"type": "string",
				},
				"example": map[string]interface{}{
					"type": "object",
				},
			},
			"required": []string{"type"},
		}

		// Merge output schema if provided
		if output.Schema != nil {
			for k, v := range output.Schema {
				outputSchema["properties"].(map[string]interface{})["example"].(map[string]interface{})[k] = v
			}
		}

		schemaProperties["output"] = outputSchema
	}

	schema := types.JSONSchema{
		"$schema":    "https://json-schema.org/draft/2020-12/schema",
		"type":       "object",
		"properties": schemaProperties,
		"required":   []string{"input"},
	}

	return types.DiscoveryExtension{
		Info: types.DiscoveryInfo{
			Input:  bodyInfo.Input,
			Output: bodyInfo.Output,
		},
		Schema: schema,
	}, nil
}
