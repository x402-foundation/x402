# Hive Nanopay — x402 Extension

**Version:** v1.0.0  
**Status:** Draft  
**Spec:** https://github.com/srotzin/nanopay-spec/blob/main/nanopay-v1.md  
**Reference Implementation:** https://hivemorph.onrender.com  

---

## Overview

Hive Nanopay is a two-tier extension to the x402 payment protocol. It adds post-quantum signatures and cross-rail receipts to the standard x402 negotiation flow.

**Tier 1 — PQ (default):** Ed25519 + ML-DSA-65 (FIPS 204) + SLH-DSA-PURE-SHAKE-256F (FIPS 205) under an all-of-three EUF-CMA combiner. Floor: $0.0003 per receipt.

**Tier 2 — Lite (opt-in):** EIP-3009 + Ed25519 + Merkle batch root. One PQ signature amortized over up to 10,000,000 positions per Merkle root. Floor: $0.000001 per receipt.

Both tiers issue receipts that are structurally compatible with x402. The PQ tier is the default for all x402-compatible requests that do not carry the tier opt-in header.

---

## Tier Negotiation Header

Clients opt into Tier 2 (lite) by including the following request header:

```
X-Hive-Nanopay-Tier: lite
```

Absent = PQ default (Tier 1). Any value other than `lite` is treated as absent.

The lite tier preserves byte-identical x402 default behavior for non-Hive clients: the response is a well-formed payment receipt with a standard Ed25519 signature. Non-Hive verifiers that do not understand the ML-DSA-65 and SLH-DSA fields may ignore them without breaking the x402 flow.

---

## Cross-Rail Receipts

A Hive Nanopay receipt is a single x402-compatible envelope whose `rails[]` array spans multiple settlement networks. A single payment proof covers:

- Base USDC (`base-usdc`)
- Base USDT (`base-usdt`)
- Solana USDC (`solana-usdc`)
- Solana USDT (`solana-usdt`)
- Ethereum USDT (`ethereum-usdt`)
- Arc USDC (`arc-usdc`) — planned, Day 1 Arc Mainnet

The verifier does not need to know which rail was used in advance. Each rail entry in the receipt contains a `proof` sub-object with a `proof_hash` that links to the on-chain or pre-auth evidence for that rail.

Receipt verification endpoint:

```
POST https://hivemorph.onrender.com/v1/nanopay/cross-rail/verify
```

Body: a full receipt JSON. Response: `{ok, hash_match, envelope_present, rails_in_receipt, demo_mode}`.

---

## Reference Implementation

Live at: https://hivemorph.onrender.com

- `GET /v1/nanopay/bench` — live counters, tier table, rails, PQ coverage
- `POST /v1/nanopay/cross-rail` — issue a cross-rail receipt (PQ or lite)
- `POST /v1/nanopay/cross-rail/verify` — verify a receipt
- `GET /v1/nanopay/standard` — spec metadata JSON

4,120+ receipts shipped. 100% PQ coverage. 5 active rails.

Quick-start:

```bash
curl -s https://hivemorph.onrender.com/v1/nanopay/bench | jq

curl -s -X POST https://hivemorph.onrender.com/v1/nanopay/cross-rail \
  -H "Content-Type: application/json" \
  -d '{"rails":["base-usdc","solana-usdc"],"amount_usd":0.0003}' | jq
```

---

## Full Specification

https://github.com/srotzin/nanopay-spec/blob/main/nanopay-v1.md

Sections: Abstract, Motivation, Terminology, Pricing Model, PQ Receipt Envelope (full JSON schema), Lite Receipt Envelope, Cross-Rail Receipts (rail table + proof schema), HTTP Surface (exact endpoint contracts), Compliance Mapping (MiCA / DORA / EU AI Act / NSM-10), Security Considerations, x402 Compatibility, Reference Implementation.

---

## Compatibility Notes

1. Hive Nanopay does not modify the x402 HTTP 402 response structure. It adds an optional request header (`X-Hive-Nanopay-Tier`) and an optional envelope extension (PQ signatures, `batch_root`, `batch_index` fields).
2. Servers that do not understand the Hive Nanopay extension ignore the opt-in header and see a standard x402 payment receipt.
3. The lite tier's Ed25519 signature is structurally identical to what a plain x402 client expects; the Merkle fields are additive.
4. Canonical hash computation (`sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")))`) is identical at issuance and verification, ensuring deterministic receipt verification across independent implementations.
