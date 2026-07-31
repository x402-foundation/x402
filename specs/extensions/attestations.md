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
  imageDigest → registered key → live settlement address.

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
  payment receipt).
- **Revocable with history** — revocation flips the record inactive but MUST
  NOT erase it. "Held 2026-07 through 2026-09, then revoked" is signal;
  deletion is not.

### Client verification algorithm

Given a service URL:

1. Fetch `/.well-known/x402` (per the `discovery` extension). No manifest or
   no `badges` block → status **unadvertised**.
2. Read `badges.registry` and `badges.subject`; call
   `hasActiveBadge(subject, kind)` on-chain for each `kind` the client
   requires.
3. Active → status **active** (proceed). Present-but-revoked or absent →
   status **inactive** (clients SHOULD refuse or require explicit override).
4. Optionally fetch `evidenceRef` and re-run the evidence check itself —
   records are pointers to proof, not substitutes for it.

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
- **Evidence rot** — `evidenceRef` URIs can die; issuers SHOULD use
  content-addressed storage where practical. A record whose evidence is
  unreachable SHOULD be down-weighted, not treated as revoked.
