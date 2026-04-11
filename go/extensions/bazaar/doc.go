/*
Package bazaar provides the Bazaar Discovery Extension for x402 v2 and v1.

Enables facilitators to automatically catalog and index x402-enabled resources
by following the server's provided discovery instructions.

# V2 Usage

The v2 extension follows a pattern where:
  - `info`: Contains the actual discovery data (the values)
  - `schema`: JSON Schema that validates the structure of `info`

# For Resource Servers (V2)

	import "github.com/x402-foundation/x402/go/extensions/bazaar"

	// Declare a GET endpoint
	extension, err := bazaar.DeclareDiscoveryExtension(
		bazaar.MethodGET,
		map[string]interface{}{"query": "example"},
		bazaar.JSONSchema{
			"properties": map[string]interface{}{
				"query": map[string]interface{}{"type": "string"},
			},
			"required": []string{"query"},
		},
		"",
		nil,
	)

	// Include in PaymentRequired response
	paymentRequired := x402.PaymentRequired{
		X402Version: 2,
		Resource: x402.Resource{...},
		Accepts: []x402.PaymentRequirements{...},
		Extensions: map[string]interface{}{
			bazaar.BAZAAR.Key(): extension,
		},
	}

# For MCP Tool Servers (V2)

	import "github.com/x402-foundation/x402/go/extensions/bazaar"

	// Declare an MCP tool
	extension, err := bazaar.DeclareMcpDiscoveryExtension(bazaar.DeclareMcpDiscoveryConfig{
		ToolName:    "weather_lookup",
		Description: "Look up weather for a city",
		Transport:   bazaar.TransportStreamableHTTP,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"city": map[string]interface{}{"type": "string"},
			},
			"required": []string{"city"},
		},
		Example: map[string]interface{}{"city": "San Francisco"},
	})

	// Include in PaymentRequired response
	paymentRequired := x402.PaymentRequired{
		X402Version: 2,
		Resource: x402.Resource{...},
		Accepts: []x402.PaymentRequirements{...},
		Extensions: map[string]interface{}{
			bazaar.BAZAAR.Key(): extension,
		},
	}

# For Facilitators (V2 and V1)

	import "github.com/x402-foundation/x402/go/extensions/bazaar"

	// Extract from client's PaymentPayload (facilitator hook context)
	// V2: Extensions are in PaymentPayload.Extensions (client copied from PaymentRequired)
	// V1: Discovery info is in PaymentRequirements.OutputSchema
	discovered, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(
		payloadBytes,
		requirementsBytes,
		true, // validate
	)

	if discovered != nil {
		// Catalog discovered resource in Bazaar
	}

# For Clients (Processing 402 Responses)

	import "github.com/x402-foundation/x402/go/extensions/bazaar"

	// Extract from server's 402 PaymentRequired response
	// V2: Checks PaymentRequired.Extensions, falls back to Accepts[0]
	// V1: Checks Accepts[0].OutputSchema
	discovered, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(
		paymentRequiredBytes,
		true, // validate
	)

	if discovered != nil {
		// Use discovered resource to build UI or automate calls
	}

# V1 Support

V1 discovery information is stored in the `outputSchema` field of PaymentRequirements.
Both extraction functions automatically handle v1 format.

	import v1 "github.com/x402-foundation/x402/go/extensions/bazaar/v1"

	// Direct v1 extraction (for advanced use cases)
	infoV1, err := v1.ExtractDiscoveryInfoV1(paymentRequirementsV1)
*/
package bazaar
