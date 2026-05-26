# Transport: A2A (Agent-to-Agent Protocol)

## Summary

The A2A transport implements x402 payment flows over the Agent-to-Agent protocol using JSON-RPC messages and task-based state management. This enables AI agents to monetize their services through on-chain cryptocurrency payments within the A2A framework, leveraging the protocol's task lifecycle and metadata system for payment coordination.

## Payment Required Signaling

The server agent indicates payment is required using A2A's task state `input-required` with payment metadata.

**Mechanism**: Task with `state: "input-required"` and `x402.payment.status: "payment-required"` in message metadata  
**Data Format**: `PaymentRequirementsResponse` schema in `x402.payment.required` metadata field

**Example:**

```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "result": {
    "kind": "task",
    "id": "task-123",
    "status": {
      "state": "input-required",
      "message": {
        "kind": "message",
        "role": "agent",
        "parts": [
          {
            "kind": "text",
            "text": "Payment is required to generate the image."
          }
        ],
        "metadata": {
          "x402.payment.status": "payment-required",
          "x402.payment.required": {
            "x402Version": 1,
            "error": "Payment required to access this resource",
            "accepts": [
              {
                "scheme": "exact",
                "network": "base",
                "resource": "https://api.example.com/generate-image",
                "description": "Generate an image",
                "mimeType": "application/json",
                "outputSchema": {},
                "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913",
                "payTo": "0xServerWalletAddressHere",
                "maxAmountRequired": "48240000",
                "maxTimeoutSeconds": 600,
                "extra": {
                  "name": "USD Coin",
                  "version": 2
                }
              }
            ]
          }
        }
      }
    }
  }
}
```

## Payment Payload Transmission

Clients send payment data using the A2A message metadata with task correlation.

**Mechanism**: Message with `x402.payment.payload` metadata field and `taskId` for correlation  
**Data Format**: `PaymentPayload` schema in `x402.payment.payload` metadata field

**Example:**

```json
{
  "jsonrpc": "2.0",
  "method": "message/send",
  "id": "req-003",
  "params": {
    "message": {
      "taskId": "task-123",
      "role": "user",
      "parts": [
        { "kind": "text", "text": "Here is the payment authorization." }
      ],
      "metadata": {
        "x402.payment.status": "payment-submitted",
        "x402.payment.payload": {
          "x402Version": 1,
          "scheme": "exact",
          "network": "base",
          "payload": {
            "signature": "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
            "authorization": {
              "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
              "to": "0xServerWalletAddressHere",
              "value": "48240000",
              "validAfter": "1740672089",
              "validBefore": "1740672154",
              "nonce": "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480"
            }
          }
        }
      }
    }
  }
}
```

## Settlement Response Delivery

Servers communicate payment settlement results using task status updates with settlement metadata.

**Mechanism**: Task status update with `x402.payment.receipts` metadata field  
**Data Format**: Array of `SettlementResponse` schemas in `x402.payment.receipts` metadata field

**Example (Successful Settlement):**

```json
{
  "jsonrpc": "2.0",
  "id": "req-003",
  "result": {
    "kind": "task",
    "id": "task-123",
    "status": {
      "state": "completed",
      "message": {
        "kind": "message",
        "role": "agent",
        "parts": [
          { "kind": "text", "text": "Payment successful. Your image is ready." }
        ],
        "metadata": {
          "x402.payment.status": "payment-completed",
          "x402.payment.receipts": [
            {
              "success": true,
              "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
              "network": "base",
              "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
            }
          ]
        }
      }
    },
    "artifacts": [
      {
        "kind": "image",
        "name": "generated-image.png",
        "mimeType": "image/png",
        "data": "base64-encoded-image-data"
      }
    ]
  }
}
```

**Example (Payment Failure):**

```json
{
  "jsonrpc": "2.0",
  "id": "req-003",
  "result": {
    "kind": "task",
    "id": "task-123",
    "status": {
      "state": "failed",
      "message": {
        "kind": "message",
        "role": "agent",
        "parts": [
          {
            "kind": "text",
            "text": "Payment verification failed: The signature has expired."
          }
        ],
        "metadata": {
          "x402.payment.status": "payment-failed",
          "x402.payment.error": "EXPIRED_PAYMENT",
          "x402.payment.receipts": [
            {
              "success": false,
              "errorReason": "Payment authorization was submitted after its 'validBefore' timestamp.",
              "network": "base",
              "transaction": ""
            }
          ]
        }
      }
    }
  }
}
```

## Payment Status Lifecycle

The A2A transport uses a detailed payment status progression tracked in the `x402.payment.status` metadata field:

| Status              | Description                               | Task State                   |
| ------------------- | ----------------------------------------- | ---------------------------- |
| `payment-required`  | Payment requirements sent to client       | `input-required`             |
| `payment-rejected`  | Client rejected payment requirements      | `failed` or `input-required` |
| `payment-submitted` | Payment payload received by server        | `input-required` → `working` |
| `payment-verified`  | Payment payload verified by server        | `working`                    |
| `payment-completed` | Payment settled on-chain successfully     | `working` → `completed`      |
| `payment-failed`    | Payment verification or settlement failed | `failed`                     |

## Error Handling

A2A transport maps x402 errors to task states and metadata:

| x402 Error       | Task State       | Payment Status      | Description                                     |
| ---------------- | ---------------- | ------------------- | ----------------------------------------------- |
| Payment Required | `input-required` | `payment-required`  | Payment needed to access resource               |
| Payment Rejected | `failed`         | `payment-rejected`  | Client declined payment requirements            |
| Invalid Payment  | `failed`         | `payment-failed`    | Malformed payment payload or requirements       |
| Payment Failed   | `failed`         | `payment-failed`    | Payment verification or settlement failed       |
| Server Error     | `failed`         | `payment-failed`    | Internal server error during payment processing |
| Success          | `completed`      | `payment-completed` | Payment verified and settled successfully       |

**Error Response Format:**

Task state transitions to `failed` with detailed error information in metadata:

```json
{
  "kind": "task",
  "id": "task-123",
  "status": {
    "state": "failed",
    "message": {
      "kind": "message",
      "role": "agent",
      "parts": [
        {
          "kind": "text",
          "text": "Payment verification failed: insufficient funds"
        }
      ],
      "metadata": {
        "x402.payment.status": "payment-failed",
        "x402.payment.error": "INSUFFICIENT_FUNDS",
        "x402.payment.receipts": [
          {
            "success": false,
            "errorReason": "The client's wallet has insufficient funds to cover the payment.",
            "network": "base",
            "transaction": ""
          }
        ]
      }
    }
  }
}
```

## Extension Declaration and Activation

Agents supporting x402 payments must declare the extension in their AgentCard:

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "https://github.com/google-a2a/a2a-x402/v0.1",
        "description": "Supports payments using the x402 protocol for on-chain settlement.",
        "required": true
      }
    ]
  }
}
```

Clients must activate the extension using the `X-A2A-Extensions` HTTP header:

```http
X-A2A-Extensions: https://github.com/google-a2a/a2a-x402/v0.1
```

## References

- [Core x402 Specification](../x402-specification.md)
- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification)
- [A2A Extensions Documentation](https://github.com/a2aproject/A2A/blob/main/docs/topics/extensions.md)
- [A2A x402 Extension Specification](https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.1/spec.md)
