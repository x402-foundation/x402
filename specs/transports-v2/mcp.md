# Transport: MCP (Model Context Protocol)

## Summary

This document defines two concurrent bindings for x402 payment flows over the Model Context Protocol (MCP):

- The **tool-result binding** represents payment requirements as an MCP tool execution error. It works on MCP revisions that provide `isError`, `structuredContent`, `content`, and `_meta`, including MCP `2026-07-28`.
- The **extension binding** uses the capability-negotiated `org.x402/payment` extension and an extension-defined `payment_required` result type. It requires MCP `2026-07-28` or later.

A dual-mode server can expose both bindings from the same endpoint. Servers and clients SHOULD prefer the extension binding when the client advertises support as the tool-result binding is planned to be deprecated in a future x402 version.

## Binding Selection

A client that can process the extension binding MUST advertise `org.x402/payment` in its per-request MCP client capabilities.

| Condition                                                            | Binding for payment-required responses | Response                                                                            |
| -------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| The request advertises `org.x402/payment` and the server supports it | Extension                              | `resultType: "payment_required"` with `result.paymentRequired`                      |
| Otherwise                                                            | Tool-result                            | `isError: true` with `PaymentRequired` in `structuredContent` and `content[0].text` |

A server MUST NOT return `payment_required` unless the request advertises `org.x402/payment`. When both parties support the extension and a payment-required response is needed, the server MUST use the extension binding.

Both bindings use the same metadata fields for the rest of the payment flow:

- The client sends `PaymentPayload` in `params._meta["x402/payment"]`.
- The server sends `SettlementResponse` in `result._meta["x402/payment-response"]`.

For MCP revisions before `2026-07-28`, only the tool-result binding is available. On MCP `2026-07-28`, a tool-result response MUST include `resultType: "complete"`; clients receiving results from earlier MCP revisions treat an absent `resultType` as `complete`.

## Tool-Result Binding

The tool-result binding uses `isError`, `structuredContent`, `content`, and the `x402/payment` and `x402/payment-response` metadata keys. The examples in this section omit revision-specific MCP envelope fields. Implementations using MCP `2026-07-28` MUST add `resultType: "complete"` to each result.

### Payment Flow Overview

1. Client calls a paid tool without payment
2. Server returns a tool result with `isError: true` and `PaymentRequired` data
3. Client extracts payment requirements and creates a `PaymentPayload`
4. Client retries the tool call with payment in `_meta["x402/payment"]`
5. Server verifies payment, executes tool, settles payment
6. Server returns tool result with settlement info in `_meta["x402/payment-response"]`

### Payment Required Signaling

When a tool requires payment, servers MUST return a tool result with `isError: true` containing the `PaymentRequired` data.

**Mechanism**: Tool result with `isError: true`, `structuredContent`, and `content` fields
**Data Format**: `PaymentRequired` schema

#### Server Requirements

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

#### Client Requirements

Clients SHOULD prefer `structuredContent` when available, falling back to parsing `content[0].text`:

1. Check if `result.structuredContent` exists and contains `x402Version` and `accepts` fields
2. If not, parse `result.content[0].text` as JSON and check for the same fields

### Payment Payload Transmission

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

### Settlement Response Delivery

Servers communicate payment settlement results using the `_meta["x402/payment-response"]` field.

**Mechanism**: `_meta["x402/payment-response"]` field in response result
**Data Format**: `SettlementResponse` schema

#### Successful Settlement

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

#### Settlement Failure

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

### Error Handling

| Error Type        | Response                         | Description                                                        |
| ----------------- | -------------------------------- | ------------------------------------------------------------------ |
| Payment Required  | Tool result with `isError: true` | No payment provided, returns `PaymentRequired`                     |
| Payment Invalid   | Tool result with `isError: true` | Payment verification failed, returns `PaymentRequired` with reason |
| Settlement Failed | Tool result with `isError: true` | Settlement failed after execution, returns failure details         |

## Extension Binding

The `org.x402/payment` extension binding is experimental and is not an official MCP extension. It requires MCP `2026-07-28` or later and carries x402 v2 `PaymentRequired`, `PaymentPayload`, and `SettlementResponse` objects.

An unpaid MCP request may return a `payment_required` result containing the x402 `PaymentRequired` object. Paid requests and settlement responses use the same x402 `_meta` fields as the tool-result binding.

### Capability Negotiation

The extension identifier is `org.x402/payment`.

#### Client Capability

Clients advertise support in the extension map of the per-request MCP client capabilities:

```json
{
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {
      "extensions": {
        "org.x402/payment": {}
      }
    },
    "io.modelcontextprotocol/clientInfo": {
      "name": "ExampleClient",
      "version": "1.0.0"
    }
  }
}
```

#### Server Capability

Servers advertise support in the `server/discover` response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "complete",
    "supportedVersions": ["2026-07-28"],
    "capabilities": {
      "tools": {},
      "resources": {},
      "prompts": {},
      "extensions": {
        "org.x402/payment": {}
      }
    },
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "ExampleServer",
        "version": "1.0.0"
      }
    }
  }
}
```

### Protocol Mapping

This extension defines one additional MCP result type:

| Result type        | Result field             | x402 type         |
| ------------------ | ------------------------ | ----------------- |
| `payment_required` | `result.paymentRequired` | `PaymentRequired` |

`payment_required` extends the result union of supported MCP methods. It means that the requested operation did not execute because payment is required. It is not a JSON-RPC error and it is not a completed method-specific result.

The extension applies to:

- `tools/call`
- `resources/read`
- `prompts/get`

### Payment Required Result

When payment is required and no acceptable `PaymentPayload` is present, a supporting server returns `resultType: "payment_required"` with a `PaymentRequired` object:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "resultType": "payment_required",
    "paymentRequired": {
      "x402Version": 2,
      "error": "Payment required to call financial_analysis",
      "resource": {
        "url": "mcp://api.example.com/tools/financial_analysis",
        "description": "Advanced financial analysis",
        "mimeType": "application/json"
      },
      "accepts": [
        {
          "scheme": "exact",
          "network": "eip155:8453",
          "amount": "10000",
          "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
          "maxTimeoutSeconds": 60,
          "extra": {
            "name": "USDC",
            "version": "2"
          }
        }
      ],
      "extensions": {}
    }
  }
}
```

The server MUST NOT execute the protected operation before returning this result.

### Error Handling

For a request that advertises `org.x402/payment`, if payment is missing or invalid and the client can retry, the server MUST return `payment_required` with current `PaymentRequired` data.

When a `SettlementResponse` is available, the server SHOULD include it in `result._meta["x402/payment-response"]`. Errors unrelated to payment use the normal MCP JSON-RPC or method-specific error mechanisms.

## References

- [Core x402 Specification](../x402-specification-v2.md)
- [MCP Extensions](https://modelcontextprotocol.io/extensions/overview)
- [MCP 2026-07-28 Base Protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic)
- [MCP 2025-06-18 `_meta` Field](https://modelcontextprotocol.io/specification/2025-06-18/basic#meta)
- [agents/x402-mcp](https://github.com/cloudflare/agents/blob/main/packages/agents/src/mcp/x402.ts)
