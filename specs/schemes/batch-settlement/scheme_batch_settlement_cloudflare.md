# Scheme: `batch-settlement` `cloudflare:402`

## Summary

The `batch-settlement` scheme on the Cloudflare network `cloudflare:402` enables access to resources through cryptographically signed payment commitments that are settled later through the network's infrastructure.

**Network Identifier**: `cloudflare:402`
**Trust Model**: Credit-backed (see [batch_settlement.md](./batch_settlement.md#credit-backed))

**Authentication Method**: This implementation uses **HTTP Message Signatures (RFC 9421)** to authenticate payment commitments. The network acts as a trusted intermediary to provide immediate resource access while settlement is batched and handled later.

## Protocol Flow

The protocol flow for `batch-settlement` on the network (Cloudflare) includes an initial setup step, followed by client-driven payment with optional pre-authorization:

### First-time Setup (Client)

1. Host public keys at a `.well-known` endpoint (e.g., `https://mycrawler.com/.well-known/http-message-signatures-directory`)
2. Submit signature agent URL to the `registrationUrl` from the `http-message-signatures` extension (e.g., `https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-ai-owner/verify-ai-crawler/`)
3. The network (Cloudflare) associates signature agent URL with a billing identity for settlement

### Payment Flow (Per Request)

1. Makes an HTTP request to a **Resource Server**.
2. **Resource Server** responds with a `402 Payment Required` status. The response includes a PAYMENT-REQUIRED header (base64-encoded JSON) containing payment requirements with the `batch-settlement` scheme and `cloudflare:402` network with `payTo` set to `merchant`. The response also includes the `http-message-signatures` extension indicating where to find documentation on associating the HTTP message signature agent with the network.
3. **Client** constructs a payment payload containing the payment commitment (amount, asset) and signs the HTTP request using **HTTP Message Signatures (RFC 9421)**. The client includes `Signature-Agent`, `Signature-Input`, and `Signature` headers along with the PAYMENT-SIGNATURE header.
4. **Client** sends a new HTTP request with the PAYMENT-SIGNATURE header (base64-encoded JSON) and HTTP Message Signature headers.
5. **Resource Server** verifies the signature agent is recognized by the network (Cloudflare) and fetches the public key.
6. **Resource Server** verifies the HTTP Message Signature is valid using the fetched public key.
7. **Resource Server** validates the payment amount and asset match the requirements.
8. **Resource Server**, upon successful verification, grants the **Client** access to the resource and includes a PAYMENT-RESPONSE header (base64-encoded JSON) confirming the payment commitment.
9. The network (Cloudflare) acts as Merchant of Record, handling batched settlement and billing the identity associated with the signature agent.

**Pre-Authorized Flow**: Clients with pre-authorized payment agreements can include the PAYMENT-SIGNATURE header and HTTP Message Signature headers in their initial request (step 1), bypassing the 402 response and proceeding directly to verification and access.

**Note on HTTP Message Signatures**: All requests are signed using HTTP Message Signatures (RFC 9421). The signature agent's `.well-known/http-message-signatures-directory` URL must be known to the network (Cloudflare) and associated with a billing identity for settlement. This conforms to [draft-meunier-http-message-signatures-directory-04](https://datatracker.ietf.org/doc/html/draft-meunier-http-message-signatures-directory-04).

## PaymentRequired for batch-settlement

The `batch-settlement` scheme on the Cloudflare network uses the standard x402 `PaymentRequired` fields. The Cloudflare implementation includes the `http-message-signatures` extension to communicate authentication requirements.

> **Note on Price Availability**: The `amount` field in `accepts` may not be available in all responses. Price information is only guaranteed when the HTTP Message Signature extension is correctly parsed and the signature agent is recognized. When price is not available, clients should retry with authentication.

### Header Size Constraints

HTTP intermediaries may reject headers larger than 2KB. To minimize header size, the `cloudflare:402` network:

- Omits `schema` from extensions (schemas are documented in the extension specifications)
- May omit optional `resource` fields (`description`, `website`) when not available

**Required fields:**

- `x402Version`
- `accepts[].scheme`, `accepts[].network`, `accepts[].amount`, `accepts[].asset`, `accepts[].payTo`
- `accepts[].extra.version`: Network implementation version (semver format)
- `extensions.http-message-signatures.info.registrationUrl`, `extensions.http-message-signatures.info.signatureSchemes`, `extensions.http-message-signatures.info.tags`

```http
HTTP/2 402 Payment Required
Content-Type: text/html
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6IDIsICJlcnJvciI6ICJObyBQQVlNRU5ULVNJR05BVFVSRSBoZWFkZXIgcHJvdmlkZWQiLCAicmVzb3VyY2UiOiB7InVybCI6ICJodHRwczovL2V4YW1wbGUuY29tL2FydGljbGUiLCAiZGVzY3JpcHRpb24iOiAiUHJlbWl1bSBhcnRpY2xlIGNvbnRlbnQiLCAibWltZVR5cGUiOiAidGV4dC9odG1sIn0sICJhY2NlcHRzIjogWy4uLl19

<!DOCTYPE html>
<html>
  <head><title>Payment Required</title></head>
  <body>This content requires payment.</body>
</html>
```

**Decoded PAYMENT-REQUIRED header:**

```json
{
  "x402Version": 2,
  "error": "No PAYMENT-SIGNATURE header provided",
  "resource": {
    "url": "https://example.com/article",
    "mimeType": "text/html"
  },
  "accepts": [
    {
      "scheme": "batch-settlement",
      "network": "cloudflare:402",
      "amount": "1",
      "asset": "USD",
      "payTo": "merchant",
      "extra": {
        "version": "1.0.0"
      }
    }
  ],
  "extensions": {
    "http-message-signatures": {
      "info": {
        "registrationUrl": "https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-ai-owner/verify-ai-crawler/",
        "signatureSchemes": ["ed25519"],
        "tags": ["web-bot-auth"]
      }
    }
  }
}
```

**PaymentRequirements fields:**

- `scheme`: Must be `"batch-settlement"`
- `network`: Must be `"cloudflare:402"` (CAIP-2 format)
- `asset`: The asset identifier (e.g., `"USD"` for fiat currency - ISO 4217 format)
- `payTo`: Must be `"merchant"` (constant indicating the network handles settlement)
- `amount`: Payment amount in smallest unit of the asset (e.g., cents for USD)
- `maxTimeoutSeconds`: Maximum time allowed for payment completion (optional, see note below)
- `extra.version`: Network implementation version in semver format (see [Network Version](#network-version))

> **Note on Timeouts**: When the `maxTimeoutSeconds` is omitted or set to `0`, the network makes no timing guarantees on price validity. Clients should not cache pricing information across requests when timeout is zero or absent.

**Extensions:**

The Cloudflare implementation uses the `http-message-signatures` extension to communicate authentication requirements:

- `extensions.http-message-signatures`: Communicates Cloudflare's authentication requirements
  - `info.registrationUrl`: URL to the network's setup documentation (`https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-ai-owner/verify-ai-crawler/`) - this is intended for human-driven setup; a programmatic API endpoint may be provided in future versions
  - `info.signatureSchemes`: Supported algorithms (`["ed25519"]`)
  - `info.tags`: Supported signature tags (`["web-bot-auth"]`)

Note: `payTo` is set to `"merchant"` as the network handles settlement.

## PAYMENT-SIGNATURE Header Payload

The client sends a PAYMENT-SIGNATURE header containing base64-encoded JSON with the payment payload.

```http
GET /article HTTP/2
Host: example.com
Signature-Agent: mycrawler.com
Signature-Input: sig=("@authority" "signature-agent" "payment-signature"); created=1700000000; expires=1700011111; keyid="ba3e64=="; tag="web-bot-auth"
Signature: sig=:abc123...==:
PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbiI6MiwicGF5bG9hZCI6eyJhbW91bnQiOiI1IiwiYXNzZXQiOiJVU0QifSwiYWNjZXB0ZWQiOnsic2NoZW1lIjoiYmF0Y2gtc2V0dGxlbWVudCIsIm5ldHdvcmsiOiJjbG91ZGZsYXJlOjQwMiIsImFtb3VudCI6IjUiLCJhc3NldCI6IlVTRCIsInBheVRvIjoibWVyY2hhbnQiLCJtYXhUaW1lb3V0U2Vjb25kcyI6MzB9fQ==
```

**Decoded PAYMENT-SIGNATURE header:**

```json
{
  "x402Version": 2,
  "payload": {
    "amount": "5",
    "asset": "USD"
  },
  "accepted": {
    "scheme": "batch-settlement",
    "network": "cloudflare:402",
    "amount": "5",
    "asset": "USD",
    "payTo": "merchant",
    "maxTimeoutSeconds": 30
  }
}
```

The `payload` field contains:

- `amount`: Payment amount in smallest unit of the asset (e.g., cents for USD)
- `asset`: Asset identifier (e.g., `"USD"`)

**Note**: The `signatureAgent` and `signature` are NOT in the payment payload. They come from the HTTP Message Signature headers (`Signature-Agent` and `Signature` headers) as defined in RFC 9421.

The `accepted` field contains the full `PaymentRequirements` object that this payment fulfills (without extensions, as those are at the top level).

**Note on Extensions**: According to v2 spec, clients must echo the extensions from the `PaymentRequired` response. However, extensions are not part of the `accepted` field since `accepted` contains only the specific `PaymentRequirements` object from the `accepts` array. Extensions would be echoed at the top level of the payment payload if the client needs to respond to them.

## Verification

Steps to verify a payment for the `batch-settlement` scheme, the network (Cloudflare) implements:

1. **Verify HTTP Message Signature is valid**: Validate the HTTP Message Signature (RFC 9421) from the `Signature` header using the public key fetched from the `Signature-Agent` header URL
2. **Verify signature agent is recognized by the network**: Confirm the signature agent URL (from `Signature-Agent` header) is known to the network (Cloudflare) and associated with a billing identity
3. **Verify amount and asset are sufficient**: Ensure the payment amount and asset meet the requirements
4. **Verify timestamp freshness**: Ensure the payment is not expired (typically within 30 seconds)
5. **Verify accepted field matches**: Verify the `accepted` field matches one of the offered `PaymentRequirements`

### Verification Pseudocode

```javascript
function verifyBatchSettlementPayment(paymentPayload, signatureAgentHeader, httpSignature) {
  // 1. Verify signature agent is recognized by the network and get billing info
  const agentInfo = await verifySignatureAgentWithNetwork(signatureAgentHeader);

  if (!agentInfo.isRecognized) {
    return { valid: false, reason: "signature_agent_unknown" };
  }

  // 2. Fetch public key from signature agent's .well-known/http-message-signatures-directory endpoint
  const publicKey = await fetchPublicKey(signatureAgentHeader, agentInfo.keyId);

  if (!publicKey) {
    return { valid: false, reason: "server_error" };
  }

  // 3. Verify HTTP Message Signature using the public key
  const isSignatureValid = verifyHttpMessageSignature(
    httpSignature,
    publicKey,
    buildCanonicalString(paymentPayload)
  );

  if (!isSignatureValid) {
    return { valid: false, reason: "invalid_signature" };
  }

  // 4. Verify payment signature header is correctly structured
  if (!isValidPaymentSignature(paymentPayload)) {
    return { valid: false, reason: "invalid_payment" };
  }

  // 5. Verify amount/asset are sufficient for the resource
  const isSufficientPayment = checkPaymentSufficiency(
    paymentPayload.accepted.amount,
    paymentPayload.accepted.asset,
  );

  if (!isSufficientPayment) {
    return { valid: false, reason: "invalid_payment" };
  }

  // billingIdentifier is an arbitrary network identifier (e.g., account ID)
  // used by the network to rollup and bill charges for this signature agent
  return { valid: true, reason: null, billingIdentifier: agentInfo.billingIdentifier };
}
```

## Settlement

The network (Cloudflare) acts as Merchant of Record, aggregating payment commitments, billing the identity associated with each signature agent, and distributing revenue to content owners on a periodic basis through traditional off-chain financial rails.

## PAYMENT-RESPONSE Header

Upon successful verification, the server includes a PAYMENT-RESPONSE header (base64-encoded JSON) in the 200 OK response.

```http
HTTP/2 200 OK
Content-Type: text/html
PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IiIsIm5ldHdvcmsiOiJjbG91ZGZsYXJlOjQwMiIsInBheWVyIjoibXljcmF3bGVyLmNvbSIsImFtb3VudCI6IjUiLCJhc3NldCI6IlVTRCIsImV4dHJhIjp7InRpbWVzdGFtcCI6MTczMDg3Mjk2OH19

<!DOCTYPE html>
<html>
  <head><title>Premium Article</title></head>
  <body><article>Premium content...</article></body>
</html>
```

**Decoded PAYMENT-RESPONSE header:**

```json
{
  "success": true,
  "transaction": "",
  "network": "cloudflare:402",
  "payer": "mycrawler.com",
  "amount": "5",
  "asset": "USD",
  "extra": {
    "timestamp": 1730872968
  }
}
```

## Appendix

### Network-Specific Implementation

The network (Cloudflare) implements the `batch-settlement` scheme with the following details:

**Registration URL**: `https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-ai-owner/verify-ai-crawler/`

> **Note**: This URL is intended for human-driven setup and documentation. It provides instructions for the onboarding process including Web Bot Auth setup, verified bot policy compliance, and verification request submission. A programmatic API endpoint for automated registration may be provided in future versions.

This URL provides:

1. **Setup instructions**: How to submit your signature agent's `.well-known/http-message-signatures-directory` URL to the network
2. **Billing identity association**: How to associate your signature agent with a billing identity for settlement
3. **Public key requirements**: What public key formats and algorithms are supported
4. **Verification process**: How the network verifies HTTP Message Signatures

**Supported Tags**: `["web-bot-auth", "agent-browser-auth"]`

**Setup Process**:

1. Client hosts their public keys at a `.well-known/http-message-signatures-directory` endpoint (e.g., `https://mycrawler.com/.well-known/http-message-signatures-directory`)
2. Client submits this URL to the network via the network URL endpoint
3. The network associates the signature agent URL with a billing identity
4. Client can now sign requests using HTTP Message Signatures, with the `Signature-Agent` header pointing to their `.well-known/http-message-signatures-directory` URL
5. Resource servers verify signatures by fetching public keys from the `Signature-Agent` URL and validating the signature agent is known to the network

### Network Registration Terms

The following operational details are established during registration with the network (via `registrationUrl`) and are not part of the x402 protocol itself:

- **Settlement periods**: Frequency of billing cycles (e.g., daily, weekly)
- **Payment failure handling**: What happens if batched payments cannot be settled
- **Rate limits and quotas**: Usage restrictions per billing period
- **Dispute resolution**: Process for handling billing disputes

These terms may vary by account and are subject to the network's terms of service.

**Note**: For the full extension definition, see [`http-message-signatures`](../../extensions/http-message-signatures.md).

**Example HTTP Request with Message Signatures**:

```http
GET /article HTTP/2
Host: example.com
User-Agent: Mozilla/5.0 Chrome/113.0.0 MyCrawler/1.0
Signature-Agent: mycrawler.com
Signature-Input: sig=("@authority" "signature-agent" "payment-signature"); created=1700000000; expires=1700011111; keyid="ba3e64=="; tag="web-bot-auth"
Signature: sig=:abc123...==:

Payment-Signature: eyJ4NDAyVmVyc2lvbiI6IDIsIC4uLn0=
```

The `Signature-Agent` header indicates where to find the client's public keys (e.g., `mycrawler.com`). This URL must be known to the network (Cloudflare) and associated with a billing identity. The `registrationUrl` in the extension points to the network's documentation on how to associate your signature agent.

### Security Considerations

**HTTP Message Signature Verification**:

- All requests must be signed using HTTP Message Signatures (RFC 9421)
- The signature **MUST** include the following components:
  - `@authority`: The target server authority
  - `signature-agent`: The signature agent header value
  - `payment-signature`: The PAYMENT-SIGNATURE header (lowercase per RFC 9421)
- This ensures the payment commitment is cryptographically bound to the HTTP request
- Servers verify signatures by:
  1. Fetching the public key from the URL in the `Signature-Agent` header
  2. Validating the signature using the fetched public key
  3. Confirming the signature agent URL is known to the network (Cloudflare)

**Billing Identity Association**:

- The signature agent URL (from `Signature-Agent` HTTP header) must be known to the network (Cloudflare)
- The network maintains the association between signature agent URLs and billing identities with account IDs
- The signature agent is identified by the `Signature-Agent` header

**Stateless Verification**:

- Servers do not need to maintain payment state or track attempts
- All verification can be performed stateless by validating the signature and billing identity association
- No database lookups or session management required

### Error Codes

Error codes for batch-settlement payment failures on the Cloudflare network:

- `blocked`: Payment required to access resource
- `price_not_acceptable`: Payment amount does not match requirements
- `payment_failed`: Signature agent not associated with valid billing identity
- `invalid_signature`: Invalid or missing `Signature-Input` or `Signature` headers
- `signature_agent_unknown`: Signature agent not recognized by network (Cloudflare)
- `invalid_payment_signature`: Invalid or malformed `PAYMENT-SIGNATURE` header
- `origin_error`: Server error during payment processing
- `unknown`: Unknown error

### Pre-Authorized Access

Clients with pre-authorized payment agreements can include the PAYMENT-SIGNATURE header in their initial request, bypassing the 402 response:

```http
GET /article HTTP/2
Host: example.com
Signature-Agent: mycrawler.com
Signature-Input: sig=("@authority" "signature-agent" "payment-signature"); created=1700000000; expires=1700011111; keyid="ba3e64=="; tag="web-bot-auth"
Signature: sig=:abc123...==:

Payment-Signature: eyJ4NDAyVmVyc2lvbiI6MiwicGF5bG9hZCI6eyJhbW91bnQiOiIxMDAwMCIsImFzc2V0IjoiVVNEIn0sImFjY2VwdGVkIjp7Ii4uLiJ9fQ==
```

If the payment is valid, the server responds directly with `200 OK` and the requested content, skipping the 402 negotiation phase.

### Comparison with Exact Scheme

| Feature          | Exact + EVM/SVM                  | Batch-Settlement + Cloudflare           |
| ---------------- | -------------------------------- | --------------------------------------- |
| Settlement       | Immediate blockchain transaction | Batched off-chain settlement            |
| Transaction Fees | Gas fees required                | No transaction fees                     |
| Currency         | Cryptocurrency (USDC, etc.)      | Fiat (USD, etc.)                        |
| Infrastructure   | Blockchain wallet required       | Cloudflare account required             |
| Trust Model      | Trustless blockchain             | Trusted Merchant of Record (Cloudflare) |

### Network Version

The `extra.version` field uses semantic versioning (semver) to signal changes in network behavior. Clients should check this field to detect breaking changes.

**Changelog:**

| Version | Date    | Changes         |
| ------- | ------- | --------------- |
| `1.0.0` | 2026-01 | Initial release |