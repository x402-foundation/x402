# Extension: `hardware-attestation`

## Summary

The `hardware-attestation` extension enables resource servers and settlement facilitators to cryptographically prove that their runtime execution, private signing keys, and client compute workloads are physically isolated inside a **Confidential Hardware Enclave** (such as Intel TDX, AMD SEV-SNP, AWS Nitro Enclaves, or ARM CCA).

In decentralized and autonomous machine-to-machine commerce:
1. **Key Extraction Immunity**: Autonomous AI agents moving financial value require mathematical certainty that counterparty private keys cannot be dumped from host RAM by malicious infrastructure providers, hypervisor administrators, or physical memory bus taps.
2. **Deterministic Execution Guarantees**: Clients executing proprietary code or private AI inference require hardware-rooted proof that the code running matches the advertised binary digest without runtime telemetry injection or prompt harvesting.
3. **Facilitator Non-Custodial Integrity**: When routing high-value settlements, facilitators can prove via silicon quotes that their matching logic and balance tracking execute within a tamper-proof isolated environment with non-custodial invariants.

This extension defines standardized parameters for advertising, requesting, and verifying hardware-rooted silicon quotes and measurement registers.

---

## `PaymentRequired`

A resource server or facilitator advertises hardware enclave capabilities in the `extensions` object of the **402 Payment Required** response.

### Example

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://api.example.com/v1/confidential-compute",
    "description": "Hardware-Attested Confidential Compute Service"
  },
  "accepts": [ ... ],
  "extensions": {
    "hardware-attestation": {
      "info": {
        "supported": true,
        "required": false,
        "enclaveArchitectures": ["intel-tdx", "amd-sev-snp", "aws-nitro"],
        "measurements": {
          "rtmr0": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          "rtmr1": "4a8b7f2d1e9c8b3a7f0e2d4c6b8a1e3f5d7c9b1a3e5f7d9c1b3a5f7d9c1b3a5f",
          "rtmr2": "b5a2c6d8e0f14a8b7f2d1e9c8b3a7f0e2d4c6b8a1e3f5d7c9b1a3e5f7d9c1b3a",
          "rtmr3": "94821a3e5f7d9c1b3a5f7d9c1b3a5f4a8b7f2d1e9c8b3a7f0e2d4c6b8a1e3f5d"
        },
        "verificationEndpoint": "https://attestation.example.com/verify"
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "supported": { "type": "boolean" },
          "required": { "type": "boolean" },
          "enclaveArchitectures": {
            "type": "array",
            "items": { "type": "string", "enum": ["intel-tdx", "amd-sev-snp", "aws-nitro", "arm-cca", "apple-sep"] }
          },
          "measurements": {
            "type": "object",
            "properties": {
              "rtmr0": { "type": "string" },
              "rtmr1": { "type": "string" },
              "rtmr2": { "type": "string" },
              "rtmr3": { "type": "string" },
              "mrtd": { "type": "string" }
            }
          },
          "verificationEndpoint": { "type": "string", "format": "uri" }
        },
        "required": ["supported", "enclaveArchitectures"]
      }
    }
  }
}
```

---

## `PaymentPayload`

When a client requires that a transaction be executed strictly within a certified hardware enclave, it specifies its hardware policy constraint in the `PaymentPayload`.

### Example

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/v1/confidential-compute"
  },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:8453"
  },
  "payload": { ... },
  "extensions": {
    "hardware-attestation": {
      "info": {
        "requireAttestation": true,
        "acceptableArchitectures": ["intel-tdx", "amd-sev-snp"],
        "clientChallengeNonce": "f9a8b7c6d5e4f3a2"
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "requireAttestation": { "type": "boolean" },
          "acceptableArchitectures": {
            "type": "array",
            "items": { "type": "string" }
          },
          "clientChallengeNonce": { "type": "string", "minLength": 16, "maxLength": 64 }
        },
        "required": ["requireAttestation", "acceptableArchitectures", "clientChallengeNonce"]
      }
    }
  }
}
```

---

## `PaymentResponse` / Fulfillment Verification

When hardware attestation is fulfilled, the server returns the raw silicon quote or attestation token either via the `x402-Attestation-Quote` header or inside `EXTENSION-RESPONSES`.

### Header Syntax

```http
x402-Attestation-Quote: architecture="intel-tdx"; quote="base64url:..."; nonce="f9a8b7c6d5e4f3a2"
```

### Response Extension Object Shape

```json
{
  "extensions": {
    "hardware-attestation": {
      "info": {
        "architecture": "intel-tdx",
        "quoteFormat": "tdx-quote-v4",
        "rawQuote": "base64url:AwACAAAAAA...",
        "measurements": {
          "mrtd": "4a8b7f2d...",
          "rtmr0": "e3b0c442...",
          "rtmr1": "4a8b7f2d...",
          "rtmr2": "b5a2c6d8...",
          "rtmr3": "94821a3e..."
        },
        "reportData": "f9a8b7c6d5e4f3a2...",
        "attestationProvider": "Intel PCS"
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "architecture": { "type": "string" },
          "quoteFormat": { "type": "string" },
          "rawQuote": { "type": "string" },
          "measurements": { "type": "object" },
          "reportData": { "type": "string" },
          "attestationProvider": { "type": "string" }
        },
        "required": ["architecture", "quoteFormat", "rawQuote", "reportData"]
      }
    }
  }
}
```

---

## Verification Sequence

Clients or verifiers evaluate the attestation quote using standard silicon root-of-trust workflows:

1. **Cryptographic Quote Validation**:
   - Extract the platform certificate chain from the quote.
   - Verify the signature against the manufacturer's root certificate (e.g. Intel SGX/TDX Root CA or AMD KDS).
   - Confirm the certificate revocation list (CRL) and Trusted Computing Base (TCB) recovery status.

2. **Nonce Freshness Binding**:
   - Verify that the first 32/64 bytes of `reportData` embed the client's `clientChallengeNonce` (or a SHA-256 hash of the client request + nonce).
   - This prevents quote replay attacks across different HTTP sessions.

3. **Measurement Register Matching**:
   - Compare the quote's embedded measurement registers (`MRTD`, `RTMR0-3` for TDX, or `launch_measurement` for SEV-SNP) against the known, published golden image digests for the authorized runtime.

---

## Security Considerations

- **Adversarial Host Containment**: Even with root privileges on the physical host machine, a malicious operator cannot snoop or mutate variables in encrypted enclave RAM (protected by AES-128/256 memory encryption engines such as Intel MKTME or AMD SME).
- **Side-Channel Mitigation**: Implementers must ensure enclave runtimes apply constant-time cryptographic primitives to mitigate cache-timing and microarchitectural side channels.
- **Fail-Closed Policy Enforcement**: If a client marks `requireAttestation: true` and the server cannot generate a verified quote, the client MUST reject the connection and abort payment settlement.
