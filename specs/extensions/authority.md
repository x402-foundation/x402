# Extension: `authority`

**Status:** draft. **Version:** `x402-mandate/1` (all wire constants in §15).
**Conformance vectors:** `authority-vectors.json` (this directory), §16.

## Summary

The `authority` extension defines a compact, signed, offline-verifiable
**Mandate** — a bounded spending capability a principal grants to an agent
(*"spend up to CAP, to recipients in R, until T"*) whose digest binds into the
payment preimage, so one settled artifact ties the movement of money to a
specific human-rooted grant. It constrains **authority** and never touches
**settlement**, composing with every existing scheme and chain. This closes the
gap between "payment verified" and "caller authorized." Everything verifies
offline, with no callback to an issuer, a facilitator, or the authors of this
document. It is scheme-agnostic and directly addresses the delegation-hook
discussion in issue #3170.

---

## 1. Motivation

x402 standardizes how money moves: a 402 challenge, a signed payment payload,
a facilitator that verifies and settles. It says nothing about whether the
agent that moved the money was **allowed to** — how much, to whom, until when,
and on whose ultimate authority.

Today that gap is filled by nothing: budget tools track balances privately,
delegation proposals prove *who* delegated while losing *what was granted*,
and no receipt in the ecosystem can show a third party that a specific
settled payment was inside a specific human-granted bound. The result is that
an agent's blast radius is its whole wallet, and an auditor's answer to "who
authorized this?" is a shrug.

This extension defines the **Mandate**: a compact signed capability —

> *"spend up to CAP, to recipients in R, for purpose P, until T"*

— whose digest is bound into the payment preimage of the settlement scheme
itself, so one settled artifact ties the movement of money to a specific
grant. Reading the transferred amount, recipient, and asset **out of that
artifact** (§6) and checking them against the grant then proves the payer
held authority for exactly that action, within those bounds — the binding
locates the grant; the decode-and-compare enforces the cap. Everything
verifies **offline**: no callback to an issuer, a facilitator, or the authors
of this document. A Mandate constrains **authority** and never touches
**settlement**, so it composes with every existing scheme and chain as an
opt-in extension.

## 2. Terminology

The key words MUST, MUST NOT, SHOULD, MAY are to be interpreted as in RFC
2119. **Issuer**: the principal (a human, or a parent agent) that signs a
Mandate. **Subject**: the agent identity authorized to pay under it.
**Accountant**: the authority that commits spend heads (§9), named inside the
signed Mandate. **Counterparty**: any party deciding whether to accept a
payment or a spend history. **JCS**: RFC 8785 JSON Canonicalization.

## 3. The Mandate object

```jsonc
{
  "v": "x402-mandate/1",
  "issuer":     "<base64url Ed25519 public key, 43 chars>",
  "subject":    "<payer identity string>",
  "asset":      "<asset identifier string>",
  "cap":        "<integer minor units, decimal string>",
  "perPayment": "<integer minor units, decimal string>",   // OPTIONAL
  "recipients": ["<payee>", "..."],
  "accountant": "<base64url Ed25519 key | 'payees'>",
  "purpose":    "<human-readable string>",
  "notAfter":   "<RFC 3339 UTC, trailing Z>",
  "nonce":      "<uniqueness string>",
  "parent":     "sha256:<64-hex>"                          // OPTIONAL (§12)
}
```

Validation rules (all MUST; a grant violating any is invalid):

- `v` MUST be exactly `x402-mandate/1`.
- `issuer` MUST match `^[A-Za-z0-9_-]{43}$` (a raw 32-byte Ed25519 public
  key, base64url, unpadded).
- `cap` — and `perPayment` when present — MUST match `^(0|[1-9][0-9]*)$`
  (integer minor units; no float ever enters a money path). `perPayment`
  MUST be `<= cap`.
- `recipients` MUST be a non-empty array of strings. The single element `"*"`
  (ANY_RECIPIENT) is an explicit, signed opt-in to an unconstrained payee
  set; `"*"` mixed with any other element is INVALID. An empty array is
  INVALID — recipient scope fails closed.
- `accountant` MUST be either an Ed25519 key (Model A, §9) or the literal
  `payees` (Model B, §11). Under `payees`, every recipient **other than the
  sole-`"*"` opt-in** MUST itself match the Ed25519 key pattern — the recipient
  identity IS the attesting key. The sole `"*"` remains a valid signed opt-in
  under Model B; the per-entry recipient of every spend is still a key, or its
  attestation cannot verify (§11).
- `notAfter` MUST match `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$`
  AND survive a round-trip through millisecond-precision parsing (a
  shape-valid but overflowing date such as `…-02-30…` is INVALID; lenient
  parsers that normalize it MUST NOT be relied on).
- `parent`, when present, MUST match `^sha256:[0-9a-f]{64}$` (§12).
- Every string field (`issuer`, `subject`, `asset`, `cap`, `accountant`,
  `purpose`, `notAfter`, `nonce`, `parent`, and each `recipients` element)
  MUST be well-formed UTF-16 — a value with an unpaired surrogate is INVALID.
  This is a **validity rule**, not merely a signing-time guard: a verifier
  MUST return a refusal verdict for such a grant, never an exception (§6
  totality).

## 4. Canonicalization, domain separation, signatures

Every signed JSON object, and every digested JSON object, is serialized with
**JCS (RFC 8785)** and prefixed with a **domain-separation tag** unique to its
construction, so no signature or digest from one construction can be replayed
as another (including this ecosystem's manifest signatures). Two constructions
define non-JSON byte layouts: the preimage binding (§7) hashes tag-prefixed
raw UTF-8, and the anchor digest (§10) hashes already-tagged commitment bytes
concatenated with the raw signature; Merkle interior nodes follow RFC 6962
(§8). All remain domain-separated.

| Construction | Tag (UTF-8, incl. trailing `\n`) |
|---|---|
| Mandate signature & digest | `x402-mandate/1\n` |
| Spend commitment (§9) | `x402-mandate-commit/1\n` |
| Payee attestation (§11) | `x402-mandate-payee/1\n` |
| Preimage binding (§7) | `x402-mandate-binding/1\n` |

Signable input = `TAG || JCS(object)`. Signatures are **Ed25519** over that
input. All base64url values in this extension use the RFC 4648 §5 URL-safe
alphabet **without padding**; an Ed25519 signature is 64 bytes and therefore
exactly 86 characters (`^[A-Za-z0-9_-]{86}$`). Numbers MUST be integers with
absolute value `<= 2^52` (the JCS subset this profile signs); anything else,
and any string field that is not well-formed UTF-16, MUST be rejected before
signing or digesting.

**Signature envelopes.** A signed object travels in an interchange envelope
carrying the object, the algorithm, and the signature:

```jsonc
{ "mandate":     <§3 object>,  "alg": "Ed25519", "sig": "<base64url, 86 ch>" }
{ "commitment":  <§9 object>,  "alg": "Ed25519", "sig": "<base64url, 86 ch>" }
{ "attestation": <§11 object>, "alg": "Ed25519", "sig": "<base64url, 86 ch>" }
```

`Ed25519` is the sole legal `alg` in `x402-mandate/1`; a verifier MUST refuse
any other value. The envelope itself is never signed or digested — only the
tagged JCS of the inner object is. In §10's anchor formula, `sig` means this
envelope's `sig` field.

## 5. The mandate digest

```
mandateDigest = "sha256:" + lowerhex( SHA-256( "x402-mandate/1\n" || JCS(mandate) ) )
```

The digest is the mandate's identity everywhere: in payments, spend entries,
commitments, attestations, anchors, and child grants.

## 6. Payment authorization (single payment)

**paymentId.** Every payment carries a `paymentId`, minted by the **payer**
(consistent with §7's payer-chosen slot). It MUST match
`^[A-Za-z0-9._~-]{1,64}$` — non-empty, and excluding the anchor-grammar
separators (`;` `@` `#` `=`) and newline so it is safe both in the §7 binding
preimage and embedded raw in the §10 payee-anchor calldata. It MUST be
**unique per mandate** (§8 restates this as a per-log rule; §7 shows how the
settlement layer enforces it on uniqueness-enforcing rails).

A payment presented against a Mandate carries `{payer, recipient, asset,
amount, mandateDigest, paymentId, at?}`. A verifier MUST check, offline:

1. the Mandate's signature (issuer key, §4) is authentic;
2. `payment.mandateDigest` equals the recomputed digest (§5) — and, for a
   settled payment, the **preimage binding** (§7), which is the enforced form
   of this check;
3. `payer` equals the mandate `subject`;
4. `asset` equals the mandate `asset`;
5. `recipient` is within scope (exact match, or the sole-`"*"` opt-in, which
   SHOULD surface a warning);
6. `amount` is a valid integer string, `<= perPayment` when present, and
   `<= cap` unconditionally (no single payment may exceed the cumulative cap);
7. expiry: the check MUST use the **verifier's clock** — a payment evaluated
   at or after `notAfter` is unauthorized. A payer-supplied `at` is advisory
   and MUST NOT extend authorization; if present it MUST be well-formed
   (§3 timestamp rule).

Verifiers MUST be total: malformed inputs (including a mandate whose strings
are not well-formed UTF-16, or a missing/malformed head) yield a refusal
verdict, not an exception.

**Settled payments — the fields come from the artifact.** For a payment that
has settled, the verifier MUST take the §6 tuple **from the decoded settled
artifact**, not from any presented object: `payer` = from/Account, `recipient`
= to/Destination, `asset` = the token contract / XRPL currency, `amount` =
value/delivered_amount — then run checks 3–6 on those. The §7 slot match alone
MUST NOT be presented as proof of an authorized action: the slot binds only
`(mandate, paymentId)` and cannot constrain the transferred value. Without
this decode-and-compare step, a per-payment/cap ceiling binds only
self-asserted amounts and an agent that controls the rail can settle any
amount while logging a smaller one.

## 7. The preimage binding (enforced, not asserted)

A `mandateDigest` field on a payment object is a claim. The binding makes it
a fact, using the one payer-chosen 32-byte slot each scheme's signature
covers:

```
B = SHA-256( "x402-mandate-binding/1\n" || UTF8( mandateDigest || "\n" || paymentId ) )
```

| Scheme | Slot | Encoding of B |
|---|---|---|
| EIP-3009 `transferWithAuthorization` | `nonce` (bytes32) | `0x` + lowerhex (lowercase) |
| Permit2 `PermitTransferFrom` | `nonce` (uint256) | the 32 bytes of B as a **big-endian** unsigned 256-bit integer, decimal, no leading zeros/sign |
| XRPL `Payment` | `InvoiceID` | UPPERCASE hex |

`paymentId` MUST be non-empty and match the §6 pattern; implementations MUST
refuse to derive or verify a binding for an out-of-grammar `paymentId`.

A conforming payment's settled slot MUST equal the derived value, and
counterparties MUST verify it **from the settled artifact** (the signed
authorization or transaction), never from a presented field. The binding
proves *which* `(mandate, paymentId)` a settled transfer commits to — it does
**not** by itself bound the amount/recipient/asset; that is §6's
decode-and-compare rule.

**At-most-once is rail-dependent.** EIP-3009 and Permit2 consume the nonce, so
the same `(mandate, paymentId)` settles at most once — paymentId-once-per-mandate
is enforced at the settlement layer there. **XRPL does NOT enforce InvoiceID
uniqueness**: two `Payment` transactions carrying the same InvoiceID can both
settle (only the payer's account Sequence prevents third-party replay). Any
consumer deriving cumulative-spend conclusions from XRPL evidence MUST
de-duplicate observed settlements by `(mandateDigest, paymentId)` and MUST
treat two distinct validated Payments bearing one derived InvoiceID as spend
exceeding the presented log — the rail will not enforce it.

## 8. The spend log

Cumulative spend under a mandate is recorded as an ordered log of entries:

```jsonc
{ "mandateDigest": "sha256:<hex>", "asset": "...", "paymentId": "...",
  "recipient": "...", "amount": "<int>", "cumulative": "<int>",
  "priorRoot": "<64-hex>" }
```

- `cumulative` MUST equal the previous entry's cumulative plus `amount`
  (first entry: `amount`), gap-free.
- `priorRoot` MUST equal the Merkle root (below) over all preceding entries
  (first entry: the RFC 6962 empty-tree root, `SHA-256("")`). This chains the
  history: any edit, reorder, or insertion breaks it.
- `paymentId` MUST be non-empty, match the §6 pattern, and be unique within a
  log — and verifiers MUST re-check uniqueness over presented entries;
  builder-side checks do not protect the verify side.
- Every entry's `mandateDigest` MUST equal the digest (§5) of the presented
  grant; an entry bound to any other mandate invalidates the history.
- Every entry's `asset` MUST equal the mandate's `asset`.
- Every entry's `recipient` MUST be within the mandate's recipient scope (the
  §6 rule 5 test, including the sole-`"*"` opt-in).
- Every entry's `amount` MUST match the integer pattern (§15) and, when
  `perPayment` is present, MUST be `<= perPayment`.
- The final entry's `cumulative` (equivalently, the sum of amounts) MUST be
  `<= cap`.
- All bare 64-hex values — Merkle `root`, `priorRoot`, and inclusion-proof
  path elements — MUST be canonical 64-character **lowercase** hex, compared
  as exact strings (`priorRoot` case is additionally load-bearing: it is part
  of the leaf `seed`). The XRPL InvoiceID UPPERCASE rule (§7) is a separate
  rail convention, out of scope of this rule.

**Merkle construction (RFC 6962).** Each entry maps to a leaf object
`{drawId, nonce, seed}` with `drawId = mandateDigest || "|" || paymentId`,
`nonce = recipient || "|" || asset`, `seed = amount || ":" || cumulative ||
":" || priorRoot`. Then:

```
leaf     = SHA-256( 0x00 || JCS({drawId, nonce, seed}) )
interior = SHA-256( 0x01 || left || right )
```

with RFC 6962 §2.1 tree shape (split at the largest power of two strictly
below n; odd nodes promoted, never duplicated). Inclusion proofs and
verification follow RFC 6962 §2.1.1. Proof path elements MUST be canonical
64-char lowercase hex; anything else fails verification.

**What log verification proves, stated honestly:** a presented history that
passes every rule above is *internally sound* — mandate-bound, in scope,
duplicate-free, unedited, within cap. A truncated **prefix** of the true
history also passes. Internal soundness is tamper-evidence; **completeness
comes from §9 (Model A) with a freshness floor, or from §11's reconciliation
(Model B).**

## 9. Model A: the committed head

The accountant named in the mandate counter-signs heads:

```jsonc
{ "v": "x402-mandate-commit/1", "mandateDigest": "sha256:<hex>",
  "accountant": "<base64url Ed25519 key>", "seq": <int in [0, 10^15-1]>,
  "root": "<64-hex lowercase>", "total": "<int>", "at": "<strict RFC 3339 UTC>" }
```

signed over `"x402-mandate-commit/1\n" || JCS(commitment)`. `commitment.at`
MUST satisfy the §3 strict timestamp rule; `total` is an integer minor-unit
string (§15); `seq` MUST be an integer in `[0, 10^15-1]` and implementations
MUST refuse to sign or verify a head outside that range (this is also the
anchor grammar's 1–15-digit bound, §15).

Rules:

- `commitment.accountant` MUST equal the **mandate's** `accountant`; the
  verifier takes the accountant from the signed grant, never from the
  presenter. A self-consistent head signed by any other key MUST be refused.
- `seq` MUST be strictly increasing per mandate. An accountant MUST NOT sign
  two heads at one seq (equivocation; §10 makes it publicly detectable).
- A **zero-entry** log is well-formed: its reproduced `root` is the RFC 6962
  empty-tree root `SHA-256("")` and its `total` is `"0"`. The reproduced
  `total` is the final presented entry's `cumulative` (or `"0"` when empty).
- An accountant SHOULD only sign a `(root, total)` it derived from entries it
  holds — signing presented values is signing blind.

**Verification against a head.** After §8 passes, the presented entries MUST
reproduce the committed `root` AND `total` exactly; any omission or
truncation changes both. The verifier MUST supply a **freshness floor**
`lastSeq` — the highest seq it has previously accepted for this mandate, or
the highest anchored seq (§10):

- head `seq <= lastSeq` → REFUSE (rollback);
- floor explicitly absent (`null`) → the check MAY proceed but the verdict
  MUST carry a warning that it is **tamper-evidence only**: without a floor,
  an old validly-signed head plus its prefix log passes (first-contact
  truncation). Implementations MUST NOT present a floor-less verdict as
  completeness.

**Post-settle rule.** After settling a payment, a counterparty MUST demand a
new head with `seq` strictly greater than the pre-settle head, whose log
includes the settled `paymentId` (checkable by a single RFC 6962 inclusion
proof against the new root). Failure to produce it SHOULD be treated as a
default. This is what forces the head to advance per payment; an authorized
payment never committed is otherwise invisible to all later verifiers.

## 10. Anchoring (public tamper-evidence and the first-contact floor)

Each signed head yields an anchor digest by hashing the signed-over bytes (the
same signable input from §9, domain-separated and JCS-canonicalized) plus the
raw signature bytes:

```
anchorDigest = "sha256:" + lowerhex( SHA-256( 
  "x402-mandate-commit/1\n" || JCS(commitment) || base64urlDecode(sig) 
) )
```

The anchor calldata carries this in the ecosystem's note grammar:

```
x402note/1;<anchorDigest>;for=<mandateDigest>#<seq>;by=<accountant>
```

carried as the UTF-8 data of a 0-value transaction (the chain's timestamp is
the WHEN). Payee attestations (§11) also produce anchors, deriving an attestation-anchor digest:

```
attDigest = "sha256:" + lowerhex( SHA-256( 
  "x402-mandate-payee/1\n" || JCS(attestation) || base64urlDecode(sig) 
) )
```

Payee anchors carry this as `@<paymentId>` in place of `#<seq>`; the
separators keep the two anchor kinds unambiguous to scanners.

Anchoring is **permissionless**: an anchor proves when a byte-string existed,
never that its contents are honest, and `by=` is an **unauthenticated
attribution hint** — any chain writer can name any key. A seq taken from
calldata on faith is therefore DoS-poisonable: a stranger can post
`…for=<mandate>#999999999999999` (with or without a matching `by=`, since the
accountant key is public) and, if a scanner trusted it, brick every honest
head as a `seq <= lastSeq` rollback.

To derive a freshness floor safely, a scanner MUST NOT count an anchor's seq
unless it retrieves the anchored byte-string, recomputes `anchorDigest` over
the head bytes and signature, verifies the Ed25519 signature, and checks
`commitment.accountant == the mandate's accountant`, `commitment.mandateDigest
== for=`, and `commitment.seq == the anchor's #seq`. Anchors lacking a `by=`
segment (the earlier grammar) MUST NOT contribute to floor derivation for a
mandate that names an accountant; they MAY be parsed for historic reads and
equivocation scanning only. Scanners MUST treat "no qualifying anchor" as **no
floor**, never as seq 0 — this can only lower the floor toward the §9
tamper-evidence-only downgrade, never raise it. Verifiers MUST re-run the §9
trust chain regardless of anchors.

Two heads anchored at one seq expose accountant equivocation publicly.

## 11. Model B: aggregated payee attestations (`accountant: "payees"`)

No single accountant. Each payment's **payee** — whose identity IS its
Ed25519 key — signs an acknowledgement:

```jsonc
{ "v": "x402-mandate-payee/1", "mandateDigest": "sha256:<hex>",
  "paymentId": "...", "payee": "<base64url Ed25519 key>",
  "asset": "...", "amount": "<int>", "at": "<RFC 3339 UTC>" }
```

signed over `"x402-mandate-payee/1\n" || JCS(attestation)` by the payee key
itself. There is no separate key field to mis-bind: the signature verifies
against the recipient identity, or it does not verify.

Every field including `at` MUST satisfy the §3 strict timestamp rule; a
non-strict `at` invalidates the attestation on the verify side, not only at
signing.

**Entry backing (no fabrication).** Every presented spend entry MUST have a
matching authentic attestation selected by **both** paymentId and recipient
(same paymentId, payee == recipient, same asset and amount). An entry that is
the agent's word alone MUST be refused.

**Reconciliation (omission).** Completeness in Model B comes from evidence
the verifier gathers **independently of the agent** — from the payees, or by
scanning their anchors. Reconciliation MUST:

1. admit only authentic, this-mandate, **in-scope** attestations. For a
   scoped mandate, an attestation whose `payee` is not in `recipients` is
   discarded with a warning (a stranger cannot force a refusal); junk and
   foreign-mandate attestations are likewise warnings, never a veto;
2. key admitted evidence by `(payee, paymentId)` and refuse loudly on
   **payee equivocation** — two authentic attestations from the **same payee**
   for one paymentId with conflicting facts (differing `asset` or `amount`; a
   differing `at` alone is NOT equivocation);
3. refuse if any admitted attestation's payment is absent from the presented
   log — the omission, named by the party that cannot un-know it was paid;
4. refuse if the **attested floor** (the sum over all admitted attestations)
   exceeds `cap` — over-spend is provable from payee evidence alone, even
   against an empty log.

**Honest scope.** Entry backing alone proves no-fabrication, not
completeness: dropping an entry and its attestation passes entry backing.
Implementations MUST NOT present Model B verification without reconciliation
as omission-proof. Two residual limits are inherent and offline-irreducible:
(a) under the sole-`"*"` opt-in every key is in scope, so the stranger-veto
resistance of rule 1 does not hold — an issuer choosing `"*"` with `payees`
accepts that any key can force a refusal; (b) an authentic attestation for a
payment that never settled is indistinguishable offline from an agent
omission, and a colluding payee can under-attest — reconciliation makes such
fabrication **attributable** (the refusal names the payee) but not
preventable without rail access. A profile binding the §7 settled-slot into
the attestation can close (b) for verifiers with rail access, at the cost of
the offline guarantee.

## 12. Delegation (the origin survives hops)

A mandate carrying `parent` is a **child grant**, issued (signed) by the
parent's `subject` — which MUST itself be an Ed25519 key for the parent to be
delegable. Every bound may only **narrow**:

- `child.parent` == the parent's mandateDigest; `child.issuer` == the
  parent's `subject`;
- same `asset`; same `accountant` (one accounting domain per chain);
- `child.cap <= parent.cap`;
- effective per-payment bound (`perPayment`, defaulting to `cap`) MUST NOT
  exceed the parent's;
- `child.notAfter <= parent.notAfter`;
- recipients ⊆ parent's (a scoped parent's child MUST NOT opt into `"*"`;
  under a `"*"` parent the child may scope freely).

A chain is verified root→leaf entirely offline: the root MUST have no
`parent`, every link's signature MUST verify, every hop MUST narrow. The
verifier recovers the **root issuer** — the human origin — at any depth.

**Sibling budget (stated limit).** Narrowing is per-link: nothing structural
prevents a delegator issuing siblings whose caps sum above the parent cap.
The registering party (the accountant, or the delegator's ledger) MUST
enforce `Σ sibling caps <= parent.cap` over the set it registers; a verifier
handed a set of siblings can check the same over that set, and only that set.

## 13. Counterparty requirements (summary)

1. PRE-SETTLE: obtain the current head; require `committedTotal + amount <= cap`.
2. POST-SETTLE: require inclusion under a strictly newer head (§9).
3. FRESHNESS: supply a real `lastSeq` (own state or anchored floor); treat a
   floor-less verdict as tamper-evidence only.
4. BINDING: verify the settled slot (§7), never a presented field. **CRITICAL**:
   the slot (§7 binding) commits only to (mandate, paymentId). The counterparty
   MUST independently read `amount`, `recipient` (to), and `asset` from the
   settled artifact (the transferred value, not presented fields) and require
   they equal the SpendEntry's values exactly. The binding alone cannot
   constrain the value field. On EIP-3009/Permit2 the consumed nonce prevents
   double-spend; **on XRPL the slot is not unique** (§7), so a consumer MUST
   also de-dup observed settlements by `(mandateDigest, paymentId)`.
5. Model B: gather payee evidence independently and reconcile (§11).

## 14. Accountant deployment (informative)

Three postures, one wire format: a **named custodian/auditor key** (regulated
deployments — one liable name); the **issuer's own key** (consumer
self-sovereign — protects the issuer, not counterparties, and SHOULD be
stated as such); **`payees`** (no single accountant — completeness rests on
independently-gathered payee evidence with the residual limits of §11, so not
unconditionally "trustless"). Anchoring cadence trades cost against staleness;
per-head anchoring is the strongest posture.

## 15. Constants and grammar registry

| Item | Value |
|---|---|
| Mandate version / DS tag | `x402-mandate/1` / `x402-mandate/1\n` |
| Commitment version / DS tag | `x402-mandate-commit/1` / `x402-mandate-commit/1\n` |
| Payee attestation version / DS tag | `x402-mandate-payee/1` / `x402-mandate-payee/1\n` |
| Binding DS tag | `x402-mandate-binding/1\n` |
| Ed25519 key pattern | `^[A-Za-z0-9_-]{43}$` (base64url, unpadded, 32 bytes) |
| Ed25519 signature pattern | `^[A-Za-z0-9_-]{86}$` (base64url, unpadded, 64 bytes) |
| Amount pattern | `^(0|[1-9][0-9]*)$` (integer minor units) |
| paymentId pattern | `^[A-Za-z0-9._~-]{1,64}$` (non-empty, no grammar separators) |
| Timestamp | strict RFC 3339 UTC (`Z`), millisecond max, round-trip-validated (all: notAfter, payment.at, commitment.at, attestation.at) |
| Digest form | `sha256:` + 64 lowercase hex |
| Bare hex (root, priorRoot, proof path) | 64-char lowercase hex, exact-string compared |
| Integer / seq bound | integers `|n| <= 2^52`; `seq` in `[0, 10^15-1]` |
| ANY_RECIPIENT | `*` (sole element only) |
| PAYEES accountant | `payees` |
| Signature envelope | `{ <obj>, "alg": "Ed25519", "sig": <base64url> }`; `alg` MUST be `Ed25519` |
| Head anchor calldata | `x402note/1;<anchorDigest>;for=<mandateDigest>#<seq>;by=<accountant>`, `<seq>` = 1–15 digits |
| Head anchor digest | `sha256:` + lowerhex(SHA-256( `x402-mandate-commit/1\n` ‖ JCS(commitment) ‖ base64urlDecode(sig) )) |
| Payee anchor calldata | `x402note/1;<attDigest>;for=<mandateDigest>@<paymentId>;by=<payee>` |
| Payee anchor digest | `sha256:` + lowerhex(SHA-256( `x402-mandate-payee/1\n` ‖ JCS(attestation) ‖ base64urlDecode(sig) )) |
| Merkle | RFC 6962: leaf `0x00‖JCS`, interior `0x01‖L‖R`, promote odd nodes; empty-tree root `SHA-256("")` |

## 16. Conformance vectors

Deterministic vectors (key seeds = `SHA-256("x402-authority-vectors/1:<label>")`,
fixed timestamps, RFC 8032 deterministic Ed25519) covering: mandate JCS,
digest and signature; per-scheme binding values; a three-payment spend log
with roots and an inclusion proof; a committed head with anchor digest,
calldata, parse, and derived freshness floor; Model B attestations, payee
anchors, and the omission-reconciliation refusal; a two-hop delegation chain
with recovered root issuer and sibling-budget verdicts; a security-fix block
(settled-artifact amount binding, stranger-veto resistance, surrogate
totality); and the refusal battery (truncation, fake accountant, rollback,
duplicate paymentId, the vectored widenings — widened cap, later expiry,
recipient-outside-scope, ANY-under-scoped-parent — Feb-30, empty/mixed
recipient scope, float amounts, perPayment-above-cap). The remaining §12
narrowing dimensions (asset/accountant change, wrong issuer/parent) are
exercised by the reference test suite.

Conformance is two-tier: (1) **cryptographic and wire values** — canonical
JCS bytes, digests, signatures, Merkle roots and inclusion proofs, per-scheme
binding values, anchor digests and calldata, derived floors, amounts, and
boolean verdict fields — MUST match the vectors byte-for-byte; (2)
**refusal/acceptance cases** are conformant when the implementation's verdict
matches (accept vs. refuse, warning present vs. absent) — the diagnostic
message strings recorded in the fixture are the reference library's wording
and are **informative only**.

The vectors are published alongside this document as `authority-vectors.json`.
They are fully deterministic — an independent implementation reproduces every
cryptographic and wire value from the spec text and the seeds alone. A
`securityFixes` block pins the load-bearing invariants (settled-artifact amount
binding, Model B stranger-veto resistance, verifier totality, non-Ed25519 alg
refusal, unknown-member rejection). The settled-artifact amount binding ships as
a complete scenario rather than a recorded verdict: `settledUnderReport` carries
the settled transfer, the amount the agent committed instead, and the verdicts
of **two distinct rules**, so an implementation derives them from the inputs
rather than reading a boolean it cannot reproduce. The two are worth keeping
apart: the *commitment mismatch* is the under-report itself, caught by checking
the committed entry against the settled artifact (§13 MUST-rule 2); the
*decoded-amount* refusal shows only that the binding slot commits to
`(mandate, paymentId)` and not to amount — it fires on the per-payment bound and
would fire on an honest settlement of the same size, so it is cap enforcement
rather than under-report detection.

## 17. Security considerations

- **Trust root.** The accountant is named inside the issuer-signed grant; a
  verifier accepting a presenter-supplied accountant re-opens the primary
  attack of this design (self-appointed accountants).
- **First-contact truncation.** Without a freshness floor, completeness
  claims are false. This document deliberately makes the downgrade explicit
  rather than pretending offline math alone detects omission.
- **Domain separation.** Three signed constructions (mandate, commitment,
  payee attestation) share JCS+Ed25519; the preimage binding (§7) is an
  unsigned tagged SHA-256 over raw UTF-8, and anchor digests hash tagged
  commitment/attestation bytes concatenated with the raw signature. The tags
  in §4 are load-bearing. Implementations MUST NOT sign untagged canonical
  bytes.
- **Anchor-floor integrity.** `by=` is an unauthenticated routing hint; a
  freshness floor MUST come only from a fully re-verified head (§10), never
  from an unmatched anchor seq, or a stranger can spoof the floor upward and
  deny service.
- **XRPL double-settle undercount.** XRPL does not enforce InvoiceID
  uniqueness; without the §7 counterparty-side once-per-`(mandate, paymentId)`
  rule, real cumulative spend can exceed the logged cumulative on XRPL.
- **Amount binding.** The §7 slot does not constrain the transferred value;
  §6's decode-from-artifact rule is what makes the cap bind on a rail the
  agent controls.
- **Model B residuals.** Under `"*"` any key can force a refusal, and a
  colluding payee can under-attest (§11); reconciliation makes fabrication
  attributable, not preventable, without rail access.
- **Clock discipline.** Expiry uses the verifier's clock; timestamps are
  strict-UTC and round-trip-validated to defeat lenient-parser divergence.
- **Fail-closed defaults.** Empty recipient scope is invalid; unconstrained
  scope is an explicit signed opt-in; anchor tools refuse unverified heads.
- **Permissionless anchors.** Anchors order events in time; they never
  launder authority. Floor derivation requires full head verification (§10);
  `by=` alone is a routing hint with no integrity.
- **Collusion limits.** Issuer-as-accountant protects the issuer only (§14);
  Model B's completeness depends on payee evidence reaching the verifier.

## 18. Versioning and extensibility

- **Unknown version.** A verifier MUST refuse any object whose `v` is not the
  registered constant for the construction. A future version registers a new
  version string and therefore a new domain-separation tag (tags are the
  version string + `\n`, §4), so cross-version replay is structurally
  impossible.
- **Unknown members.** This profile's objects are closed: an implementation
  MUST reject a mandate, commitment, or attestation carrying members not
  defined here. (Rationale: JCS signs and digests whatever is present, so an
  implementation that silently strips unknown fields would compute a different
  identity than one that preserves them — a silent interop split on the
  object's own digest. Fail closed instead.)

## 19. x402 protocol binding (deferred)

This document specifies the authority object model and its offline
verification. How a mandate attaches to the x402 request/response flow is
**deliberately out of scope for this revision** and reserved for a companion
binding document; the four open pieces are named here so implementers do not
assume silence means "unconstrained":

1. **Advertisement** — following the repository's extension convention, a
   resource server signals support in `PaymentRequired.extensions.authority`
   with an `info` block (e.g. `{ "required": bool, "version":
   "x402-mandate/1" }`) and a JSON-schema for the carried grant.
2. **Carriage** — where the signed mandate (or its digest plus a retrieval
   hint) and the evidence bundle (head, inclusion proof, Model B attestations)
   travel in the `PaymentPayload`, and the channel for §9's post-settle
   "demand a new head". Note §7 already fixes the payload-side slot.
3. **Facilitator semantics** — whether `/verify` evaluates §6 (and with what
   freshness floor) or authority checking is counterparty-side only.
4. **Refusal signaling** — the error shape returned on an authority refusal,
   distinct from a settlement failure.

This is offered as a companion follow-up so the object model can be reviewed
and cross-verified first; the `authority` extension key is reserved for it.
