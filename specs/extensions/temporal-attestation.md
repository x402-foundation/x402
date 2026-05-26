# Extension: `temporal-attestation` (Draft)

## 1. Summary
The `temporal-attestation` extension provides a standardized mechanism for including cryptographically verifiable timestamps within x402 payment flows. This extension facilitates deterministic settlement ordering, prevents multi-resource replay attacks, and ensures protocol state consistency in high-latency environments.

## 2. Motivation
The core x402 protocol relies on relative timeout windows, which introduces ambiguity without a canonical temporal anchor. This extension addresses the following documented structural gaps:
- **Settlement Ambiguity (#1645)**: Lack of deterministic ordering for concurrent payment events.
- **Clock Skew Failures (#1062)**: State validation failures resulting from localized clock drift.
- **Replay Vulnerabilities (#1632)**: Reusability of authorization payloads within the active `maxTimeoutSeconds` window.

## 3. Specification

### 3.1. PaymentRequired Signaling
A Resource Server supporting this extension **MUST** include the `temporal-attestation` object within the `extensions` field of the HTTP 402 response.

```json
{
  "info": {
    "required": true,
    "minSources": 2,
    "maxDriftMs": 5000
  },
  "schema": { ... }
}
```

### 3.2. PaymentPayload Requirements
When generating the `PaymentPayload`, a participating Client **MUST** append the following fields to the `temporal-attestation` extension object:
- `timestampMs`: Integer. Unix epoch time in milliseconds, derived from consensus of specified sources.
- `nonce`: String. Cryptographically random high-entropy identifier (minimum 32 characters).
- `hmac`: String. `HMAC-SHA256(Secret_Key, Binding_Data)`.
- `sources`: Array of Strings. Identifiers of institutional or consensus time sources queried.

### 3.3. Key Management and Derivation
To ensure symmetric key agreement for the HMAC-SHA256 signature without exposing long-lived secrets, the `Secret_Key` **MUST** be derived from the established underlying session material or the client's asymmetric payment signing key using HKDF-SHA256.

- **Key Establishment**: The base `signing_key` is assumed to be securely exchanged out-of-band or established via the primary x402 transport handshake (e.g., ECDH over secp256k1).
- **Derivation Function**: `HMAC_KEY = HKDF-Expand(HKDF-Extract(salt="x402-temporal-v1", IKM=signing_key), info="temporal-binding", L=32)`
- **Key Rotation**: The `HMAC_KEY` is bound to the lifecycle of the `signing_key`. If the primary session or identity key rotates, the derived `HMAC_KEY` **MUST** be rotated concurrently.

### 3.4. Cryptographic Binding Data
The input message for the HMAC computation **MUST** be a strict concatenation of the following contextual parameters to prevent MITM and context-stripping attacks:
`timestampMs || nonce || resource.url || network || amount`

## 4. Verification Logic
Upon receiving the payload, the Facilitator or Resource Server **MUST** execute the following verification sequence:
1. **Drift Check**: Verify `|Server_Time - timestampMs| <= maxDriftMs`. Exceeding this boundary **MUST** result in a `400 Bad Request`.
2. **Replay Check**: The exact `(nonce, timestampMs)` tuple **MUST NOT** exist in the active session cache. Duplicates **MUST** result in a `409 Conflict`.
3. **Integrity Validation**: Reconstruct the binding data string locally and verify the HMAC. A mismatch **MUST** result in a `401 Unauthorized`.

## 5. Backward Compatibility and Fallback
To maintain interoperability with legacy x402 implementations:
- **Legacy Servers**: If a Client transmits the `temporal-attestation` extension to a Server that does not support it, the Server **SHOULD** ignore the unrecognized extension per the x402 v2 extensibility guidelines, processing the payment normally.
- **Legacy Clients**: If a Server advertises `temporal-attestation` as `"required": false`, legacy Clients **MAY** omit the extension. If `"required": true`, legacy Clients unable to construct the payload will gracefully fail to parse the requirements and abort the transaction.

## 6. Reference Implementation
- **NPM Package**: `openttt`
- **Interactive Verification Harness**: https://helm-protocol.github.io/x402-openttt/demo/
