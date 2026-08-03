# Extension: `attestations` — verifiable trust records for x402 participants

## Summary

The `attestations` extension defines how x402 participants publish
**machine-verifiable trust records** — claims about *how they operate* that a
client can check independently, before or after paying. It standardizes two
record types, both surfaced through the `/.well-known/x402` manifest defined
by the `discovery` extension:

1. An **execution attestation** — a facilitator's claim that its settlement
   key lives inside a verifiable execution environment (e.g. a TEE), bound to
   a reproducible image digest and an on-chain key registration, with a
   published verification procedure any client can run.
2. **Attestation records ("badges")** — on-chain, non-transferable,
   revocable-with-history tokens issued by a named issuer about a subject
   address (a facilitator, resource server, or agent), each linked to
   evidence.

Together these answer the question the base protocol leaves open: *x402 tells
you what a service costs; nothing tells you whether the service can be
trusted with the payment.* Today that gap is filled by curated lists and
brand reputation — exactly the centralized pattern the `discovery` extension
removed from capability lookup. This extension removes it from trust lookup.

## Motivation

x402 payments are final and machine-initiated. An agent choosing between two
facilitators, or deciding whether a resource server will actually deliver
after settlement, has no protocol-level signal. Existing approaches:

- **Curated directories** — centralized, rot, and conflate listing with
  endorsement.
- **Bearer credentials (JWT-style identity networks)** — verifiable but
  issued by a single company; the issuer is a trusted third party and a
  single point of failure.
- **Brand trust** — does not work for the long tail, which is precisely
  where open payment protocols matter.

The design goal: **trust claims should be verifiable the way payments are
verifiable — on-chain or cryptographically, by anyone, with no privileged
verifier.** A claim that cannot be independently checked MUST NOT be
advertised (the "honest manifest" rule, normative below).

## Execution attestation (`attestation` manifest block)

A facilitator whose settlement key is provably confined to a verifiable
execution environment MAY advertise it in its manifest:

```json
{
  "x402Version": 1,
  "kind": "facilitator",
  "attestation": {
    "type": "tee",
    "platform": "confidential-space-tdx",
    "imageDigest": "sha256:…",
    "reproducible": true,
    "keyRegistration": {
      "network": "coston2",
      "registry": "0x…",
      "attestationRef": "x402-facilitator:sha256:…"
    },
    "verification": {
      "procedure": "https://…/verify-facilitator",
      "evidence": "https://…/attestation-token"
    }
  }
}
```

- `type` — the attestation family. `"tee"` is defined here; other families
  (zk, MPC) may be registered later.
- `imageDigest` — digest of the exact image whose measurement appears in the
  attestation evidence. `reproducible: true` claims the image can be rebuilt
  bit-for-bit from public source.
- `keyRegistration` — where the settlement address was registered on-chain
  with a reference binding it to the attestation (so key custody claims are
  auditable history, not just live state).
- `verification` — a procedure (script, endpoint, or document) that lets a
  third party re-derive the whole chain: evidence → measurement →
  imageDigest → registered key → live settlement address. The `procedure`
  is **documentation for a verifier the client already trusts, never code
  for the client to run** — see *Remote references: safe fetching*, which
  binds every URI in this block. The `evidence`
  endpoint is **live state**; facilitators SHOULD additionally anchor the
  digest of each verification event (same `evidenceDigest`/`evidenceAnchor`
  shape as badge records, below), giving a permanent, independently
  checkable record that the chain passed at a given time — separate from
  whether the endpoint keeps serving that token.

**Honest-manifest rule (normative):** a manifest MUST only carry an
`attestation` block while the full verification chain currently passes.
Servers SHOULD automate this — degrade the block (e.g. to `"type": "none"`
or omission) the moment any link fails, and restore it only on re-verify.
An advertised attestation that a client's check cannot reproduce SHOULD be
treated as **worse than no attestation**.

## Attestation records (`badges` manifest block + registry contract)

### Manifest pointer

Any participant MAY point to on-chain attestation records about itself:

```json
{
  "badges": {
    "registry": { "network": "coston2", "address": "0x…" },
    "subject": "0x…"
  }
}
```

`subject` is the address the records are about — for a facilitator, its
settlement address; for a resource server or agent, its receiving/paying
address.

### Registry contract requirements

A conforming registry is a smart contract where records are:

- **Non-transferable** — soulbound (ERC-721 with ERC-5192 lock semantics, or
  equivalent). Reputation must not be tradeable.
- **Issuer-explicit** — every record names its issuer; verifying a record
  includes deciding whether you trust that issuer. A registry is a namespace,
  not an authority.
- **Typed** — each record carries a `kind` (e.g.
  `x402-facilitator-attested`, `agent-audits-before-paying`) so clients can
  query for the specific claim they care about:
  `hasActiveBadge(subject, kind) → bool`.
- **Evidence-linked** — each record carries an `evidenceRef` URI pointing to
  the artifact that justified issuance (verification report, audit output,
  payment receipt). A bare URI has the trust model of brand reputation:
  the pointer can be edited or taken down after the fact. Records SHOULD
  therefore also carry an **`evidenceDigest`** (SHA-256 of the artifact at
  issuance time) and MAY carry an **`evidenceAnchor`** — a chain reference
  (network + contract + record id) to where that digest is anchored in a
  permissionless anchor registry. This extension privileges no particular
  anchor registry. With a digest present, the record inherits
  tamper-evidence from the evidence itself rather than from the registry's
  honesty about not editing the link.
- **Revocable with history** — revocation flips the record inactive but MUST
  NOT erase it. "Held 2026-07 through 2026-09, then revoked" is signal;
  deletion is not.

### On-chain representation of the evidence triple

A registry contract usually has **one** string field for evidence, not
three — and adding typed fields means redeploying to a new address,
which breaks every manifest already pointing at the registry. The
triple must therefore survive inside a single string, in a form two
independent implementations can compare **byte for byte**. Registries
SHOULD use the following canonical grammar:

```
x402ev/1; digest=<alg>:<hex>[; anchor=<caip2>:<contract>:<record>][; ref=<uri>]
```

- `x402ev/1` — version tag. Parsers MUST reject unknown majors.
- `digest=` — REQUIRED. Algorithm-prefixed so the format survives a
  hash migration (`sha256:<64 lowercase hex>` today).
- `anchor=` — OPTIONAL. Where the digest is independently recorded:
  CAIP-2 chain, contract, record id. **Omit it when the record
  carrying this string is itself the anchor** — a badge that already
  contains the digest needs no second witness.
- `ref=` — OPTIONAL. Where the artifact can be fetched. Link rot is
  expected; the digest is the truth.

Canonicalization, which is what makes comparison meaningful: fixed
field order (`digest`, `anchor`, `ref`); separator exactly `"; "`;
algorithm, digest hex and addresses lowercased; URIs verbatim
(case-sensitive); no trailing separator. Parsers MUST accept fields in
any order and MUST re-emit canonical order before comparing. Unknown
keys MUST be ignored rather than rejected.

Two references describe the same evidence when their **digests**
match — never their `ref`. A relocated artifact is still the same
evidence; different bytes at the same URL are not.

Registries with typed fields MAY store the components separately, but
MUST be able to produce this canonical string, so that cross-registry
verification stays a string comparison rather than a schema
negotiation.

Serving the artifact at a path **named by its digest** (e.g.
`/evidence/<sha256>.json`) is RECOMMENDED: a verifier then fetches and
re-hashes without trusting the server about which file it received,
and the URL is immutable by construction.

### Remote references: safe fetching (normative)

This extension introduces URIs the previous sections invite clients to
dereference — `verification.procedure`, `verification.evidence`,
`evidenceRef`, and `ref=` inside the `x402ev/1` string. Every one of
them is a fetch performed on the say-so of an unauthenticated stranger,
so they inherit the `discovery` extension's manifest-fetch profile
rather than defining a weaker one:

- **HTTPS only.** Clients MUST NOT dereference non-HTTPS references.
- **Bounded.** Clients MUST apply a request deadline and a maximum
  response size, and MUST cap redirect hops, re-validating these rules
  on **every** hop. (Evidence artifacts may legitimately exceed a
  manifest's size; the bound is the client's to choose, but there MUST
  be one.)
- **Public destinations only.** Clients MUST refuse a reference whose
  host is, or resolves to, a loopback, link-local, or private-range
  address, re-checked on every redirect hop. The in-domain and HTTPS
  rules do not imply this one: a publisher controls their own DNS, so an
  in-domain name can resolve anywhere — including a crawler's own
  internal network — and DNS-01 issuance grants valid certificates to
  names that never point anywhere public. Deployments that intentionally
  operate on private networks MAY relax this, explicitly.
- **Origin.** `verification.*` URLs describe the operator's own live
  state and SHOULD be same-origin with the manifest or the facilitator
  `baseUrl`. `evidenceRef` / `ref=` MAY be off-origin — content-addressed
  storage is legitimate and expected — because the **digest**, not the
  origin, is the integrity control. Retrieval-safety rules above still
  apply in full: a digest protects what you received, not what fetching
  it made you do.

**Procedures are documentation, not code to run.** Clients MUST NOT
automatically execute a fetched `verification.procedure` — or any other
fetched artifact — as code. Verification logic MUST be code the verifier
already trusts (vendored, pinned, or independently obtained); manifest
fields supply only *parameters* to that logic — URLs, digests,
addresses, chain coordinates. A manifest that can inject code into its
own verifier verifies nothing.

### Client verification algorithm

Given a service URL:

1. Fetch `/.well-known/x402` (per the `discovery` extension). No manifest or
   no `badges` block → status **unadvertised**.
2. Read `badges.registry` and `badges.subject`; call
   `hasActiveBadge(subject, kind)` on-chain for each `kind` the client
   requires.
3. Active → status **active** (proceed). Present-but-revoked or absent →
   status **inactive** (clients SHOULD refuse or require explicit override).
4. Optionally fetch `evidenceRef` (under the *safe fetching* rules above)
   and re-run the evidence check itself —
   records are pointers to proof, not substitutes for it. When an
   `evidenceDigest` is present, verifiers SHOULD check the fetched artifact
   against it (and against the `evidenceAnchor`, if any) rather than trust
   the URI, and MUST treat a digest mismatch as **evidence-invalid** — a
   stronger negative signal than an unreachable URI.

Clients SHOULD treat **inactive** as a hard stop and **unadvertised** as a
soft signal (many honest services simply have no records yet).

### Trust model

- A record is a **verifiable statement by a named issuer**, nothing more.
  Advertising records is not endorsement by the protocol, the registry, or
  any directory — the exact analog of the `discovery` rule that discovery ≠
  endorsement.
- Trust flows **both directions**: services hold records agents check before
  paying ("this facilitator's key is enclave-held"), and agents hold records
  services check before serving ("this agent verifies before it pays").
- Issuers stake their own on-chain identity on every issuance. Sybil issuers
  are possible and expected; clients maintain issuer allowlists the same way
  they maintain facilitator configuration today. Nothing here requires a
  central issuer — that is the point.

## Interaction with `discovery`

This extension defines two manifest blocks (`attestation`, `badges`) carried
by the manifest the `discovery` extension standardizes. It is usable without
DNS TXT records, but composes with them: a crawler can go TXT → manifest →
on-chain records with no prior knowledge of the host and no HTTP request
beyond the manifest fetch.

## Reference implementation

- Facilitator with live TEE `attestation` block (Confidential Space TDX,
  reproducible image, Safe 2-sig key registration) and `badges` pointer.
- `FCAttestationBadges` — soulbound ERC-721+5192 registry, Safe-issued,
  deployed and source-verified on Coston2.
- Open verifier re-deriving the full attestation chain (14 checks).
- Client-side badge gate in an autonomous agent (refuses revoked venues).
- First **paid** record issuance: audit purchased via x402 (`exact` /
  EIP-3009), charged only on pass, payment tx embedded in `evidenceRef`.

## Security considerations

- **Stale attestation** — evidence tokens expire; verification MUST check
  freshness (nonce/eat_nonce binding) not just signature validity.
- **Registry substitution** — a malicious manifest can point to a lookalike
  registry. Clients MUST pin or allowlist registries/issuers they accept,
  exactly as they pin facilitators today.
- **Revocation liveness** — clients MUST read active status from chain at
  decision time; cached "active" results decay.
- **Fetch-and-run surface** — this extension's remote references are
  requests made on a stranger's say-so. The *safe fetching* section is
  normative for all of them: HTTPS only, bounded time/size/redirects
  with per-hop re-validation, private destinations refused after
  resolution, and no fetched artifact ever executed as code. Integrity
  controls (`evidenceDigest`, content addressing) protect what was
  retrieved; they do nothing to make retrieval or execution safe, which
  is why both sets of rules exist.
- **Evidence rot vs. evidence tampering** — these are different failures.
  An unreachable `evidenceRef` SHOULD down-weight a record, not revoke it.
  A fetched artifact that MISMATCHES its `evidenceDigest` is
  evidence-invalid and MUST be treated as a hard negative. The
  digest/anchor mechanism (above) exists so that link rot degrades
  gracefully while tampering cannot hide behind it.
