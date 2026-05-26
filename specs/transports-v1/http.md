# Transport: HTTP

## Summary

The HTTP transport implements x402 payment flows over standard HTTP/HTTPS protocols. This is the original transport for x402 and leverages existing HTTP status codes and headers for payment required signaling and payment payload transmission.

## Payment Required Signaling

The server indicates payment is required using the HTTP 402 "Payment Required" status code.

**Mechanism**: HTTP 402 status code with JSON response body
**Data Format**: `PaymentRequirementsResponse` schema in response body

**Example:**

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "x402Version": 1,
  "error": "Payment required to access this resource",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "10000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "resource": "https://api.example.com/premium-data",
      "description": "Access to premium market data",
      "mimeType": "application/json",
      "outputSchema": null,
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    }
  ]
}
```

## Payment Payload Transmission

Clients send payment data using the `X-PAYMENT` HTTP header.

**Mechanism**: `X-PAYMENT` header containing base64-encoded JSON
**Data Format**: Base64-encoded `PaymentPayload` schema

**Example:**

```http
POST /premium-data HTTP/1.1
Host: api.example.com
X-PAYMENT: eyJ4NDAyVmVyc2lvbiI6MSwic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiYmFzZS1zZXBvbGlhIiwicGF5bG9hZCI6eyJzaWduYXR1cmUiOiIweDJkNmE3NTg4ZDZhY2NhNTA1Y2JmMGQ5YTRhMjI3ZTBjNTJjNmMzNDAwOGM4ZTg5ODZhMTI4MzI1OTc2NDE3MzYwOGEyY2U2NDk2NjQyZTM3N2Q2ZGE4ZGJiZjU4MzZlOWJkMTUwOTJmOWVjYWIwNWRlZDNkNjI5M2FmMTQ4YjU3MWMiLCJhdXRob3JpemF0aW9uIjp7ImZyb20iOiIweDg1N2IwNjUxOUU5MWUzQTU0NTM4NzkxYkRiYjBFMjIzNzNlMzZiNjYiLCJ0byI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsInZhbHVlIjoiMTAwMDAiLCJ2YWxpZEFmdGVyIjoiMTc0MDY3MjA4OSIsInZhbGlkQmVmb3JlIjoiMTc0MDY3MjE1NCIsIm5vbmNlIjoiMHhmMzc0NjYxM2MyZDkyMGI1ZmRhYmMwODU2ZjJhZWIyZDRmODhlZTYwMzdiOGNjNWQwNGE3MWE0NDYyZjEzNDgwIn19fQ==
Content-Type: application/json

{
  "query": "latest market data"
}
```

The base64 payload decodes to:

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "base-sepolia",
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
```

## Settlement Response Delivery

Servers communicate payment settlement results using the `X-PAYMENT-RESPONSE` header.

**Mechanism**: `X-PAYMENT-RESPONSE` header containing base64-encoded JSON
**Data Format**: Base64-encoded `SettlementResponse` schema

**Example (Success):**

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWYxMjM0NTY3ODkwYWJjZGVmMTIzNDU2Nzg5MGFiY2RlZiIsIm5ldHdvcmsiOiJiYXNlLXNlcG9saWEiLCJwYXllciI6IjB4ODU3YjA2NTE5RTkxZTNBNTQ1Mzg3OTFiRGJiMEUyMjM3M2UzNmI2NiJ9

{
  "data": "premium market data response",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

The base64 response header decodes to:

```json
{
  "success": true,
  "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "network": "base-sepolia",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
}
```

**Example (Failure):**

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
X-PAYMENT-RESPONSE: eyJzdWNjZXNzIjpmYWxzZSwiZXJyb3JSZWFzb24iOiJpbnN1ZmZpY2llbnRfZnVuZHMiLCJ0cmFuc2FjdGlvbiI6IiIsIm5ldHdvcmsiOiJiYXNlLXNlcG9saWEiLCJwYXllciI6IjB4ODU3YjA2NTE5RTkxZTNBNTQ1Mzg3OTFiRGJiMEUyMjM3M2UzNmI2NiJ9

{
  "x402Version": 1,
  "error": "Payment failed: insufficient funds",
  "accepts": [...]
}
```

## Error Handling

HTTP transport maps x402 errors to standard HTTP status codes:

| x402 Error       | HTTP Status | Description                                     |
| ---------------- | ----------- | ----------------------------------------------- |
| Payment Required | 402         | Payment needed to access resource               |
| Invalid Payment  | 400         | Malformed payment payload or requirements       |
| Payment Failed   | 402         | Payment verification or settlement failed       |
| Server Error     | 500         | Internal server error during payment processing |
| Success          | 200         | Payment verified and settled successfully       |

**Error Response Format:**

```json
{
  "x402Version": 1,
  "error": "Human-readable error message",
  "accepts": [
    /* payment requirements */
  ]
}
```

## References

- [Core x402 Specification](../x402-specification-v1.md)
- [HTTP/1.1 Specification (RFC 7231)](https://tools.ietf.org/html/rfc7231)
- [HTTP 402 Status Code](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402)
- [Express.js x402 Integration](../../examples/typescript/legacy/servers/express)
- [Fetch API x402 Client](../../examples/typescript/legacy/clients/fetch)
