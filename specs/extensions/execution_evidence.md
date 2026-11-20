# Extension: `execution-evidence`

## Summary

The `execution-evidence` extension defines a canonical mechanism for cryptographically binding an on-chain x402 payment settlement to cryptographic evidence of digital resource delivery (content binding), counterparty-signed delivery receipts, and optional transparency log inclusion.

While the base x402 specification authenticates and settles value transfer between a client and a resource server, it does not normatively bind the settled transaction to the fulfilled response payload. In autonomous machine-to-machine interactions where no human is in the loop to initiate traditional payment disputes, this gap introduces two systemic challenges:

1. **Delivery Non-Repudiation**: A client cannot mathematically prove whether a paid resource server failed to deliver the promised payload or returned degraded/tampered data.
2. **Economic Wash-Trading Bounding**: Circular on-chain settlements between colluding wallets can generate artificial transaction volume on facilitator ledgers. Requiring verifiable delivery evidence allows downstream reputation and auditing systems to differentiate attested delivery from unevidenced volume.

This extension introduces canonical evidence reference identifiers (`x402ev/1`), canonical payload hashing (RFC 8785 JSON Canonicalization Scheme), counterparty-signed delivery receipts, and optional transparency log anchors (IETF SCITT / RFC 9162).

### Claim Ceiling and Trust Boundaries

The verification sequence defined in this extension establishes **settlement-bound delivery evidence and content integrity**; it proves that a resource server produced and signed a delivery claim over specific response bytes bound to a confirmed on-chain settlement transaction.

Verification of `x402ev/1` does **not** by itself establish:
- that claimed computation or AI inference was genuinely executed rather than served from cache, canned responses, or unverified processes;
- that delivered payload bytes satisfy the client's offer acceptance or semantic correctness criteria;
- that the delivery was independently witnessed or observed by third parties;
- that the evidence is authoritative for downstream state transitions.

Downstream systems MUST evaluate evidence within the explicit claim hierarchy:

```
OFFER_ACCEPTANCE_CRITERIA
  -> x402ev/1 EVIDENCE BINDING
    -> EVALUATION / RESOLUTION
      -> AUTHORIZED TRANSITION
```

Or expressed as claim ceilings:

`VALID_x402ev != CORRECT_DELIVERY != PROVEN_EXECUTION != AUTHORIZED_TRANSITION`

An evaluation record that claims to evaluate a particular `x402ev/1` receipt MUST name it by `evidenceRef`: `evaluation.subject.evidenceRef == verified_receipt.evidenceRef`. That equality establishes subject identity only. `VALID_x402ev` does not imply `VALID_EVALUATION`, and neither implies `CORRECT_DELIVERY`: the evaluator's proof, key and criteria, and the correctness of the delivery, are each separate claims.

*Informative*: A worked example of an evaluation record bound to an `x402ev/1` receipt by `evidenceRef`, built on this extension's own example receipt and including rejecting cases, is at https://github.com/babyblueviper1/preaction-governance-conformance/tree/5c7242878f8d105233a8f53248b52ee6499ac150/examples/x402ev-receipt-binding/evaluation-layer (pinned commit).

Proving genuine compute execution (e.g., AI model inference correctness, model weight integrity, or tamper-proof silicon processing) requires an orthogonal execution-attestation primitive (such as hardware enclave / TEE attestation quotes with silicon measurement registers) layered alongside the delivery receipt.

---

## `PaymentRequired`

A resource server advertises support for execution evidence in the `extensions` object of the **402 Payment Required** response.

The extension follows the standard v2 pattern:
- **`info`**: Declares evidence generation capabilities, supported hashing algorithms, and optional transparency log providers.
- **`schema`**: JSON Schema validating the structure of `info`.

### Example

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://api.example.com/v1/inference",
    "description": "Confidential AI inference endpoint"
  },
  "accepts": [ ... ],
  "extensions": {
    "execution-evidence": {
      "info": {
        "supported": true,
        "required": false,
        "schemes": ["x402ev/1", "vaara.receipt/v1"],
        "digestAlgorithms": ["sha256"],
        "transparencyLog": "https://scitt.example.org"
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "supported": { "type": "boolean" },
          "required": { "type": "boolean" },
          "schemes": {
            "type": "array",
            "items": { "type": "string" }
          },
          "digestAlgorithms": {
            "type": "array",
            "items": { "type": "string", "enum": ["sha256", "sha384", "sha512"] }
          },
          "transparencyLog": { "type": "string", "format": "uri" }
        },
        "required": ["supported", "schemes", "digestAlgorithms"]
      }
    }
  }
}
```

---

## `PaymentPayload`

When a client requests that execution evidence be emitted for the transaction, it includes the `execution-evidence` parameter in the `extensions` map of its `PaymentPayload`.

### Example

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/v1/inference"
  },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:8453"
  },
  "payload": { ... },
  "extensions": {
    "execution-evidence": {
      "info": {
        "requested": true,
        "scheme": "x402ev/1",
        "clientNonce": "d9f8c4e2a1b073e5"
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "requested": { "type": "boolean" },
          "scheme": { "type": "string" },
          "clientNonce": { "type": "string", "minLength": 8, "maxLength": 64 }
        },
        "required": ["requested", "scheme"]
      }
    }
  }
}
```

---

## `PaymentResponse` / Fulfillment Header

Upon successful settlement and resource generation, the resource server delivers the resource payload (HTTP `200 OK`) and emits the `x402-Execution-Evidence` header or returns the evidence object within `EXTENSION-RESPONSES`.

### Header Syntax

```http
x402-Execution-Evidence: uri="x402ev/1:sha256:de717d35f610e929f3b0a3e994aa8ea6aee27323f5bca3ee8156c243cbebe37c#scitt=entry_94821"; digest="sha256:cf819dc86288a4bf3362749bdd3c879b4bc3342fc17f61401dd5700d94eb9e71"; sig="base64url:3RXnMPbBmkjiOIqZ1FK4JV0iYkFze40WytG92yfiFcolgOzSMvvfqVeoJ_j2ILBOhcKERN45OoaM8s4EXLFbAw"
```

### Response Extension Object Shape

```json
{
  "extensions": {
    "execution-evidence": {
      "info": {
        "evidenceRef": "x402ev/1:sha256:de717d35f610e929f3b0a3e994aa8ea6aee27323f5bca3ee8156c243cbebe37c",
        "scheme": "x402ev/1",
        "canonicalization": "RFC8785",
        "payment": {
          "network": "eip155:8453",
          "txHash": "0x4a17c7e97752304fa5e2f9e76a830f75809f7d3a40b9d5e5d36c05dc7ce2decb",
          "payer": "0x857b06519e91e3a54538791bdbb0e22373e36b66",
          "payee": "0x209693bc6afc0c5328ba36faf03c514ef312287c",
          "amount": "10000",
          "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          "fingerprint": "sha256:15b452a978bae548c6ef71d40cc8824fe27bf01c2070fbd37bae6db83fc6ad53"
        },
        "request": {
          "method": "POST",
          "urlHash": "sha256:99913a6ff6cac19a02e7d9658195888603fabf33187f64009e9bb4afaad4604c",
          "payloadHash": "sha256:631919ab262b217a40a4efd6e32560dbeaf5390a791e1763541546dafa0adc7a",
          "clientNonce": "d9f8c4e2a1b073e5",
          "timestamp": 1791024000
        },
        "delivery": {
          "statusCode": 200,
          "contentDigest": "sha256:cf819dc86288a4bf3362749bdd3c879b4bc3342fc17f61401dd5700d94eb9e71",
          "contentType": "application/json",
          "latencyMs": 42,
          "timestamp": 1791024001
        },
        "signer": {
          "keyType": "Ed25519",
          "publicKey": "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
          "signature": "base64url:3RXnMPbBmkjiOIqZ1FK4JV0iYkFze40WytG92yfiFcolgOzSMvvfqVeoJ_j2ILBOhcKERN45OoaM8s4EXLFbAw"
        },
        "transparency": {
          "logId": "https://scitt.example.org",
          "entryNumber": 94821,
          "inclusionProof": "base64url:..."
        }
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "evidenceRef": { "type": "string" },
          "scheme": { "type": "string" },
          "canonicalization": { "type": "string", "enum": ["RFC8785"] },
          "payment": {
            "type": "object",
            "properties": {
              "network": { "type": "string" },
              "txHash": { "type": "string" },
              "payer": { "type": "string" },
              "payee": { "type": "string" },
              "amount": { "type": "string" },
              "asset": { "type": "string" },
              "fingerprint": { "type": "string" }
            },
            "required": ["network", "payer", "payee", "amount", "asset"]
          },
          "request": { "type": "object" },
          "delivery": { "type": "object" },
          "signer": { "type": "object" },
          "transparency": { "type": "object" }
        },
        "required": ["evidenceRef", "scheme", "canonicalization", "payment", "request", "delivery", "signer"]
      }
    }
  }
}
```

---

### Receipt Body and Canonical Preimage Derivation

To eliminate circular references and ensure evidence references and signatures remain deterministic and stable across the entire receipt lifecycle (including post-issuance transparency log anchoring), all digests and signatures are computed over the canonical **receipt body**:

1. **Receipt Body Definition (`body`)**:
   `body` is the `execution-evidence` `info` object with exactly these members removed: `evidenceRef`, `signer.signature`, and `transparency`. Every other member, including the `signer` object without `signature`, is part of `body`.

   Formally:
   $$\text{body} = \text{info} \setminus \{\text{evidenceRef}, \;\text{signer.signature}, \;\text{transparency}\}$$

2. **Evidence Reference Derivation (`evidenceRef`)**:
   `evidenceRef` MUST equal `"x402ev/1:sha256:" + lowercase-hex(SHA-256(JCS(body)))`. It identifies one settlement-bound delivery record. It MUST NOT be derived from `delivery.contentDigest` alone: two paid calls that return identical bytes have equal `contentDigest`s and distinct `evidenceRef`s.

3. **Signature Preimage**:
   `signer.signature` is over $\text{JCS}(\text{body})$. A verifier recomputes `body` and checks both `evidenceRef` and the signature against it. Attaching `transparency` after signing changes neither:
   $$\text{signature} = \text{Sign}_{K_{\text{server}}}\big(\text{JCS}(\text{body})\big)$$

4. **Payment Correlation (Optional)**:
   `payment.fingerprint`, when present, is `x402-payment-fingerprint/0` of the EIP-3009 authorization. It correlates records of one payment across buyer, seller, delivery receipt, and acceptance records; it does not establish settlement, which remains the `txHash` check in rule 3.

---

## Verification Rules

A client, auditor, or downstream reputation system MUST verify the execution evidence using the following four-stage validation sequence:

1. **Canonical Schema & Signature Verification**:
   - Construct the receipt `body` from `info` by omitting `evidenceRef`, `signer.signature`, and `transparency`.
   - Compute $\text{JCS}(\text{body})$ using RFC 8785.
   - Assert that `evidenceRef` equals $\text{"x402ev/1:sha256:"} + \text{lowercase-hex}\big(\text{sha256}(\text{JCS}(\text{body}))\big)$.
   - Verify `signer.signature` over $\text{JCS}(\text{body})$ against the resource server's authorized public key. The authorization mechanism for the server's public key MUST be resolved via an explicit external trust input (such as DNS TXT key publication under `_x402key.<domain>`, a declared PKI certificate chain, or a pre-established origin key registry); the extension does not assume unauthenticated or self-asserted keys.
   - Assert that `payer` and `payee` are distinct non-null entities.

2. **Delivery Content Integrity**:
   - Recompute the SHA-256 digest of the received response body bytes.
   - Assert that the recomputed digest matches `delivery.contentDigest` character for character.

3. **Settlement Binding Verification**:
   - If `payment.txHash` is provided, verify against the settlement ledger that the transaction confirmed with consensus finality and transferred the exact `amount` of `asset` from `payer` to `payee`.
   - If `payment.fingerprint` is provided, verify that the payment authorization matches the declared fingerprint.
   - Ensure `request.timestamp` and settlement timing fall within allowable clock skew windows (default: $\pm 300$ seconds).

4. **Transparency Log Inclusion (Optional / High-Assurance)**:
   - When `transparency` is populated, recompute the leaf hash over $\text{JCS}(\text{body})$ (or the canonical receipt) and verify the Merkle inclusion proof against the log's published signed tree head (STH).

---

## Security Considerations

- **Privacy Preservation**: Raw request parameters and response bodies are never published in public ledgers or shared logs. Only SHA-256 digests are anchored, preserving data confidentiality for proprietary enterprise payloads and HIPAA/GDPR-sensitive prompts.
- **Fail-Open Operational Model**: When requested as optional telemetry, evidence generation failure MUST NOT block delivery of the fulfilled digital resource.
- **Economic Cost Floor vs. Collusive Wash Trading**: Binding receipts to confirmed on-chain transactions between distinct payer and payee keys eliminates zero-cost receipt fabrication, establishing a deterministic economic floor (network transaction fees and settled capital lockup). However, confirmed on-chain settlement does not inherently prevent colluding wallets from wash trading. Downstream reputation, credit, and settlement systems MUST incorporate independent counterparty analysis and volume-weighting policies rather than treating valid `x402ev/1` receipts as definitive proof of non-collusive commercial activity.
