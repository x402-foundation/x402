# Attestation Binding (Optional Extension)

**Status:** Non-normative guidance (docs-only)  
**Scope:** Compatible with x402 V1 without changing `X-PAYMENT` or facilitator APIs.

---

## Why
Some sellers want stronger guarantees about *what* was requested, *under which terms* it was accepted, and *who/what decided* to proceed (e.g., an AI agent with a zk/attested policy).  
This extension shows how to bind three hashes to an x402 payment flow while keeping the core protocol unchanged. See V1 overview and types in the root README.

---

## The Three Bindings
- **`intentHash`** — Canonical hash of the exact HTTP intent: method, path, query, and (if present) the request body after stable JSON canonicalization.  
- **`acceptsHash`** — Canonical hash of the `paymentRequirements` object the server offered in the `402` response (serialize with a stable field order; include `scheme`, `network`, `asset`, `maxAmountRequired`, `payTo`, `extra`, etc.).  
- **`proofHash`** — Hash of external authorization evidence (e.g., a signed statement, TEE/SGX quote, or zk proof bytes) that the client/agent satisfied the seller's policy.

> **Canonicalization hint:** Use UTF-8 bytes of lowercased `METHOD SP PATH?QUERY LF` followed by `Content-Type:` and normalized JSON with sorted keys and trimmed whitespace, then `keccak256(...)`.

---

## Transport Options
1. **Companion header (recommended)**  
   `X-PAYMENT-ATTESTATION: base64json({intentHash, acceptsHash, proofHash, algo:"keccak256"})`

2. **Attestation URL**  
   Include `attestationUri` in your resource server state/logic (not part of `X-PAYMENT`). Client POSTs the attestation to the seller before `/settle`.

3. **Out-of-band, server-only**  
   Seller derives `intentHash` and `acceptsHash` locally; client only supplies `proofHash`.

---

## Verification Steps (seller)
1. On 402 challenge, persist the exact `paymentRequirements` you sent.  
2. When a paid request arrives:  
   - Recompute `intentHash` from the *actual* request.  
   - Recompute `acceptsHash` from the persisted `paymentRequirements`.  
   - Validate `proofHash` (e.g., verify signature/TEE/zk).  
   - If all good, call `/verify` with the original `paymentRequirements` and received `X-PAYMENT`.  
   - If valid, fulfill the request, then `/settle` (optionally after anchor confirmation).

---

## Example
```json
{
  "intentHash": "0x…",
  "acceptsHash": "0x…",
  "proofHash": "0x…",
  "algo": "keccak256"
}
```

---

## Security Considerations

* Bind to the canonical path **and** the normalized body; reject mismatched hashes.
* Expire attestations (nonce + timestamp).
* Treat this as app-layer integrity; do **not** modify core x402 headers or types.

---

## Interoperability

This extension is entirely **optional**.

* It does **not** modify `X-PAYMENT`, `X-PAYMENT-RESPONSE`, `/verify`, or `/settle`.
* Sellers and clients MAY ignore it and remain fully x402 V1-conformant.
* Implementations that adopt it gain additional auditability.

---

## References

* [x402 README](../../README.md) — V1 flow, types, and facilitator endpoints
