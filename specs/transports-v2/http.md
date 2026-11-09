# Transport: HTTP

## Summary

The HTTP transport implements x402 payment flows over standard HTTP/HTTPS protocols. This is the original transport for x402 and leverages existing HTTP status codes and headers for payment required signaling and payment payload transmission.

## Payment Required Signaling

The server indicates payment is required using the HTTP 402 "Payment Required" status code.

**Mechanism**: HTTP 402 status code with `PAYMENT-REQUIRED` header
**Data Format**: Base64-encoded `PaymentRequired` schema in header

The `PAYMENT-REQUIRED` header is the canonical HTTP transport location for the
`PaymentRequired` object.

**Example:**

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQQVlNRU5ULVNJR05BVFVSRSBoZWFkZXIgaXMgcmVxdWlyZWQiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbS9wcmVtaXVtLWRhdGEiLCJkZXNjcmlwdGlvbiI6IkFjY2VzcyB0byBwcmVtaXVtIG1hcmtldCBkYXRhIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzMiIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDAzNkNiRDUzODQyYzU0MjY2MzRlNzkyOTU0MWVDMjMxOGYzZENGN2UiLCJwYXlUbyI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fV19

{}
```

The base64 header decodes to:

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
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
}
```

## Payment Payload Transmission

Clients send payment data using the `PAYMENT-SIGNATURE` HTTP header.

**Mechanism**: `PAYMENT-SIGNATURE` header containing base64-encoded JSON
**Data Format**: Base64-encoded `PaymentPayload` schema

**Example:**

```http
POST /premium-data HTTP/1.1
Host: api.example.com
PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vcHJlbWl1bS1kYXRhIiwiZGVzY3JpcHRpb24iOiJBY2Nlc3MgdG8gcHJlbWl1bSBtYXJrZXQgZGF0YSIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LCJhY2NlcHRlZCI6eyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJhbW91bnQiOiIxMDAwMCIsImFzc2V0IjoiMHgwMzZDYkQ1Mzg0MmM1NDI2NjM0ZTc5Mjk1NDFlQzIzMThmM2RDRjdlIiwicGF5VG8iOiIweDIwOTY5M0JjNmFmYzBDNTMyOGJBMzZGYUYwM0M1MTRFRjMxMjI4N0MiLCJtYXhUaW1lb3V0U2Vjb25kcyI6NjAsImV4dHJhIjp7Im5hbWUiOiJVU0RDIiwidmVyc2lvbiI6IjIifX0sInBheWxvYWQiOnsic2lnbmF0dXJlIjoiMHgyZDZhNzU4OGQ2YWNjYTUwNWNiZjBkOWE0YTIyN2UwYzUyYzZjMzQwMDhjOGU4OTg2YTEyODMyNTk3NjQxNzM2MDhhMmNlNjQ5NjY0MmUzNzdkNmRhOGRiYmY1ODM2ZTliZDE1MDkyZjllY2FiMDVkZWQzZDYyOTNhZjE0OGI1NzFjIiwiYXV0aG9yaXphdGlvbiI6eyJmcm9tIjoiMHg4NTdiMDY1MTlFOTFlM0E1NDUzODc5MWJEYmIwRTIyMzczZTM2YjY2IiwidG8iOiIweDIwOTY5M0JjNmFmYzBDNTMyOGJBMzZGYUYwM0M1MTRFRjMxMjI4N0MiLCJ2YWx1ZSI6IjEwMDAwIiwidmFsaWRBZnRlciI6IjE3NDA2NzIwODkiLCJ2YWxpZEJlZm9yZSI6IjE3NDA2NzIxNTQiLCJub25jZSI6IjB4ZjM3NDY2MTNjMmQ5MjBiNWZkYWJjMDg1NmYyYWViMmQ0Zjg4ZWU2MDM3YjhjYzVkMDRhNzFhNDQ2MmYxMzQ4MCJ9fX0=
Content-Type: application/json

{
  "query": "latest market data"
}
```

The base64 payload decodes to:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
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
```

## Settlement Response Delivery

Servers communicate payment settlement results using the `PAYMENT-RESPONSE` header.

**Mechanism**: `PAYMENT-RESPONSE` header containing base64-encoded JSON
**Data Format**: Base64-encoded `SettlementResponse` schema

**Example (Success):**

```http
HTTP/1.1 200 OK
Content-Type: application/json
PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWYxMjM0NTY3ODkwYWJjZGVmMTIzNDU2Nzg5MGFiY2RlZiIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJwYXllciI6IjB4ODU3YjA2NTE5RTkxZTNBNTQ1Mzg3OTFiRGJiMEUyMjM3M2UzNmI2NiJ9

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
  "network": "eip155:84532",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
}
```

**Example (Failure):**

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
PAYMENT-RESPONSE: eyJzdWNjZXNzIjpmYWxzZSwiZXJyb3JSZWFzb24iOiJpbnN1ZmZpY2llbnRfZnVuZHMiLCJ0cmFuc2FjdGlvbiI6IiIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJwYXllciI6IjB4ODU3YjA2NTE5RTkxZTNBNTQ1Mzg3OTFiRGJiMEUyMjM3M2UzNmI2NiJ9

{}
```

The base64 response header decodes to:

```json
{
  "success": false,
  "errorReason": "insufficient_funds",
  "transaction": "",
  "network": "eip155:84532",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
}
```

## Header Summary

| Header | Direction | Description |
| ------ | --------- | ----------- |
| `PAYMENT-REQUIRED` | Server → Client | Base64-encoded `PaymentRequired` object |
| `PAYMENT-SIGNATURE` | Client → Server | Base64-encoded `PaymentPayload` object |
| `PAYMENT-RESPONSE` | Server → Client | Base64-encoded `SettlementResponse` object |

### Browser clients

None of the three headers above is CORS-safelisted. A cross-origin `fetch()`
therefore cannot read `PAYMENT-REQUIRED` or `PAYMENT-RESPONSE` unless the
response names them in `Access-Control-Expose-Headers`, and cannot send
`PAYMENT-SIGNATURE` unless the preflight allows it.

A resource server intended to be reachable from a browser SHOULD:

- send `Access-Control-Allow-Origin` for the calling origin on the 402
  itself. Without it the browser hides the whole response, and nothing else
  in this list has any effect;
- name `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` in
  `Access-Control-Expose-Headers`, merged with any value already present
  rather than replacing it. A value of `*` does not cover them on a
  credentialed request;
- name `PAYMENT-SIGNATURE` in `Access-Control-Allow-Headers`, alongside
  `Content-Type` when requests carry a body. A value of `*` does not cover
  either on a credentialed request, where `*` is read as a literal header
  name. `Content-Type` is safelisted only for form and plain-text values, so
  a payment request with a JSON body triggers the preflight on
  `Content-Type` before any payment header is considered: omit it and the
  client never reaches the 402 at all;
- name the v1 spellings too, if it still serves v1 clients, each in the list
  matching its direction: `X-PAYMENT` in `Access-Control-Allow-Headers`
  beside `PAYMENT-SIGNATURE`, since the client sends it, and
  `X-PAYMENT-RESPONSE` in `Access-Control-Expose-Headers` beside
  `PAYMENT-RESPONSE`, since the server returns it. A dual-version endpoint
  that names only one spelling fails the same way for the other version's
  clients;
- answer the preflight `OPTIONS` without requiring payment, and send a
  non-trivial `Access-Control-Max-Age`. A priced resource otherwise pays a
  preflight round trip on every cross-origin call;
- send `Vary: Origin` if it reflects an origin rather than sending `*`, and
  keep the 402 out of shared caches.

Omitting the expose list produces a 402 whose price the client cannot read:
the response arrives, the header is hidden, and the client reports a parse
failure on an apparently empty challenge. Omitting the allow list produces a
payment the client cannot send: the browser refuses the retry at the
preflight and reports a network error with no status at all. Neither
message names CORS, and an unpaid probe with `curl` passes either way, so
neither is diagnosable from the client side alone.

A preflight should be tested against the request the client's SDK actually
sends, not against the three headers above. Clients have added request
headers of their own - a release of the TypeScript clients put
`Access-Control-Expose-Headers`, a response-only directive, on the paid
retry - and a browser lists every non-safelisted name it finds in
`Access-Control-Request-Headers`, so an allow list naming exactly the
protocol headers refuses that retry while every check in this section
passes. That is a client defect, to be fixed in the client; it is recorded
here because the failure appears on the server, as a refused preflight.

A resource server MAY instead refuse browser origins on a paid route. This is
a choice about who may call the resource, not a payment control: CORS governs
whether a page may read a response, while the decision to spend belongs to
whatever holds the payer's signing key. Refusing browser origins prevents
*that server* from receiving an unintended payment; it does not prevent the
payment from being made elsewhere.

## Response Body

Response bodies are a server implementation concern. All x402 protocol information is communicated through headers (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`). 

## Error Handling

HTTP transport maps x402 errors to standard HTTP status codes:

| x402 Error       | HTTP Status | Description                                     |
| ---------------- | ----------- | ----------------------------------------------- |
| Payment Required | 402         | Payment needed to access resource               |
| Invalid Payment  | 400         | Malformed payment payload or requirements       |
| Payment Failed   | 402         | Payment verification or settlement failed       |
| Server Error     | 500         | Internal server error during payment processing |
| Success          | 200         | Payment verified and settled successfully       |

## References

- [Core x402 Specification](../x402-specification-v2.md)
- [HTTP/1.1 Specification (RFC 7231)](https://tools.ietf.org/html/rfc7231)
- [HTTP 402 Status Code](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402)
