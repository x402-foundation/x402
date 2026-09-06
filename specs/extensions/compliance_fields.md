# Extension: `compliance-fields`

## Summary

The merged `offer-receipt` extension gives x402 a cryptographic proof of payment, and stays deliberately privacy-minimal. What it does not give sellers is a record a tax authority, accountant, or auditor can consume — and those requirements are dated and near-term: EU member-state structured e-invoicing through 2026 (EN 16931 EU-wide under ViDA), Japan's Qualified Invoice System and Korea e-Tax (live), Hong Kong IRO s.51C record-keeping (7-year retention), US 1099-DA gross-proceeds context, MiCA Art 68(9) for CASP customers.

`compliance-fields` defines an OPTIONAL, signed **compliance record** that composes with the base receipt by digest reference. Sellers that ignore it lose nothing; sellers that emit it get machine-verifiable records built from the content vocabularies their accountants and auditors already work in. Whether any given tax authority, auditor, or venue accepts a particular record remains that party's decision; this extension defines content and verifiability, not acceptance.

Design principles:

1. **Never touches the offer-receipt schema.** The record binds to the receipt artifact by `receiptDigest`; the base EIP-712 types stay fixed.
2. **Micro-transaction-honest.** A MINIMAL tier isomorphic to the EU simplified-invoice content (VAT Directive Arts 220a/226b — ~5 fields, legally sufficient sub-€100), with EN 16931-aligned fields as an optional FULL tier.
3. **Vocabulary reuse, not invention.** EN 16931 business-term semantics; the adjustment vocabulary UCP publishes — `type` as an OPEN string whose typical values are `refund`/`return`/`credit`/`price_adjustment`/`dispute`/`cancellation`, and `status` as a fixed enum of `pending`/`completed`/`failed` (verified against the UCP order specification; only `status` is enumerated, and calling `type` an enum would overstate the convergence).
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
| `lines[]` | array | F | `{description, quantity, unitPrice, net}` — quantity, unitPrice, net are strings (Art 226(6)-(8)) |
| `tax.scheme` | enum `none/vat/gst/jct/sales` | M | tax regime marker |
| `tax.currency` | string | M | ISO 4217 |
| `tax.amount` | string | M unless `none` | tax payable or data to compute it (Art 226b(d); JP QIS per-rate rule) |
| `tax.breakdown[]` | array | F | per-rate `{rate, taxable, tax, category}` — rate, taxable, tax are strings (Art 226(8)-(10)) |
| `settlement.fiat` | object | F | `{amount, currency, source, asOf}` — amount is a string, asOf an int (unix s); fiat-equivalent valuation at issuance (1099-DA gross-proceeds context) |
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

Publishing records or sequence heads into a public log does not change this. Inclusion of a record in a log evidences that the record existed when it was included; cosignatures over that log's checkpoint, by however many independent parties, evidence that the log's own history is consistent. Neither speaks to the records the issuer never included. **Verifiers MUST NOT treat inclusion proofs or checkpoint cosignatures as a completeness attestation.** Completeness requires a non-party attestation over the sequence itself, made when the records were issued; a party that cosigns a log the issuer writes to is not attesting the issuer's sequence.

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
issuer's full sequence (a head covering `seq` 1..N) yields existence *and* — where that head is
attested by a non-party, per the sequential-numbering rule above — completeness in one
proof: every record with `seq ≤ N` is committed under the head, precedence is inherited, and a
gap is visible against `seq`.

Who operates anchoring is a service-layer question, intentionally out of scope for this spec.

### Independence and economic phase (normative)

Attestation by the parties to a transaction proves **structure** — that these facts were
composed and signed together — not **independence**: a record composed, role-tagged, and
attested entirely by the payer, the payee, or their operators proves the shape those parties
assert, not that an outside observer would concur. Accordingly:

> **Evaluators MUST NOT treat a record attested only by parties to the transaction (or their
> delegates) as an independent or neutral finding.**

An independence claim is also scoped by commitment: **evaluators MUST NOT read an independence
claim as covering any fact the record does not itself commit to.** A record whose committed
content is a settlement digest carries, at most, independent evidence *of that settlement* —
nothing its attestation did not cover, however independent the attestor.

The independence test compares **party identity**, so it is only as strong as the identity
comparison beneath it. Identifiers MUST be normalized before comparison, and the normalization
MUST fold toward *same party*: an attestor whose identifier differs from a party's only by
surrounding whitespace, letter case, an EIP-55 checksum variant, or trailing punctuation (`/`,
`.`, `#`) is that party. An identifier that does not parse after normalization is not
evaluable, and **evaluators MUST NOT treat an attestation carrying an unparseable identifier as
outside the transaction's parties** — the claim fails closed. Without this, a party relabels
itself as "outside the transaction" by appending a space or an invisible format character to its
own address, and the disqualification above is satisfiable by editing one byte. The rule does not
define any scheme's equivalence semantics beyond these folds (percent-encoding, for example, is
deliberately not decoded — an open-ended normalizer is its own attack surface); where two
identifiers *might* denote one party, the evaluator MUST treat them as one.

Who supplies non-party attestation is a service-layer question, intentionally out of scope
for this spec.

A compliance record also evidences a specific **economic phase**. Payment flows decompose
into distinct phases — funding, delivery, settlement, and where applicable refund or
reversal — with different legal consequences, and a record of one phase says nothing about a
later one. Accordingly:

> **Verifiers MUST NOT treat a record evidencing one economic phase as evidence of any later
> phase** — a funding receipt is not delivery evidence; a delivery attestation is not
> settlement.

### Canonicalization (normative)

`canonicalizationVersion: 1` = **RFC 8785 (JCS)** serialization; `recordDigest = keccak256(utf8(canonical(record)))`. Serialization and digest function are versioned **together**: `receiptDigest` binds the offer-receipt artifact and the attestation base is EIP-712 — both keccak256 — so changing either independently invalidates existing signatures.

**Numbers (normative).** The only members that MAY be JSON numbers are the ones declared `int` above (`version`, `canonicalizationVersion`, `issuedAt`, `seq`, `correctionSeq`, `retentionYears`, `settlement.fiat.asOf`); each is an exact integer well inside IEEE 754's exactly-representable range, which every RFC 8785 implementation serializes identically. Every member carrying a monetary amount, tax rate, or quantity — `lines[].quantity`, `lines[].unitPrice`, `lines[].net`, `tax.amount`, `tax.breakdown[].rate`, `tax.breakdown[].taxable`, `tax.breakdown[].tax`, `settlement.fiat.amount` — is a **decimal string** matching `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$` (no exponent notation). `adjustment` reuses the ACP/UCP vocabulary verbatim; whatever that vocabulary declares, the rule below still binds.

> **A record containing a non-integer JSON number anywhere is non-conformant. Verifiers MUST reject it before computing `recordDigest`.**

This is not stylistic. RFC 8785 §3.2.2.3 serializes JSON numbers through ECMAScript `Number::toString` over IEEE 754 doubles, so a decimal amount emitted as a JSON number is re-interpreted as the nearest double *before canonicalization runs* — the digest binds a value the issuing system never held, even when two implementations agree on the bytes — and imperfect `Number::toString` implementations additionally produce byte-divergent forms of the same record. RFC 8785 §3.1 itself RECOMMENDS representing such values as JSON strings (Appendix D). Strings cross canonicalization byte-for-byte; the x402 base specification already carries every amount as a string of atomic units. Integer minor units remain conformant where a vocabulary defines an atomic unit — they are exact integers — but rates and quantities have no minor unit, so decimal strings are the uniform rule here.

Two implementations disagreeing on key order or number serialization produce different digests from the same record, silently breaking the `refundOf` chain. Conformance is testable, not asserted — an implementation MUST reproduce these vectors:

| input | canonical form | `recordDigest` |
|---|---|---|
| `{"b":"x","a":1}` | `{"a":1,"b":"x"}` | `0x84fc3d9faf736ddfdb9baab9973656bd8d9bd142f1dfff8aa513a774fddfdd04` |
| `{"10":"a","2":"b","1":"c"}` | `{"1":"c","10":"a","2":"b"}` | `0x426b770f81b8ad5e307bcfb767deb02f8d32cd340d81a946be88bb184857e81b` |
| `{"tax":{"amount":"1.10"},"issuedAt":1735689600}` | `{"issuedAt":1735689600,"tax":{"amount":"1.10"}}` | `0x81086b5801b1bfd992e4d1e929f54907e0d3be0e8ede94f1da1a954b4e78b250` |

The second vector is load-bearing: RFC 8785 orders keys by UTF-16 code unit, so `"1" < "10" < "2"`. A sort-then-stringify implementation whose runtime hoists integer-like keys into numeric order emits `{"1":"c","2":"b","10":"a"}` and produces a different digest from the same record. A vector with only non-numeric keys cannot catch this class.

The third vector is the number boundary. `1735689600` is an exact integer — the only number class the record admits — and `"1.10"` is a decimal string. A pipeline that coerces numeric-looking strings into numbers re-emits `1.1` (the float round-trip drops the trailing zero), producing different bytes and a different digest: it fails the vector instead of diverging silently. Float emission itself is excluded at the type layer above — a vector cannot make IEEE 754 re-interpretation safe, only detect it. The digest was cross-checked on two unrelated stacks (viem and Python `eth_utils`) before pinning, both of which also reproduce the two vectors above.

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

## Implementation status

An MIT-licensed TypeScript implementation exists and migrates its pre-standard EIP-712 domain to the canonical `compliance-fields` domain above on merge. The spec is self-contained: the canonicalization vectors above are sufficient to implement and test conformance without it.
