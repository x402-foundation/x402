# Extension: `compliance-fields`

## Summary

The merged `offer-receipt` extension gives x402 a cryptographic proof of payment, and stays deliberately privacy-minimal. What it does not give sellers is a record a tax authority, accountant, or auditor can consume — and those requirements are dated and near-term: EU member-state structured e-invoicing through 2026 (EN 16931 EU-wide under ViDA), Japan's Qualified Invoice System and Korea e-Tax (live), Hong Kong IRO s.51C record-keeping (7-year retention), US 1099-DA gross-proceeds context, MiCA Art 68(9) for CASP customers.

`compliance-fields` defines an OPTIONAL, signed **compliance record** that composes with the base receipt by digest reference. Sellers that ignore it lose nothing; sellers that emit it get machine-verifiable records built from the content vocabularies their accountants and auditors already work in. Whether any given tax authority, auditor, or venue accepts a particular record remains that party's decision; this extension defines content and verifiability, not acceptance.

Design principles:

1. **Never touches the offer-receipt schema.** The record binds to the receipt artifact by `receiptDigest`; the base EIP-712 types stay fixed.
2. **Micro-transaction-honest.** A MINIMAL tier isomorphic to the EU simplified-invoice content (VAT Directive Art 226b — ~5 fields), usable where the invoicing rules that apply to the supply permit a simplified invoice, with EN 16931-aligned fields as an optional FULL tier.
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
| `seq` | int | F* | sequential number per issuer (Art 226(2); EN 16931 BT-1), assigned by the issuer before the record is attested (*M where the invoicing rules that apply to the supply require it, as they do for every full invoice) |
| `correctionSeq` | int | F | position within a record's correction chain; inherits `seq`'s semantics, so an omitted correction is detectable on the same basis as an omitted record |
| `issuer.name` | string | M | supplier identity (Art 226b(b)) |
| `issuer.taxId` | string | F* | VAT ID / JP T-number / HK BR no. (*M where the jurisdiction mandates it) |
| `issuer.jurisdiction` | string | M | ISO 3166 + regime label |
| `issuer.address` | object | F* | supplier postal address (Art 226(5); EN 16931 BG-5): `{line1, line2, line3, city, postCode, subdivision, country}`, all strings (BT-35, BT-36, BT-162, BT-37, BT-38, BT-39); `country` is required, ISO 3166-1 alpha-2 (BT-40) (*M where the jurisdiction mandates it, e.g. DE § 33 UStDV) |
| `buyer.principal` | string | F | the signed principal behind the paying agent (deployer / AP2 mandate subject) — a party, never merely a wallet or signing key. The paying account is whichever account the base receipt's `payer` identifies (this extension does not decide which account that is for a delegated or smart-account payment), bound through `receiptDigest`; where present, `settlement.txHash` binds the record to its settlement transaction; the buyer's tax identity is `buyer.taxId` |
| `buyer.mandateRef` | bytes32 hex | F | hash of the AP2 Checkout/Payment Mandate, when the payment carried one |
| `buyer.name` | string | F* | customer full name (Art 226(5); BT-44), as supplied by the buyer (*M where the invoicing rules that apply to the supply require it, as they do for every full invoice) |
| `buyer.address` | object | F* | customer postal address (Art 226(5); EN 16931 BG-8), same shape as `issuer.address` (BT-50, BT-51, BT-163, BT-52, BT-53, BT-54, BT-55) (*M where the invoicing rules that apply to the supply require it, as they do for every full invoice) |
| `buyer.taxId` | string | F* | customer VAT identification number (Art 226(4); BT-48), as supplied by the buyer (*M where the invoicing rules that apply to the supply require it, as Art 226(4) does on a full invoice where the buyer is liable for the VAT or the supply is an intra-Community supply of goods) |
| `buyer.taxIdBasis` | enum `verified/declared/none` | F | the basis on which the issuer treated `buyer.taxId`; present only with a non-empty `buyer.taxId`; see VAT treatment below |
| `buyer.declarationDigest` | bytes32 hex | F | keccak256 over the exact bytes of a declaration the buyer supplied and on which the issuer relied for `buyer.taxIdBasis`; the declaration's format is outside this extension; present only with `buyer.taxIdBasis`; see VAT treatment below |
| `supply.description` | string | M | nature of goods/services (Art 226b(c); BT-153/BT-154 class) |
| `lines[]` | array | F | `{description, quantity, unitPrice, net}` — quantity, unitPrice, net are strings (Art 226(6)-(8)) |
| `tax.scheme` | enum `none/vat/gst/jct/sales` | M | tax regime marker |
| `tax.currency` | string | M | ISO 4217 |
| `tax.amount` | string | M unless `none` | tax payable or data to compute it (Art 226b(d); JP QIS per-rate rule) |
| `tax.category` | enum `S/Z/E/AE/K/G/O/L/M` | F, may accompany MINIMAL | VAT treatment the issuer applied to the whole supply: EN 16931 VAT category code (BT-118; EN 16931's UNCL5305 subset without `B`, which EN 16931 allows for Italy only). A supply spanning categories uses `tax.breakdown[].category` and omits `tax.category`; where both are present, every `tax.breakdown[].category` MUST equal `tax.category`, and verifiers MUST reject a record that fails this. |
| `tax.exemptionReasonCode` | string | cond. | VATEX exemption reason code (BT-121), e.g. `VATEX-EU-AE`; see VAT treatment below |
| `tax.exemptionReason` | string | cond. | exemption reason text (BT-120): the reference or mention Art 226(11)/(11a) requires, e.g. "Reverse charge"; see VAT treatment below |
| `tax.breakdown[]` | array | F | per-rate `{rate, taxable, tax, category, exemptionReasonCode, exemptionReason}` — rate, taxable, tax are strings (Art 226(8)-(10)); `category` and the reason members are defined as for `tax.category` and `tax.exemptionReason*` |
| `settlement.fiat` | object | F | `{amount, currency, source, asOf}` — amount is a string, asOf an int (unix s); fiat-equivalent valuation at issuance (1099-DA gross-proceeds context) |
| `settlement.txHash` | string | F | on-chain settlement binding (ViDA "payment details") |
| `refundOf` | bytes32 hex | cond. | digest of the corrected/refunded record (Art 226b(e); ViDA corrective reference) |
| `adjustment` | object | cond. | ACP/UCP adjustment vocabulary verbatim |
| `retentionYears` | int | M | retention floor the issuer commits to, set per jurisdiction: the issuer SHOULD set it to at least the longest period that applies to it (Art 247(1) leaves the period to each Member State; e.g. DE § 14b UStG: eight years). RECOMMENDED default 7 where no longer period applies (HK s.51C ≥ MiCA 5+2) — a default, not a statement that 7 suffices |

### Tiers (normative)

**MINIMAL** = the M rows — deliberately isomorphic to the Art 226b simplified-invoice content, and the default where a simplified invoice is permitted. Whether a MINIMAL record suffices as an invoice is decided by the invoicing rules that apply to the supply under Art 219a, not by this extension. As a rule those are the rules of the Member State where the supply is made. They are the rules of the supplier's Member State of establishment where the supply is made outside the Union, or where the customer is liable for the VAT and the supplier is not established in the Member State of supply (or its establishment there does not intervene in the supply), unless the customer self-bills; and those of the Member State of identification where the supplier uses a one-stop-shop special scheme. Art 220a(1)(a) requires every Member State to allow simplified invoices up to EUR 100; a Member State may require further details on them, drawn from Arts 226, 227 and 230 (Art 226b), and may allow them above EUR 100 (Art 238(1)(a), up to EUR 400). Germany, for example, allows them up to EUR 250 gross and requires, among other details, the supplier's full name and address and the tax rate (§ 33 UStDV). Some supplies can never use one, whatever the amount (VAT treatment, below). **FULL** adds the EN 16931-aligned F rows.

MINIMAL/FULL are **legal thresholds** — determined under law by transaction value, jurisdiction, and who is liable for the tax. They are NOT verification-confidence levels and MUST NOT be mapped onto verification-depth scales: a €0.01 supply and a €50,000 supply can be verified to identical depth and still sit in different tiers, and conflating the two axes renders the record non-conformant in exactly the jurisdictions it exists to satisfy.

### VAT treatment (normative)

A category states an EU VAT treatment under EN 16931; a record MUST NOT carry a category or reason member unless its `tax.scheme` is `vat` or `none`, compared exactly. `tax.category` (or each `tax.breakdown[].category`) states the VAT treatment the issuer applied; this extension does not determine it. A category is one of `S`, `Z`, `E`, `AE`, `K`, `G`, `O`, `L`, `M`, compared exactly. Each object carrying a category — the record's `tax`, or a `tax.breakdown[]` entry — carries its own reason members, `exemptionReasonCode` (BT-121) and `exemptionReason` (BT-120). An object that carries a reason member MUST carry a category. Where the category is `E`, `AE`, `K`, `G` or `O` (exempt, reverse charge, intra-Community supply, export, not subject to VAT), that object MUST carry at least one of them; where it is `S`, `Z`, `L` or `M`, it MUST carry neither. Where it is `AE`, `K`, `G` or `O`, that object's `exemptionReasonCode` MUST be the code EN 16931 fixes for the category: `VATEX-EU-AE`, `VATEX-EU-IC`, `VATEX-EU-G` or `VATEX-EU-O` respectively; its `exemptionReason`, if present, is not checked. An object of any other category MUST NOT carry any of these four codes as its `exemptionReasonCode`. Categories and codes are compared exactly. This is stricter than EN 16931, which also accepts the standard text alone; the code is required here because EN 16931's text alternative includes any equivalent text in another language, which cannot be checked mechanically. These follow EN 16931 rules BR-E-10, BR-AE-10, BR-IC-10, BR-G-10, BR-O-10, BR-S-10, BR-Z-10, BR-AF-10 and BR-AG-10 and the VATEX code list, so the category and reason map onto an EN 16931 VAT breakdown unchanged (for `E`, provided any code is a VATEX code, as BR-CL-22 requires; this extension does not check that). For the exempt categories (`E`, `K`, `G`) the reason carries the reference Art 226(11) requires; for `AE`, the mention Art 226(11a) requires. **Verifiers MUST reject a record in which any object fails this rule or carries any other category value.**

The party and treatment members (`issuer.address`, `buyer.name`, `buyer.address`, `buyer.taxId`, the category and reason members) are consumed by both parties' bookkeeping, which books the supply and stores the invoice (Art 244) on which Art 226 requires the parties' details, the exemption reference and the reverse-charge mention; the treatment members are also consumed by verifiers applying the rules in this section. `buyer.taxIdBasis` and `buyer.declarationDigest` are consumed by the same bookkeeping, and by the parties' auditors, to see what the issuer's treatment of the buyer's identifier rested on and which declaration it relied on.

Party members can be personal data. The invoicing rules that apply to the supply decide which of them a record must carry; whether an issuer may include others is for the law that governs its processing of them, not for this extension. Attestation signs digests only (design principle 5), so a party attesting a record need not receive its content.

`buyer.taxIdBasis` records the basis on which the issuer treated `buyer.taxId` when it applied the VAT treatment: `verified` — relied on after an authoritative register (e.g. VIES for an EU VAT identification number) confirmed it valid; `declared` — relied on as supplied by the buyer, without such a confirmation; `none` — not relied on for that treatment, whether or not it was checked. Like `tax.category`, it states what the issuer did; this extension does not verify it. It is present only with a `buyer.taxId` that is a non-empty string. **Verifiers MUST reject a record that carries `buyer.taxIdBasis` unless its `buyer.taxId` is a non-empty string, or whose `buyer.taxIdBasis` is not one of these three strings, compared exactly.** A reader mapping these values to another vocabulary does so outside this extension.

`buyer.declarationDigest` is the digest of a declaration the buyer supplied and on which the issuer relied for `buyer.taxIdBasis`: keccak256, the function `receiptDigest` and `recordDigest` use, over the declaration's bytes exactly as the buyer supplied them, with no canonicalization. Over the 15 bytes `{"b":"x","a":1}`, for example, it is `0x318169473e18fa0df3baa652032eabd18c1cb02ea3cd20eaafe99df1446994e6`, not the first `recordDigest` vector in Canonicalization below, which is over their canonical form. The declaration's format is outside this extension, which verifies neither the declaration nor the digest against it. It is present only with `buyer.taxIdBasis`, and its value is a string of exactly 66 characters: `0x` followed by 64 characters, each one of `0`–`9` or `a`–`f` (the form of the `recordDigest` vectors). **Verifiers MUST reject a record that carries `buyer.declarationDigest` without `buyer.taxIdBasis`, or whose `buyer.declarationDigest` is not such a string.**

A simplified invoice is not available for the supplies of goods in Art 220(1)(2)–(3) (intra-Community distance sales outside the Union one-stop-shop scheme, and intra-Community supplies), nor where the supplier is not established in the Member State in which the VAT is due, or its establishment there does not intervene in the supply, and the customer is liable for that VAT (Art 220a(2)). Art 238(3) applies the same bar to the national simplified arrangements of Art 238(1), and national rules can bar more in practice: Germany excludes every reverse-charge supply under § 13b UStG (§ 33 UStDV, third sentence). For a supply so barred, the full-invoice content of Art 226 applies, including `seq` (Art 226(2)), `issuer.taxId` (Art 226(3)), `issuer.address`, `buyer.name` and `buyer.address` (Art 226(5)), and, where the buyer is liable for the VAT or the supply is an intra-Community supply of goods, `buyer.taxId` (Art 226(4)); the table marks these members F*, and no rule in this extension requires them because of a supply's VAT category or amount.

Two-sided. In these examples `tax.scheme` is `"vat"` unless stated. A record with `tax.category: "K"`, whose only reason is `tax.exemptionReasonCode: "VATEX-EU-AE"`, is rejected; the same record with `"VATEX-EU-IC"` passes. A record with `tax.category: "G"` whose only reason is the text "Export outside the EU" is rejected; the same record with `"VATEX-EU-G"` passes. A record with `tax.category: "AE"` and `"VATEX-EU-AE"`, whose `tax.breakdown[]` entry of category `"AE"` carries no reason member, is rejected; the same record with `"VATEX-EU-AE"` on that entry passes. A record with `tax.category: "S"` and any exemption reason is rejected; the same record without one passes. A record with `tax.category: "ae"` and `tax.exemptionReasonCode: "VATEX-EU-AE"` is rejected; the same record with `"AE"` passes. A record whose `tax` carries `exemptionReason: "Reverse charge"` but no category is rejected; the same record with `tax.category: "AE"` and `"VATEX-EU-AE"` passes. A record with `tax.category: "S"` whose `tax.breakdown[]` entries have categories `"S"` and `"E"` (the `"E"` entry with `exemptionReasonCode: "VATEX-EU-132"`) is rejected; the same record without `tax.category` passes, and is rejected if the `"E"` entry also loses that code. A record with `tax.category: "E"` and `tax.exemptionReasonCode: "VATEX-EU-G"` is rejected; the same record with `"VATEX-EU-132"` passes. A record with `tax.scheme: "jct"`, `tax.category: "G"` and `"VATEX-EU-G"` is rejected; the same record without the category and code passes. A record with `tax.scheme: "VAT"` and `tax.category: "S"` is rejected; the same record with `"vat"` passes. A record carrying `buyer.taxIdBasis: "declared"` without `buyer.taxId`, or with `buyer.taxId` equal to `""`, `null` or a one-element array holding `"DE123456789"`, is rejected; the same record with `buyer.taxId: "DE123456789"` passes. A record carrying `buyer.taxId` and `buyer.taxIdBasis: "Verified"` is rejected; the same record with `"verified"` passes. A record carrying `buyer.taxId` and `buyer.declarationDigest` equal to the first `recordDigest` vector in Canonicalization, but no `buyer.taxIdBasis`, is rejected; the same record with `buyer.taxIdBasis: "declared"` passes. That passing record is rejected if its `buyer.declarationDigest` is instead the same value with its hex digits in upper case, the same value without its `0x` prefix, the same value without its last character, the same value followed by `0`, the same value followed by a line feed, the same value with its last character replaced by `g`, the same value with its last character replaced by U+0663, `""`, `null`, or a one-element array holding the same value.

### Sequential numbering (normative)

Art 226(2) requires a full invoice to carry "a sequential number, based on one or more series, which uniquely identifies the invoice"; `seq` numbers one series per issuer. From the records it holds, a verifier can establish their order and any gap in their numbering. From those records alone it cannot establish their **completeness**: that it holds every record their issuer issued, and that no other record carries the same `seq` and `correctionSeq` as one it holds. Accordingly:

> A sequence attested only by the issuer of the records it numbers, or by a party that issues or numbers those records on the issuer's behalf, evidences ordering only. **Verifiers MUST NOT treat such a sequence as evidence that no record was omitted, or that no other record carries the same `seq` and `correctionSeq`.**

Two-sided: given records carrying `seq` 1 to 5 whose sequence is attested only by their issuer, a verifier that reports, on the strength of that attestation, that these five are every record their issuer issued, or that no other record carries the same `seq` and `correctionSeq` as one of them, is non-conformant; a verifier that reports only their order is conformant. The same holds where the sequence is attested only by their issuer and a party that numbers those records on the issuer's behalf.

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

A delegate is a party that signs, issues or numbers records on a transaction party's behalf; an attestor that signs in its own name is not a delegate merely because a transaction party engaged or paid it, or supplied the records it signs.

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

Third parties MAY additionally attest records by their `recordDigest`, which covers `seq` where present; what such attestations can and cannot evidence is set out under Sequential numbering, Existence and precedence, and Independence, and the service layer that makes them is out of scope for this spec.

## Refunds and corrections

A refund emits a NEW record with `refundOf` + `adjustment{type: refund, status, amount, currency, adjusts}`, signed like any record. Chains are walkable: original ← refundOf ← correction ← … This gives x402 a standard, auditable corrective-record shape without any new payment scheme.

## What this extension is NOT

- Not a tax-calculation engine; it carries fields, it does not compute rates or decide a supply's VAT treatment.
- Not a filing/transmission channel (Peppol Access Points, KSeF, FR PDPs are certified infrastructure; out of scope).
- Not delivery proof — complementary to the SAR proposal (#1195) and the delivery-receipt attestation proposal (#2833); either's digest can ride along as a reference.
- Not identity — `buyer.principal` carries an attribution reference; verification of principals belongs to AP2 / ERC-8004-layer mechanisms. Nor does it verify a buyer's tax identifier: `buyer.taxId` carries the identifier as supplied and `buyer.taxIdBasis` the basis the issuer states; how an identifier is checked is outside this extension.

## Prior art & standards referenced

EN 16931-1 (+ CEN/TS 16931-8:2024 e-receipt; VAT category codes, UNCL5305 subset; VATEX exemption reason codes; rules BR-*-10) · Peppol BIS Billing 3.0 (UBL 2.1) · VAT Directive 2006/112/EC Arts 219a/220/220a/226/226b/238/247 · DE § 33 UStDV, § 14b UStG (examples) · ViDA Directive (EU) 2025/516 · JP Qualified Invoice System · KR e-Tax Invoice · HK IRO s.51C · IRS 1099-DA · MiCA Art 68(9) · RFC 8785 (JCS) · schema.org Invoice/Order · x402 `offer-receipt`, `payment-identifier`, SAR proposal (#1195).

## Implementation status

An MIT-licensed TypeScript implementation exists; it does not yet conform to this specification. The spec is self-contained: an implementation needs nothing from it, and the vectors above test canonicalization conformance.
