# Scheme: `contingent` on `EVM`

**Status:** Draft 0 — proposed for discussion. Not implemented; conformance vectors not yet pinned. Parent spec: `scheme_contingent.md`.

## Summary

EVM instantiation of `contingent` over **EIP-3009** (`transferWithAuthorization`, USDC-style assets). The client produces an **ECDSA adaptor pre-signature** over the EIP-712 typed data of a standard EIP-3009 authorization, locked to the server's key commitment. The server completes it into a **standard ECDSA signature** — from that point the pipeline is the stock `exact` EIP-3009 path. The contract sees nothing new.

## AssetTransferMethod: `EIP-3009`

### Phase 1: Quote

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/analyze" },
  "accepts": [
    {
      "scheme": "contingent",
      "network": "eip155:8453",
      "amount": "10000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x1234...abcd",
      "maxTimeoutSeconds": 300,
      "extra": {
        "adaptor": "ecdsa-secp256k1-v1",
        "binding": "keccak256-plaintext",
        "quoteId": "q_7f3a9c...",
        "delivery": "inline"
      }
    }
  ]
}
```

- `extra.adaptor` pins the exact adaptor-signature construction. ECDSA adaptors have known pitfalls in naive constructions; the versioned identifier plus conformance vectors are the contract.
- `extra.quoteId` is the server's binding handle for this quote. Where an origin manifest exists (`/.well-known/x402.json`), `quoteId` SHOULD also commit to the manifest version, giving agents the invariant *"never authorize spend from a 402 body alone."*

### Phase 2: Offer (execute-then-lock)

The server executes the request, samples scalar `t`, and responds `402`:

```json
{
  "x402Version": 2,
  "accepts": [ { "...": "same terms as quote, same quoteId" } ],
  "extensions": {
    "contingentOffer": {
      "quoteId": "q_7f3a9c...",
      "keyCommitment": "0x02a1b2...",
      "ciphertext": "base64...",
      "bindingCommitment": "0x9e8d...",
      "offerValidUntil": 1783123456
    }
  }
}
```

- `ciphertext = AEAD-Enc(HKDF(t), plaintextResponse)`
- `keyCommitment = t·G` on secp256k1
- `bindingCommitment = keccak256(plaintextResponse)`. Richer bindings (schema hash, output-commitment trees) are an extension point.
- For large payloads, `delivery: "url"` replaces `ciphertext` with a fetch URL; the commitment covers the fetched bytes.

The server has now fully delivered — in locked form — and holds no claim on funds.

### Phase 3: Accept (PaymentPayload)

```json
{
  "x402Version": 2,
  "accepted": { "scheme": "contingent", "...": "..." },
  "payload": {
    "preSignature": "0x...",
    "dleqProof": "0x...",
    "authorization": {
      "from": "0xClient...",
      "to": "0x1234...abcd",
      "value": "10000",
      "validAfter": "1783123000",
      "validBefore": "1783123456",
      "nonce": "0x..."
    }
  }
}
```

Two deltas from `exact`:

1. **`preSignature` replaces `signature`** — an ECDSA adaptor pre-signature over the EIP-712 typed data of the EIP-3009 authorization, locked to `keyCommitment`, with a DLEQ proof of well-formedness and completability.
2. **The nonce is a cryptographic binding, not a random value:**

```
nonce = keccak256(quoteId ‖ keyCommitment ‖ bindingCommitment ‖ resource.url ‖ chainId)
```

This single field enforces the quote-binding invariant end-to-end: the authorization is only completable for *this* offer, *this* price, *this* recipient, *this* resource. Any drift produces a different nonce and the pre-signature fails closed. EIP-3009's on-chain nonce consumption then guarantees at-most-once settlement with no additional infrastructure.

### Phase 4: Verification

Facilitators MUST:

1. Verify the DLEQ proof and pre-signature completability against `keyCommitment`.
2. Recompute the nonce binding from the offer fields and reject on mismatch.
3. Apply the standard `exact`/EIP-3009 checks: recovered signer funds check, `value` ≤ quoted amount, `validAfter`/`validBefore` window, asset and `payTo` match.

### Phase 5: Settlement

Server completes: `signature = Complete(preSignature, t)` — a standard ECDSA signature valid for `transferWithAuthorization`. From here the pipeline is the stock `exact` path.

The `SettlementResponse` MUST echo the completed signature:

```json
{
  "success": true,
  "transaction": "0x...",
  "network": "eip155:8453",
  "extensions": { "contingent": { "completedSignature": "0x..." } }
}
```

This keeps the scheme **batch-settlement compatible**: batching can aggregate transfers so individual signatures never appear in calldata, which would break chain-side key extraction. The echoed signature is the primary extraction channel; the chain remains the fallback when the server settles directly.

The server's `200 OK` PAYMENT-RESPONSE SHOULD additionally include `t` and the plaintext inline as a fast path; the completed signature remains the trustless channel.

## Security Invariants & Conformance Cases

Every case below MUST pin a conformance vector before this spec leaves draft:

| # | Case | Required outcome |
|---|------|------------------|
| 1 | Happy path: offer → accept → settle | Settles exactly once (EIP-3009 nonce); client extracts `t = Extract(completedSignature, preSignature)`; `keccak256(plaintext) == bindingCommitment` |
| 2 | Upstream 5xx / timeout / crash before offer | No offer ⇒ no pre-signature ⇒ nothing is settleable. No discard step, no refund, no state |
| 3 | Pre-signature replayed against different resource / amount / payee / quote | Nonce binding mismatch ⇒ completion invalid ⇒ rejected at verification and on-chain |
| 4 | Server crash after receiving pre-signature | Nothing settled; authorization dies at `validBefore`; client re-requests under a fresh quote |
| 5 | Server settles but withholds `t` | Client extracts `t` from calldata or the echoed `completedSignature`. Settled ⇒ key available to the pre-signature holder |
| 6 | `offerValidUntil` passes before accept | Client MUST NOT sign; server MUST NOT complete a stale authorization (`validBefore` enforces on-chain) |
| 7 | Decrypted plaintext ≠ `bindingCommitment` | Provable misdelivery: ciphertext + commitment + settlement receipt form a self-contained evidence bundle for receipt/arbitration layers |

## Implementer Notes

- **Extraction privacy:** with ECDSA adaptors, `t` is recoverable only by holders of the pre-signature — i.e., the client — not by chain observers. Third parties learn nothing.
- **ECDSA adaptor subtlety:** pre-signature validity requires the DLEQ proof; naive constructions are known-broken. Implementations MUST target the pinned `ecdsa-secp256k1-v1` construction and its vectors, once published. A Schnorr variant is cleaner and SHOULD follow wherever the rail supports it.
- **Out of scope:** correctness of the plaintext beyond the hash binding (see parent spec).
