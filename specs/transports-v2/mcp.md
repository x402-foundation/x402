# Transport: MCP (Model Context Protocol)

## Summary

The MCP transport implements x402 payment flows over the Model Context Protocol. This enables AI agents and MCP clients to seamlessly pay for tools and resources.

## Payment Flow Overview

1. Client calls a paid tool without payment
2. Server returns a tool result with `isError: true` and `PaymentRequired` data
3. Client extracts payment requirements and creates a `PaymentPayload`
4. Client retries the tool call with payment in `_meta["x402/payment"]`
5. Server verifies payment, executes tool, settles payment
6. Server returns tool result with settlement info in `_meta["x402/payment-response"]`

## Payment Required Signaling

When a tool requires payment, servers MUST return a tool result with `isError: true` containing the `PaymentRequired` data.

**Mechanism**: Tool result with `isError: true`, `structuredContent`, and `content` fields  
**Data Format**: `PaymentRequired` schema

### Server Requirements

Servers MUST provide the `PaymentRequired` in both formats:

1. **`structuredContent`** (REQUIRED): Direct `PaymentRequired` object
2. **`content[0].text`** (REQUIRED): JSON-encoded string of the same `PaymentRequired` object

Both fields contain identical data - `content[0].text` is simply `JSON.stringify(structuredContent)` for clients that cannot access structured content.

**Response Format:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "isError": true,
    "structuredContent": {
      "x402Version": 2,
      "error": "Payment required to access this resource",
      "resource": {
        "url": "mcp://tool/financial_analysis",
        "description": "Advanced financial analysis tool",
        "mimeType": "application/json"
      },
      "accepts": [
        {
          "scheme": "exact",
          "network": "eip155:84532",
          "amount": "10000",
          "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
          "maxTimeoutSeconds": 60,
          "extra": {
            "name": "USDC",
            "version": "2"
          }
        }
      ]
    },
    "content": [
      {
        "type": "text",
        "text": "{\"x402Version\":2,\"error\":\"Payment required to access this resource\",\"resource\":{\"url\":\"mcp://tool/financial_analysis\",\"description\":\"Advanced financial analysis tool\",\"mimeType\":\"application/json\"},\"accepts\":[{\"scheme\":\"exact\",\"network\":\"eip155:84532\",\"amount\":\"10000\",\"asset\":\"0x036CbD53842c5426634e7929541eC2318f3dCF7e\",\"payTo\":\"0x209693Bc6afc0C5328bA36FaF03C514EF312287C\",\"maxTimeoutSeconds\":60,\"extra\":{\"name\":\"USDC\",\"version\":\"2\"}}]}"
      }
    ]
  }
}
```

### Client Requirements

Clients SHOULD prefer `structuredContent` when available, falling back to parsing `content[0].text`:

1. Check if `result.structuredContent` exists and contains `x402Version` and `accepts` fields
2. If not, parse `result.content[0].text` as JSON and check for the same fields

## Payment Payload Transmission

Clients send payment data using the MCP `_meta` field with key `x402/payment`.

**Mechanism**: `_meta["x402/payment"]` field in request parameters
**Data Format**: `PaymentPayload` schema

**Example (Tool Call with Payment):**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "financial_analysis",
    "arguments": {
      "ticker": "AAPL",
      "analysis_type": "deep"
    },
    "_meta": {
      "x402/payment": {
        "x402Version": 2,
        "resource": {
          "url": "mcp://tool/financial_analysis",
          "description": "Advanced financial analysis tool",
          "mimeType": "application/json"
        },
        "accepted": {
          "scheme": "exact",
          "network": "eip155:84532",
          "amount": "10000",
          "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
          "maxTimeoutSeconds": 60,
          "extra": {
            "name": "USDC",
            "version": "2"
          }
        },
        "payload": {
          "signature": "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
          "authorization": {
            "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
            "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
            "value": "10000",
            "validAfter": "1740672089",
            "validBefore": "1740672154",
            "nonce": "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480"
          }
        }
      }
    }
  }
}
```

## Settlement Response Delivery

Servers communicate payment settlement results using the `_meta["x402/payment-response"]` field.

**Mechanism**: `_meta["x402/payment-response"]` field in response result
**Data Format**: `SettlementResponse` schema

### Successful Settlement

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Financial analysis for AAPL: Strong fundamentals with positive outlook..."
      }
    ],
    "_meta": {
      "x402/payment-response": {
        "success": true,
        "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        "network": "eip155:84532",
        "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
      }
    }
  }
}
```

### Settlement Failure

When payment settlement fails, servers return a tool result with `isError: true`. The response follows the same format as Payment Required Signaling. If settlement fails after the tool has already executed, the server should not return the tool's content - only the payment error.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "isError": true,
    "structuredContent": {
      "x402Version": 2,
      "error": "Settlement failed",
      "resource": {
        "url": "mcp://tool/financial_analysis",
        "description": "Advanced financial analysis tool",
        "mimeType": "application/json"
      },
      "accepts": [
        {
          "scheme": "exact",
          "network": "eip155:84532",
          "amount": "10000",
          "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
          "maxTimeoutSeconds": 60,
          "extra": {
            "name": "USDC",
            "version": "2"
          }
        }
      ]
    },
    "content": [
      {
        "type": "text",
        "text": "{\"x402Version\":2,\"error\":\"Settlement failed\",\"resource\":{\"url\":\"mcp://tool/financial_analysis\",\"description\":\"Advanced financial analysis tool\",\"mimeType\":\"application/json\"},\"accepts\":[...]}"
      }
    ]
  }
}
```

## Error Handling

| Error Type | Response | Description |
|------------|----------|-------------|
| Payment Required | Tool result with `isError: true` | No payment provided, returns `PaymentRequired` |
| Payment Invalid | Tool result with `isError: true` | Payment verification failed, returns `PaymentRequired` with reason |
| Settlement Failed | Tool result with `isError: true` | Settlement failed after execution, returns failure details |

## References

- [Core x402 Specification](../x402-specification-v2.md)
- [MCP Specification](https://modelcontextprotocol.io/specification/)
- [MCP \_meta Field Documentation](https://modelcontextprotocol.io/specification/2025-06-18/basic#meta)
- [agents/x402-mcp](https://github.com/cloudflare/agents/blob/main/packages/agents/src/mcp/x402.ts)