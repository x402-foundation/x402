# Extension: `compliance-fields`

## Summary

The merged `offer-receipt` extension gives x402 a cryptographic proof of payment, and stays deliberately privacy-minimal. What it does not give sellers is a record a tax authority, accountant, or auditor can consume — and those requirements are dated and near-term: EU member-state structured e-invoicing through 2026 (EN 16931 EU-wide under ViDA), Japan's Qualified Invoice System and Korea e-Tax (live), Hong Kong IRO s.51C record-keeping (7-year retention), US 1099-DA gross-proceeds context, MiCA Art 68(9) for CASP customers.

`compliance-fields` defines an OPTIONAL, signed **compliance record** that composes with the base receipt by digest reference. Sellers that ignore it lose nothing; sellers that emit it get machine-verifiable records their accountants and regulators already recognize.

Design principles:

1. **Never touches the offer-receipt schema.** The record binds to the receipt artifact by `receiptDigest`; the base EIP-712 types stay fixed.
2. **Micro-transaction-honest.** A MINIMAL tier isomorphic to the EU simplified-invoice content (VAT Directive Arts 220a/226b — ~5 fields, legally sufficient sub-€100), with EN 16931-aligned fields as an optional FULL tier.
3. **Vocabulary reuse, not invention.** EN 16931 business-term semantics; the adjustment enum ACP and UCP have converged on (`refund/return/credit/price_adjustment/dispute/cancellation` × `pending/completed/failed`).
4. **Corrections are chained.** Refund/correction records reference the original by digest (`refundOf`), matching ViDA's mandatory corrective-invoice reference; composes with `exact`, `auth-capture`, and `batch-settlement` refund flows.
5. **Attestation signs digests only** (fixed EIP-712 schema), so the record schema can evolve without breaking signatures — the same forward-compatibility approach as `offer-receipt`.

---

## `PaymentRequired`

Servers MAY advertise support:

```json
{
  "extensions": {
    "compliance-fields": {
      "info": {
        "tiers": ["minimal", "full"],
        "jurisdictions": ["EU-226b", "HK-51C"]
      }
    }
  }
}
```

## Response placement

On success, alongside the base receipt over the v2 extension-response path:

```
extensions["compliance-fields"].info = {
  record:      <ComplianceRecord>,   // JSON, schema below
  attestation: <SignedArtifact>      // EIP-712 or JWS
}
```

---

## `ComplianceRecord` (v1)

| Field | Type | Tier | Semantics (mandate basis) |
|---|---|---|---|
| `version` | int | M | `1` |
| `canonicalizationVersion` | int | M | `1` (see Canonicalization below) |
| `receiptDigest` | bytes32 hex | M | keccak256 of the canonicalized base receipt artifact (binding) |
| `issuedAt` | int (unix s) | M | issue date (Art 226(1)/226b(a); EN 16931 BT-2) |
| `seq` | int | F | sequential number per issuer (Art 226(2); EN 16931 BT-1) — assigned at counter-signature time by a ledger service when used |
| `correctionSeq` | int | F | position within a record's correction chain; inherits `seq`'s semantics, so an omitted correction is detectable on the same basis as an omitted record |
| `issuer.name` | string | M | supplier identity (Art 226b(b)) |
| `issuer.taxId` | string | F* | VAT ID / JP T-number / HK BR no. (*M where the jurisdiction mandates it) |
| `issuer.jurisdiction` | string | M | ISO 3166 + regime label |
| `buyer.principal` | string | F | the signed principal behind the paying agent (deployer / AP2 mandate subject) — never merely a wallet |
| `buyer.mandateRef` | bytes32 hex | F | hash of the AP2 Checkout/Payment Mandate, when the payment carried one |
| `supply.description` | string | M | nature of goods/services (Art 226b(c); BT-153/BT-154 class) |
| `lines[]` | array | F | description, quantity, unitPrice, net (Art 226(6)-(8)) |
| `tax.scheme` | enum `none/vat/gst/jct/sales` | M | tax regime marker |
| `tax.currency` | string | M | ISO 4217 |
| `tax.amount` | string | M unless `none` | tax payable or data to compute it (Art 226b(d); JP QIS per-rate rule) |
| `tax.breakdown[]` | array | F | per-rate `{rate, taxable, tax, category}` (Art 226(8)-(10)) |
| `settlement.fiat` | object | F | `{amount, currency, source, asOf}` — fiat-equivalent valuation at issuance (1099-DA gross-proceeds context) |
| `settlement.txHash` | string | F | on-chain settlement binding (ViDA "payment details") |
| `refundOf` | bytes32 hex | cond. | digest of the corrected/refunded record (Art 226b(e); ViDA corrective reference) |
| `adjustment` | object | cond. | ACP/UCP adjustment vocabulary verbatim |
| `retentionYears` | int | M | retention floor; RECOMMENDED default 7 (HK s.51C ≥ MiCA 5+2) |

### Tiers (normative)

**MINIMAL** = the M rows — deliberately isomorphic to the Art 226b simplified-invoice content: legally sufficient for sub-€100 supplies EU-wide, and a sane default for machine-to-machine micro-payments everywhere. **FULL** adds the EN 16931-aligned F rows.

MINIMAL/FULL are **legal thresholds** — determined by transaction value and jurisdiction under law. They are NOT verification-confidence levels and MUST NOT be mapped onto verification-depth scales: a €0.01 supply and a €50,000 supply can be verified to identical depth and still sit in different tiers, and conflating the two axes renders the record non-conformant in exactly the jurisdictions it exists to satisfy.

### Sequential numbering (normative)

Sequential numbering is a **completeness** control, not an ordering convenience — Art 226(2) exists so that a missing invoice is detectable by someone who is not the issuer, and record-retention regimes (HK IRO s.51C; SEC 17a-4; FINRA 4511) require the same property. Accordingly:

> A sequence that is assigned, held, and attested by the issuer of the records it numbers evidences ordering only. **Verifiers MUST NOT treat an issuer-attested sequence as evidence that no record was omitted.**

Who supplies non-issuer observation of a sequence is a service-layer question, intentionally out of scope for this spec.

### Existence and precedence (normative)

A signed record proves **integrity** — the bytes have not changed since signing — but not
**existence in time**: nothing inside a signature distinguishes a record emitted at transaction
time from one fabricated later and backdated. For audit use this matters exactly where
completeness does: retroactive fabrication and retroactive omission are the two halves of the
same failure. Accordingly:

> **Verifiers MUST NOT treat `issuedAt`, or the attestation signature over it, as evidence of
> when a record came into existence.**

Existence and precedence are established by **anchoring**: publishing a digest — the
`recordDigest` itself, or a commitment that includes it (such as a counter-signed sequence head
or batch root) — in a public, append-only timestamping mechanism (a blockchain, a transparency
log, an RFC 3161 authority). An anchor is a sibling fact *about* a digest, not a field inside
the record; nothing in the EIP-712 types changes. Anchor references MUST identify the mechanism
and carry (or point to) a proof independently verifiable against that mechanism; **verifiers
MUST NOT bind to any single anchoring mechanism** — a record anchored anywhere public and
append-only is anchored.

Anchoring composes with sequential numbering, and the composition is where completeness
survives: anchoring an individual `recordDigest` evidences the existence of *that record only* —
a party can anchor the records it keeps and omit the ones it doesn't, so **per-record anchors
MUST NOT be treated as evidence that no record was omitted.** Anchoring a commitment over an
issuer's full sequence (a head covering `seq` 1..N) yields existence *and* completeness in one
proof: every record with `seq ≤ N` is committed under the head, precedence is inherited, and a
gap is visible against `seq`.

Who operates anchoring is a service-layer question, intentionally out of scope for this spec.

### Canonicalization (normative)

`canonicalizationVersion: 1` = **RFC 8785 (JCS)** serialization; `recordDigest = keccak256(utf8(canonical(record)))`. Serialization and digest function are versioned **together**: `receiptDigest` binds the offer-receipt artifact and the attestation base is EIP-712 — both keccak256 — so changing either independently invalidates existing signatures.

Two implementations disagreeing on key order or number serialization produce different digests from the same record, silently breaking the `refundOf` chain. Byte-level cross-implementation conformance vectors — including the integer-like-key ordering case that sort-then-stringify implementations get wrong — are published with the reference implementation: [canonical-vectors.json](https://github.com/tersignhq/tersign-js/blob/main/test/fixtures/canonical-vectors.json), [compliance-record.json](https://github.com/tersignhq/tersign-js/blob/main/test/fixtures/compliance-record.json). Conformance is testable, not asserted.

---

## Attestation

The record is JSON and MAY evolve; the signature schema must not. The attestation signs digests only.

EIP-712 — domain `{name: "compliance-fields", version: "1", chainId: 1}` (constant chainId per the offer-receipt precedent), primaryType `ComplianceAttestation`:

```
ComplianceAttestation { uint256 version; bytes32 recordDigest; bytes32 receiptDigest; uint256 issuedAt }
```

JWS profile mirrors offer-receipt §3.3 (`alg`, `kid` DID URL). Signer authorization follows offer-receipt §4.5.1 (payTo-key or external registry). Verification: (1) recompute `recordDigest`, (2) match both digests, (3) recover/verify signer, (4) apply authorization policy.

Third parties MAY additionally counter-sign `(receiptDigest, prevDigest, seq)` chains to provide sequential-numbering, existence, and precedence guarantees and post-hoc verifiability; that service layer is intentionally out of scope for this spec.

## Refunds and corrections

A refund emits a NEW record with `refundOf` + `adjustment{type: refund, status, amount, currency, adjusts}`, signed like any record. Chains are walkable: original ← refundOf ← correction ← … This gives x402 a standard, auditable corrective-record shape without any new payment scheme.

## What this extension is NOT

- Not a tax-calculation engine; it carries fields, it does not compute rates.
- Not a filing/transmission channel (Peppol Access Points, KSeF, FR PDPs are certified infrastructure; out of scope).
- Not delivery proof — complementary to the SAR proposal (#1195) and the delivery-receipt attestation proposal (#2833); either's digest can ride along as a reference.
- Not identity — `buyer.principal` carries an attribution reference; verification of principals belongs to AP2 / ERC-8004-layer mechanisms.

## Prior art & standards referenced

EN 16931-1 (+ CEN/TS 16931-8:2024 e-receipt) · Peppol BIS Billing 3.0 (UBL 2.1) · VAT Directive 2006/112/EC Arts 220a/226/226b · ViDA Directive (EU) 2025/516 · JP Qualified Invoice System · KR e-Tax Invoice · HK IRO s.51C · IRS 1099-DA · MiCA Art 68(9) · RFC 8785 (JCS) · schema.org Invoice/Order · x402 `offer-receipt`, `payment-identifier`, SAR proposal (#1195).

## Reference implementation

TypeScript, MIT: [tersignhq/tersign-js](https://github.com/tersignhq/tersign-js) (`tersign` on npm). The reference implementation migrates its vendor EIP-712 domain to the canonical `compliance-fields` domain above when this spec merges.
