# Extension: `http-message-signatures`

## Summary

The `http-message-signatures` extension establishes the **identity** of the paying agent through cryptographic signatures (RFC 9421). This extension is used by network implementations that authenticate payment commitments using HTTP Message Signatures.

## Purpose

Establishes the cryptographic identity of the paying agent and provides information on how to associate that identity with the network for billing.

## Extension Definition

```json
{
  "http-message-signatures": {
    "schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "registrationUrl": {
          "type": "string",
          "format": "uri",
          "description": "URL to the network's setup endpoint and documentation"
        },
        "signatureSchemes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Supported cryptographic signature algorithms"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Supported signature tags for validation"
        }
      },
      "required": ["registrationUrl", "signatureSchemes"]
    },
    "info": {
      "registrationUrl": "https://network.example.com/signature-agents",
      "signatureSchemes": ["ed25519", "ecdsa-p256-sha256", "rsa-pss-sha512"],
      "tags": ["web-bot-auth", "agent-browser-auth"]
    }
  }
}
```

## Fields

- **`registrationUrl`** (required): URL to the network's documentation and setup endpoint where signature agents can associate their identity with a billing identity
- **`signatureSchemes`** (required): Array of supported cryptographic algorithms (e.g., `["ed25519", "ecdsa-p256-sha256", "rsa-pss-sha512"]`)
- **`tags`** (required): Array of supported signature tags that identify the purpose (e.g., `["web-bot-auth"]`)

**Schema Omission**: The `schema` field is optional and may be omitted from responses to reduce header size. When omitted, clients should reference this specification for field definitions.

## Usage

Networks that use HTTP Message Signatures for authentication include this extension in the `PaymentRequired` response to inform clients:

1. Where to register their signature agent with the network (`registrationUrl`)
2. Which cryptographic algorithms are supported (`signatureSchemes`)
3. Which signature tags are accepted for validation (`tags`)

The client must:

1. Host their public keys at `/.well-known/http-message-signatures-directory` (per draft-meunier-http-message-signatures-directory)
2. Register their signature agent URL with the network via the `registrationUrl`
3. Sign HTTP requests using HTTP Message Signatures (RFC 9421) with the appropriate tag

## Server-Signed Responses

Servers can sign responses per RFC 9421 Section 3.1 to provide integrity for payment data. This enables clients to verify that `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` headers have not been modified, and to pin a specific version of terms to a transaction.

### Covered Components

Per RFC 9421 Section 2.2.9, responses can include `@status` in the signature. Per Section 2.4, servers can bind response signatures to request components using the `req` flag. For x402, servers signing responses should include:

- `@status`: HTTP status code
- `payment-required` or `payment-response`: The x402 header
- Request binding: `"@authority";req`, `"@path";req`

### Example

```http
HTTP/2 200 OK
Content-Type: text/html
PAYMENT-RESPONSE: eyJhbW91bnQiOiI1IiwiYXNzZXQiOiJVU0QiLCJleHRlbnNpb25zIjp7InRlcm1zIjp7ImluZm8iOnsiZm9ybWF0IjoidXJpIiwidGVybXMiOiJodHRwczovL2V4YW1wbGUuY29tL3Rlcm1zLXYyLjAubWQifX19fQ==
Signature-Input: resp=("@status" "payment-response" "@authority";req "@path";req);created=1700000000;keyid="server-key";tag="x402-response"
Signature: resp=:abc123...==:
```

Servers publishing response signatures should host their public keys at `/.well-known/http-message-signatures-directory`.

## Example Networks

- **Cloudflare** (`cloudflare:402`): Uses this extension with `ed25519` signatures and `web-bot-auth` tag

## Example

```json
{
  "extensions": {
    "http-message-signatures": {
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "registrationUrl": { "type": "string", "format": "uri" },
          "signatureSchemes": {
            "type": "array",
            "items": { "type": "string" }
          },
          "tags": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["registrationUrl", "signatureSchemes"]
      },
      "info": {
        "registrationUrl": "https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-ai-owner/verify-ai-crawler/",
        "signatureSchemes": ["ed25519"],
        "tags": ["web-bot-auth"]
      }
    }
  }
}
```
