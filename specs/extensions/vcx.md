# VCX: Verifiable Credential Exchange for x402

**An x402 v2 Extension Specification**

> **Status:** Draft.

The keywords MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as
described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174).

---

## 1. Summary

VCX (Verifiable Credential Exchange) is an optional identity extension for the
[x402](https://github.com/x402-foundation/x402) HTTP payment protocol,
implemented per the x402 v2 Extensions architecture. It introduces:

- A single new HTTP header, `VCX`, carrying a three-layer identity envelope
  (Principal / Agent / Payment Source).
- Identity requirements emitted by the resource server's `onPaymentRequired`
  hook, declared via `declareVCXExtension({...})` in route configuration.
- A four-step verification procedure executed by the resource server's
  `onProtectedRequest` hook.
- Three selective-disclosure tiers (issuer-only, selective claims, full
  disclosure) with concrete cryptographic backing.
- A defined credential-revocation contract with two profiles (short-lived TTL
  or W3C Bitstring Status List v1.0).
- A trust-list distribution model supporting three transports.

VCX is fully backwards-compatible with x402 v2 core: x402 clients and servers
that do not implement VCX continue to interoperate normally. Resources that
require VCX simply gate access on extension success in addition to payment
settlement.

## 2. Motivation

x402 v2 settles the question of *whether* payment occurred. Many resource
servers also need to settle the question of *who* paid: regulated financial
services, KYC-gated content, jurisdictional content controls, large-value
compliance reporting, and agent-mediated transactions where the principal's
liability differs from the operating wallet.

Existing identity solutions are payment-method-specific (custodial APIs,
OAuth flows, Plaid) and do not compose with x402. Bolting identity onto x402's
core `X-PAYMENT` header would force every implementation to handle an
optional concern in mandatory code paths.

The x402 v2 Extensions architecture is the natural home for this concern.
Extensions are inherently optional, register through the standard
`extensions: {...}` mechanism, and integrate via the established lifecycle
hooks (`onPaymentRequired`, `onProtectedRequest`, `onAfterSettle`). VCX adopts
this architecture exactly, decomposing the identity question into three
orthogonal sub-questions answered by independent layers of the envelope:

1. **Who is the liable party?** — the Principal.
2. **What software is acting on their behalf?** — the Agent.
3. **What account is the payment coming from?** — the Payment Source.

## 3. Terminology

| Term | Definition |
|------|------------|
| **Principal** | The natural person or legal entity ultimately liable for the transaction. Represented by a DID and attested by a W3C Verifiable Credential signed by a trusted Issuer. |
| **Agent** | The software actor authorized by the Principal to transact within defined conditions. Represented by a `did:key`. |
| **Payment Source** | A generic identifier (CAIP-10 account, custodial account URI, etc.) for the payment instrument. Bound to the x402 payment payload's sender field. |
| **Issuer** | An entity that signs Principal credentials. Trust is configured by the Verifier via `acceptedIssuers`. |
| **Verifier** | The resource server that registers the VCX extension and executes the four-step verification. |
| **DID** | Decentralized Identifier per [W3C DID Core 1.0](https://www.w3.org/TR/did-core/). |
| **VC** | Verifiable Credential per [W3C VC Data Model 1.1](https://www.w3.org/TR/vc-data-model/). |
| **SD-JWT VC** | SD-JWT-based Verifiable Credentials per [draft-ietf-oauth-sd-jwt-vc-16](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/), used for selective-disclosure presentations. |
| **Identity Envelope** | The three-layer JSON object (Principal + Agent + Payment Source) carried in the `VCX` HTTP header. |
| **Extension Lifecycle Hook** | A function defined by an extension and invoked by the x402 v2 runtime at a defined point: `onPaymentRequired`, `onProtectedRequest`, `onAfterSettle`. |

## 4. Extension Registration and Lifecycle

VCX is registered per route using `declareVCXExtension(...)`:

```typescript
"GET /premium/data": {
  accepts: [{ scheme: "exact", price: "$0.01", network: "eip155:8453" }],
  extensions: declareVCXExtension({
    disclosureTier: 1,
    requiredClaims: ["kycLevel", "ageOver18"],
    minKycLevel: "IdentityVerified",
    acceptedIssuers: ["did:web:paypal.com", "did:web:coinbase.com"],
  }),
}
```

The extension wires three lifecycle hooks into the x402 v2 runtime:

| Hook | Server-side behavior | Client-side behavior |
|------|---------------------|----------------------|
| `onPaymentRequired` | Emit `identityRequirements` in the 402 response, derived from the `declareVCXExtension` arguments. | Detect the requirements in the 402 response; construct and emit a `VCX` header alongside the resumed `X-PAYMENT` request. |
| `onProtectedRequest` | Parse the `VCX` header; run the four-step verification (§9); reject with 403 on failure; attach the verified envelope to request context on success. | (No-op.) |
| `onAfterSettle` | Optionally log the verified envelope correlated with the settlement transaction (§16, Audit Logging). | (No-op.) |

The extension SHALL NOT modify the `X-PAYMENT` header. The `VCX` header is an
independent transport for the identity envelope; this independence enables
identity verification to be implemented, tested, replaced, or removed without
touching the x402 core payment path.

## 5. Identity Requirements (server → client)

The server's `onPaymentRequired` hook MUST include an `identityRequirements`
object in the 402 response alongside the standard x402 payment fields:

```json
{
  "scheme": "exact",
  "network": "eip155:8453",
  "maxAmountRequired": "1000000",
  "resource": "/premium/data",
  "payTo": "0x...",
  "extensions": {
    "vcx": {
      "protocol": "x402-vcx-v1",
      "disclosureTier": 1,
      "requiredClaims": ["kycLevel", "ageOver18"],
      "minKycLevel": "IdentityVerified",
      "acceptedIssuers": ["did:web:paypal.com", "did:web:coinbase.com"]
    }
  }
}
```

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `protocol` | string | MUST | Identifies VCX protocol version. MUST be `"x402-vcx-v1"` for this revision. Clients MUST reject other values. |
| `disclosureTier` | integer (0–2) | MUST | The required selective-disclosure tier (§7). |
| `requiredClaims` | array of string | SHOULD when `disclosureTier === 1` | Names of claim fields the client MUST disclose. Ignored when `disclosureTier === 0` or `2`. |
| `minKycLevel` | string | MAY | Minimum acceptable KYC level (§5.1). The Verifier MUST reject envelopes whose credential `kycLevel` is below this value. |
| `acceptedIssuers` | array of trust-list reference | MUST | Allowed credential issuers, resolvable per §8. The Verifier MUST reject envelopes whose credential issuer cannot be resolved to a DID in this list. Empty array effectively disables VCX-gated access. |

### 5.1 KYC Levels

VCX defines a totally ordered enumeration (increasing assurance):

1. `Unverified`
2. `EmailVerified`
3. `IdentityVerified`
4. `BusinessVerified`

Verifiers MUST treat `minKycLevel` comparisons using this ordering. Issuers
MAY define additional jurisdiction-specific levels by mapping them onto this
scale; they MUST NOT introduce new values in v1.

## 6. Identity Envelope (client → server)

The client's `onPaymentRequired` hook places the identity envelope in a new
HTTP header, `VCX`, on the resumed request. The header value is the
base64-encoded JSON of the envelope:

```
VCX: base64(JSON.stringify(envelope))
```

The decoded envelope MUST have the following shape:

```json
{
  "version": "1.0",
  "protocol": "x402-vcx-v1",
  "transactionId": "9f3a8b21-...-uuid-v4",
  "vcxPresent": true,
  "principal": { ... },
  "agent": { ... },
  "paymentSource": { ... }
}
```

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `version` | string | MUST | Envelope version. MUST be `"1.0"` for this revision. |
| `protocol` | string | MUST | MUST equal the value in `identityRequirements.protocol`. |
| `transactionId` | UUID v4 string | MUST | Client-generated nonce. Subject to uniqueness enforcement per §13.1. |
| `vcxPresent` | boolean | MUST | MUST be the literal `true`. Carries no claim content. Its purpose is to let passive observers (indexers, on/off-chain analytics) flag VCX-attested traffic from envelope headers alone, without dereferencing principal claims — preserving disclosure minimization (§13.5) while still allowing ecosystem-level "VCX usage is rising on these resources" telemetry. |
| `principal` | object | MUST | Principal Layer (§6.1). |
| `agent` | object | MUST | Agent Layer (§6.2). |
| `paymentSource` | object | MUST | Payment Source Layer (§6.3). |

### 6.1 Principal Layer

```json
{
  "credentialFormat": "sd-jwt-vc" | "jwt-vc",
  "credentialJwt": "<JWS-compact serialized VC or SD-JWT VC presentation>",
  "did": "did:web:paypal.com:user/abc",
  "disclosed": {
    "kycLevel": "IdentityVerified",
    "ageOver18": true
  }
}
```

- `credentialFormat` MUST be present in v1. Permitted values: `jwt-vc` (plain
  JWT-based VC) and `sd-jwt-vc` (SD-JWT VC presentation). Verifiers MUST
  reject envelopes whose `credentialFormat` is absent, is not a string, or
  is any value other than these two. The chosen format MUST be consistent
  with the requested `disclosureTier` per §12: Tier 0 and Tier 2 use
  `jwt-vc`; Tier 1 uses `sd-jwt-vc`.
- `credentialJwt` MUST be a JWS-compact-serialized W3C Verifiable Credential.
  Verifier MUST verify the JWS against the Issuer's resolved DID document.
- `did` MUST equal the `credentialSubject.id` of the embedded VC. Verifier
  MUST reject envelopes where these differ.
- `disclosed` contains the claims the client elects (per `disclosureTier`)
  to expose. Each disclosed claim MUST be cryptographically derivable from
  the credential payload (plain JWT: equality check; SD-JWT VC: disclosure
  proof verification).

### 6.2 Agent Layer

```json
{
  "did": "did:key:z6MkAgentKey...",
  "name": "my-payment-agent",
  "delegationProofFormat": "vc-embedded",
  "delegationProof": "<JWT or other proof>"
}
```

- `did` MUST be a `did:key` (§7.1).
- `name` is a human-readable label and MUST NOT be used for authorization
  decisions.
- `delegationProofFormat` MUST be `"vc-embedded"` in v1. See §10.
- `delegationProof` is, in the `vc-embedded` profile, the same JWT as
  `principal.credentialJwt` — the credential's
  `credentialSubject.delegatedTo` carries the delegation.

### 6.3 Payment Source Layer

```json
{
  "accountId": "eip155:8453:0xA11CE...",
  "sourceId": "0xA11CE...",
  "network": "eip155:8453",
  "asset": "0x833589fCD..."
}
```

- `accountId` is the fully-qualified payment-source identifier, typically a
  [CAIP-10](https://chainagnostic.org/CAIPs/caip-10) account ID for crypto
  rails, or a rail-specific URI for traditional rails.
- `sourceId` is the raw sender identifier (e.g., EVM address). The Verifier
  MUST verify it matches the sender field of the x402 payment payload
  (case-insensitive for hex addresses) — see §13.2 for security
  consequences of skipping this check.
- `network` describes the rail (e.g., `eip155:8453` for Base) and MAY be
  used by Verifiers to enforce `allowedNetworks`.
- `asset` is OPTIONAL and identifies the specific token or instrument
  (CAIP-19 form recommended).

### 6.4 Envelope Digest

The **envelope digest** is the canonical content-addressable identifier
for an envelope, suitable for inclusion in facilitator settle-time receipts
(§16) and any other audit-trail artifact that must reproduce envelope
identity at year-*N* without re-transporting the envelope itself.

```
envelopeDigest = "sha256:" + lowercase-hex( sha256( JCS(envelope) ) )
```

- `JCS(envelope)` denotes the JSON Canonicalization Scheme serialization
  of the envelope per §17. JCS is the normative canonicalization for VCX
  digest sites; any digest computed over a non-canonicalized serialization
  is non-conformant.
- The digest MUST be the lowercase-hex SHA-256 of the canonical bytes,
  prefixed with the multihash-style algorithm tag `"sha256:"`.
- The digest covers the entire envelope as transmitted, including
  `vcxPresent`. Two envelopes that differ only in JSON key insertion
  order MUST yield identical digests.

The digest is not carried inside the envelope itself. Components that need
to reference an envelope by identity (facilitators, audit logs,
correlation indexes) compute it from the envelope bytes they observe.

## 7. DID Method Scope

VCX v1 specifies DID method support per role:

| Role | did:key | did:web | did:pkh | Other |
|------|---------|---------|---------|-------|
| **Issuer** (`credentialJwt` signer) | MUST be supported | MUST be supported | MUST NOT (insufficient governance) | Per registry (§7.4) |
| **Principal** (`principal.did`) | MUST be supported | MUST be supported | MUST NOT (no rotation, no status) | Per registry |
| **Agent** (`agent.did`) | MUST be supported | MAY be supported | MUST NOT | Per registry |
| **Payment Source** (`paymentSource.sourceId` semantics) | MAY | MAY | MAY (as CAIP-10 equivalent) | Per registry |

### 7.1 did:key requirements

`did:key` is self-certifying — the public key is encoded in the DID
identifier. No external resolution is required. v1 supports only the
Ed25519 multicodec prefix (`0xed01`). v1.1 MAY add additional curves; see
§14 (Algorithm Agility).

### 7.2 did:web requirements

- Verifiers MUST resolve `did:web` over HTTPS only. Plain HTTP MUST be
  rejected.
- Verifiers MUST validate the TLS certificate (chain validity, expiry,
  hostname match). Self-signed or expired certificates MUST be rejected
  outside of explicit test configuration.
- The resolution path MUST be the path encoded in the DID's
  method-specific identifier, defaulting to `/.well-known/did.json` when
  the path is absent. Verifiers MUST NOT follow HTTP redirects across
  hostname boundaries.
- See §13.3 for the threat model and additional mitigations.

### 7.3 did:pkh role restriction

`did:pkh` (chain-anchored DIDs derived from public keys) has no rotation
mechanism, no service endpoints, and no status mechanism. v1 permits its
*semantics* in the Payment Source layer (where CAIP-10 already provides
equivalent function), but prohibits its use as Principal, Agent, or Issuer.

### 7.4 DID Method Registry

Additional DID methods (e.g., `did:ion`, `did:jwk`, `did:peer`,
`did:cheqd`) MAY be added to v1 via a companion registry document
maintained at `specs/did-methods/`. A new method MUST provide:

1. Resolution algorithm.
2. Trust-model statement (analogous to §13.3 for `did:web`).
3. Statement of which roles (Issuer, Principal, Agent, Payment Source) the
   method is approved for.
4. Implementer references.

A method without all four artifacts MUST NOT be used by VCX verifiers.

## 8. Trust List Distribution

The `acceptedIssuers` field on `identityRequirements` is a list of
**trust-list references**. Each reference MUST be resolvable to a set of
issuer DIDs by one of three transport mechanisms.

### 8.1 Inline reference

A literal array of DID URIs. No external dependency.

```json
"acceptedIssuers": ["did:web:paypal.com", "did:web:coinbase.com"]
```

### 8.2 Well-known endpoint

A URL ending in `/.well-known/vcx-trust-list` returning a **JWS-signed JSON
document**:

```json
"acceptedIssuers": ["https://paypal.com/.well-known/vcx-trust-list"]
```

Response body (after JWS verification):

```json
{
  "issuer": "did:web:paypal.com",
  "validFrom": "2026-01-01T00:00:00Z",
  "validUntil": "2027-01-01T00:00:00Z",
  "issuers": [
    { "did": "did:web:paypal.com", "didDocumentHash": "sha256:..." },
    { "did": "did:web:paypal.com:divisions:cards", "didDocumentHash": "sha256:..." }
  ]
}
```

- The endpoint MUST be served over HTTPS.
- The response MUST be a JWS-signed JSON object (general or flattened JWS
  serialization). The signing key MUST be discoverable through the trust
  list publisher's DID document. Verifiers MUST reject unsigned or
  invalidly-signed responses; transport-level TLS alone is insufficient.
- Verifiers MUST cache responses with a TTL bounded by the HTTP
  `Cache-Control` header, defaulting to one hour if absent.

Each entry in `issuers` is `{ "did": string, "didDocumentHash"?: string }`.
When `didDocumentHash` is present, Verifiers MUST resolve the named DID
document, compute its SHA-256 over the canonical (§17) bytes of the
resolved document, and reject any resolution whose hash does not match.
This neutralizes the DNS/BGP/TLS-MITM threat surface enumerated in §13.3
as long as the trust list itself is uncompromised; the trust list's own
integrity is the JWS check above. `didDocumentHash` values MUST be lowercase-hex SHA-256 prefixed with
the multihash-style algorithm tag `"sha256:"`, matching the
`envelopeDigest` format defined in §6.4. A single tag convention across
all VCX digest sites avoids the maintenance burden of two parallel
parsers.

### 8.3 ETSI Trusted List

A URL pointing to an XML document conforming to
[ETSI TS 119 612](https://www.etsi.org/deliver/etsi_ts/119600_119699/119612/)
v2.2.1 or later. Verifiers MUST validate the embedded XML signature per
ETSI TS 119 612 §5.7.

### 8.4 Trust list integrity

Skipping JWS verification on §8.2 responses, or skipping XML signature
verification on §8.3 responses, enables trust-list substitution attacks
where a compromised CA or transport-level MITM redirects the verifier to
accept attacker-controlled issuers. Verifiers that omit either check are
non-conformant.

## 9. Verification (Four-Step Procedure)

The Verifier MUST execute the following steps in order during the
`onProtectedRequest` hook. If any step fails, the Verifier MUST reject
the request with HTTP 403 and a body containing the failing step name and
a human-readable error.

### 9.1 Step 1 — Principal Credential

1. Resolve the Issuer DID and verify the JWS signature on
   `principal.credentialJwt` using a W3C-compliant VC verifier (plain JWT
   path) or SD-JWT VC verifier (selective-disclosure path).
2. Confirm the credential's `issuer` field is resolvable to a DID listed in
   the trust list referenced by `acceptedIssuers` (§8).
3. **Revocation check** (per §11):
   - If the credential's `validUntil` is ≤ 24 hours from `iss`, treat as
     short-lived profile: no status fetch required; reject if past `exp`.
   - Otherwise, the credential MUST include a `credentialStatus` field
     conforming to Bitstring Status List v1.0; fetch and check the
     referenced status list; reject if the status bit is set for
     `statusPurpose: "revocation"`.
4. Confirm `credentialSubject.id === envelope.principal.did`.
5. If `minKycLevel` is set, confirm `credentialSubject.kycLevel` meets it
   per §5.1.
6. For each claim in `envelope.principal.disclosed`:
   - Plain JWT path: confirm the claim value equals the
     corresponding value in `credentialSubject`.
   - SD-JWT VC path: confirm the disclosure proof verifies against the
     credential signature.
7. For each name in `requirements.requiredClaims`, confirm the claim
   appears in `envelope.principal.disclosed`.

### 9.2 Step 2 — Agent Delegation

The Verifier MUST decode the credential payload (the signature is already
validated at Step 1) and locate `credentialSubject.delegatedTo`. The
following fields are checked according to conformance level:

| Field | Level | Verifier behavior |
|-------|-------|-------------------|
| `delegatedTo.agentDid` | MUST | MUST equal `envelope.agent.did` |
| `delegatedTo.paymentSource` | MUST (when present) | MUST equal `envelope.paymentSource.accountId` |
| `delegatedTo.conditions.expiresAt` | MUST | MUST be present; MUST be a valid ISO 8601 timestamp; MUST be in the future at verification time; MUST NOT be more than 30 days after the credential's `iss` |
| `delegatedTo.conditions.maxPerTransaction` | SHOULD | If present, Verifier MUST enforce against the payment amount in the x402 payload (reject if exceeded) |
| `delegatedTo.conditions.allowedNetworks` | SHOULD | If present (CAIP-2 chain IDs), Verifier MUST reject if `paymentSource.network` is not in the list |
| `delegatedTo.conditions.allowedAssets` | MAY | If present (CAIP-19 asset IDs), Verifier MUST reject if `paymentSource.asset` is absent or is not in the list |
| `delegatedTo.conditions.maxDaily` | MAY | If present, Verifier MUST enforce against its own transaction history (requires stateful verifier) |

Verifiers MUST fail-closed on any key inside `delegatedTo.conditions` that
is not one of the five fields defined above (`maxPerTransaction`,
`maxDaily`, `allowedNetworks`, `allowedAssets`, `expiresAt`).
`delegatedTo.paymentSource` is a sibling of `conditions` (not a key
inside it) and is governed by its own row in this table. Unrecognised
condition keys are unsafe to silently ignore: an issuer that uses a
future-version condition the verifier doesn't enforce would grant
unbounded authority on this deployment. See §13.4.

The 30-day `expiresAt` cap reflects standard credential-hygiene practice for
high-blast-radius delegations. v1.1 MAY relax this for verified institutional
principals via a profile mechanism; v1 implementations of that profile MUST
NOT be deployed.

### 9.3 Step 3 — Payment Source Binding

1. Extract the payment sender field from the x402 payment payload (the path
   is scheme-specific; for `exact_evm` it is
   `payment.payload.authorization.from`; for `exact_solana` it is the
   transaction's fee-payer).
2. Confirm `envelope.paymentSource.sourceId.toLowerCase() === sender.toLowerCase()`.

This binding is the single highest-leverage check in VCX. See §13.2.

### 9.4 Step 4 — Payment Settlement

Settlement is delegated to the x402 v2 core payment flow. VCX does not
redefine settlement. The Verifier MUST mark Step 4 successful only when
x402 settlement has reported success for the same `X-PAYMENT` payload that
the `VCX` header was paired with on the same HTTP request.

## 10. Delegation Format

The Agent Layer's `delegationProofFormat` field is a profile discriminator.
v1 specifies one profile and reserves three values for future profiles:

| Value | Status | Profile |
|-------|--------|---------|
| `vc-embedded` | v1 normative | Delegation embedded in the principal's W3C VC under `credentialSubject.delegatedTo`. `delegationProof` MUST be the same JWT string as `principal.credentialJwt`. |
| `ucan` | RESERVED | [UCAN](https://github.com/ucan-wg/spec). Future profile for capability-based delegation with proof chains. Multi-hop. |
| `cacao` | RESERVED | [CACAO / CAIP-74](https://chainagnostic.org/CAIPs/caip-74). Future profile for wallet-signed delegation in self-custody contexts. |
| `hdp` | RESERVED | [HDP](https://datatracker.ietf.org/doc/draft-helixar-hdp-agentic-delegation/) (individual submission). Future profile for human-to-agent-to-agent provenance. |

VCX v1 verifiers MUST reject any envelope with a `delegationProofFormat`
other than `vc-embedded`. Reserved values are reserved exclusively to
prevent future-version namespace collisions; their semantics will be
defined in subsequent revisions or registered profile documents.

**Single-hop only in v1.** v1 supports only Principal → Agent delegation.
Chained delegation (Principal → Agent → Sub-agent → Tool) requires a
multi-hop security model (delegation narrowing, proof chain verification)
that is out of scope for v1. Implementations MUST NOT interpret v1
envelopes as if they contained delegation chains.

## 11. Credential Revocation

A VCX issuer MUST select exactly one revocation profile per credential.
Verifiers MUST detect the profile from the credential payload and enforce
the corresponding checks during Step 1 verification (§9.1).

### 11.1 Short-lived profile

Credential `exp - iss` MUST be ≤ 24 hours (86400 seconds). The credential
MUST NOT contain a `credentialStatus` field. Verifiers MUST reject
credentials whose `exp` is past the verification time.

This profile is appropriate for high-volume agent-session credentials
where issuance-time guarantees suffice and a status-list fetch on every
verification is an unacceptable cost.

### 11.2 Status-list profile

The credential MUST contain a `credentialStatus` field conforming to
[W3C Bitstring Status List v1.0](https://www.w3.org/TR/vc-bitstring-status-list/)
(Recommendation 15 May 2025) with `statusPurpose: "revocation"`.
Verifiers MUST fetch the referenced status list, verify its JWS signature
against the status-list issuer's DID, and reject credentials with the
status bit set to 1.

In v1, the status-list issuer MUST equal the credential issuer; verifiers
MUST reject envelopes whose status-list and credential issuer DIDs do not
match exactly. This simplifies the v1 trust model — a verifier that
trusts an issuer for principal credentials also trusts it for the
revocation channel — and avoids the orthogonal questions of how to
authorize delegated status-list issuance. A v1.1 profile MAY define a
delegation-of-issuance mechanism (e.g., an explicit `statusListIssuer`
field in the trust list entry, or an issuer-signed delegation
credential); v1 implementations of that profile MUST NOT be deployed.

Verifiers MAY cache status-list responses for up to one hour, subject to
the response's `Cache-Control` directive.

The status list itself is a JWT-encoded W3C VC whose `credentialSubject`
MUST have `type: "BitstringStatusList"`, `statusPurpose: "revocation"`
(matching the entry), and `encodedList` containing the multibase-encoded
(prefix `u` for base64url, no padding) GZIP-compressed bitstring per
Bitstring Status List v1.0 §3.4. Bits are MSB-first within each byte
(§3.1); the bit at position `i` is bit `7 - (i % 8)` of byte
`floor(i / 8)`.

### 11.3 Future profiles

v1.1 MAY define a ZK-friendly accumulator profile (e.g., ALLOSAUR-based)
once those primitives mature. v1 verifiers MUST reject any other profile
value.

## 12. Selective Disclosure

Three tiers govern what claims the Verifier learns. The cryptographic
mechanism backing each tier is normative.

| Tier | Constant | Credential format | What is disclosed |
|------|----------|-------------------|-------------------|
| `0` | `IssuerOnly` | Plain JWT VC (claims limited to `iss`, `sub`, `exp`) | No subject claims. Verifier learns only that a trusted Issuer attested the Principal. |
| `1` | `SelectiveClaims` | [SD-JWT VC](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/) | Only the claims selected by the holder via disclosure proofs. Verifier MUST cryptographically verify each disclosed claim against the credential signature. |
| `2` | `FullDisclosure` | Plain JWT VC with all claims | All claims present in the credential. |

Clients MUST honor the tier requested by the Verifier. Clients MAY disclose
*more* than the minimum (e.g., respond with tier 2 to a tier 1 request)
but MUST NOT disclose less.

**Issuer obligation.** Issuers that wish their credentials to be usable at
Tier 1 MUST issue them in SD-JWT VC format. Issuers that issue only
plain-JWT credentials MAY only support Tier 0 and Tier 2 verifications.
This is a permanent property of an issued credential, not of the
verification flow.

## 13. Security Considerations

### 13.1 Replay

VCX inherits transaction-level replay protection from the x402 payment
layer: `exact_evm` enforces nonce uniqueness via EIP-3009; `exact_solana`
uses recent blockhashes that expire within approximately 150 slots;
equivalent mechanisms are required for all schemes per the x402 core
specification. VCX adds two requirements above this layer:

1. **Envelope binding.** `paymentSource.sourceId` in the identity envelope
   MUST be verified to match the payment payload's sender field
   (§13.2). Verifiers that skip this check enable cross-envelope replay,
   where a valid identity envelope is paired with a different payment
   authorization for the same source.
2. **Transaction-ID uniqueness.** Verifiers MUST reject any envelope whose
   `transactionId` has been processed within the past 300 seconds. This
   check requires verifier-side state (e.g., in-memory cache, Redis,
   distributed deduplication store); the state MUST be consistent across
   the verifier's deployment surface. A load-balanced verifier without
   shared state defeats this check.

Verifiers that omit either check are non-conformant.

### 13.2 Envelope-to-Payment Binding

The Step 3 binding (§9.3) is the highest-leverage check in the protocol.
Without it, a valid identity envelope can be paired with any payment
payload from any source. The check is one comparison; verifiers MUST NOT
treat it as optional.

### 13.3 DID Resolution Trust Model

DID resolution is the most attack-exposed step in VCX verification. Trust
requirements per supported method:

- **`did:key`** — Self-certifying. Public key is encoded in the DID
  itself. No external resolution; no MITM surface.

- **`did:web`** — Resolution MUST use HTTPS with full certificate
  validation. Verifiers MUST reject any `did:web` that resolves over HTTP,
  with an invalid or expired certificate, or whose hostname does not
  exactly match the DID's domain component. Verifiers SHOULD pin issuer
  DID Document hashes when the issuer publishes a hash via its trust list
  entry (§8.2 `didDocumentHash`).

**Threat model for `did:web`:**

- DNS hijacking of the issuer domain
- BGP-level attacks against the issuer's domain
- TLS MITM where the attacker holds a fraudulent certificate for the
  issuer's domain
- Compromise of the issuer's web infrastructure to publish a malicious
  DID document

**Mitigations:**

- *Verifier-side trust list pinning* (§8.2). When the trust list publishes
  a DID document hash, the verifier MUST reject a resolved DID document
  whose hash differs. This neutralizes DNS hijacking, BGP attacks, and
  TLS MITM as long as the trust list itself is not compromised.
- *Issuer-side Certificate Transparency monitoring* (operational, not
  normative). Issuers SHOULD subscribe to CT logs for their domain.
- *Verifier-side change-rate alerting on issuer DID Documents*
  (operational, not normative). Verifiers SHOULD alert when an issuer's
  resolved DID document changes more than once per 24 hours, which
  indicates active compromise or unannounced key rotation.

CT monitoring only protects DIDs whose resolution depends on public-PKI
TLS. DID methods registered in the VCX DID Method Registry that use other
trust roots MUST define equivalent mitigations as a precondition for
registration (§7.4).

### 13.4 Authorization Scope

The `delegatedTo.conditions` block is the basis for bounding agent
authority. v1 mandates enforcement of `expiresAt` (always),
`maxPerTransaction` (when present), `allowedNetworks` (when present), and
`allowedAssets` (when present); see the §9.2 conformance table.

Verifiers MUST fail-closed on any unrecognised key inside
`delegatedTo.conditions`. Silently ignoring an unknown field on the
authority side means an issuer that uses a future-version restriction
(e.g., a `geoFence` v1.1 field added later) on a credential that lands
at a v1 verifier would grant *unbounded* authority instead of the issuer's
intended narrowing — failing open by definition. The whitelist of known
keys is enumerated in §9.2; any future condition fields MUST be added to
the spec before verifiers are expected to recognise them.

### 13.5 Disclosure Minimization

Clients SHOULD use the lowest disclosure tier that satisfies the
Verifier's requirements. Tier 1 with SD-JWT VC is RECOMMENDED for all
production deployments where the resource doesn't strictly require full
disclosure (Tier 2), because it provides cryptographic guarantees against
holder tampering with disclosed claims while still concealing
unrequested claims from the verifier.

### 13.6 Issuer Privacy in Status-List Lookups

When a verifier fetches an issuer's Bitstring Status List (§11.2), the
issuer can observe which credential is being checked, building a usage
graph of verifier-to-principal interactions. Mitigations:

- *Herd-based status lists.* Issuers SHOULD publish status lists that
  cover many credentials (the recommended minimum is 131,072 bits / 16
  KiB compressed) so that any single fetch reveals only that *some*
  credential in the list was checked.
- *Oblivious HTTP* ([RFC 9458](https://www.rfc-editor.org/rfc/rfc9458))
  MAY be used by verifiers that need to hide their lookups from the
  issuer. Issuers MAY publish status lists over OHTTP-compatible
  endpoints to enable this.

### 13.7 Issuer Key Compromise

A compromised Issuer signing key can mint arbitrary credentials, including
forged delegations. Verifiers SHOULD monitor the Issuer's published key
rotation events and SHOULD reject credentials issued during a known
compromise window (as published in the issuer's trust list entry or via
an out-of-band channel). Issuers SHOULD use HSMs or equivalent for
production signing keys.

### 13.8 Consent Recording

The VCX protocol attests that the issuer signed a credential delegating
to a specific agent under specific conditions. It does **not** attest that
the principal *intended* the delegation or that the consent collection
process was sound. Issuers SHOULD have an out-of-band consent mechanism
(KYC re-attestation, explicit principal sign-off via the issuer's UI,
etc.) and SHOULD retain consent records independently of credential
issuance. Verifiers in regulated environments SHOULD require evidence of
this consent process as part of issuer onboarding.

## 14. Algorithm Agility

The credential JWS algorithm is determined by the issuer key and signaled
in the JWT header (`alg` field). v1 implementations MUST support `EdDSA`
(Ed25519). Verifiers MAY support additional algorithms; if so, they MUST
treat the JWT `alg` as untrusted input and apply the same validation
rules that Critical Vulnerability CVE-2015-9235 established for JWT
implementations (no `none`, no algorithm substitution, MUST match the
issuer's published verification material).

Post-quantum signature schemes are out of scope for v1 but the absence
of a hard-coded algorithm in the spec means a future profile can add
them without a protocol-level breaking change.

## 15. Backwards Compatibility

VCX is an x402 v2 extension and depends on the v2 Extensions architecture.
v1 has no defined VCX integration.

**For x402 v2 implementations:**

- Implementations that do not implement VCX continue to interoperate
  normally with x402 v2 servers, regardless of whether those servers
  register a VCX extension on any route.
- A server that registers VCX on a specific route MUST NOT grant access
  to that route from a client that does not present a valid `VCX`
  header satisfying the route's requirements. Other routes on the same
  server that do not register VCX are unaffected.
- Clients that detect a VCX requirement they cannot satisfy SHOULD
  surface a clear error to the user (or upstream agent) indicating that
  identity is required and which acceptedIssuers were specified.

## 16. Audit Logging Requirements

Verifiers in regulated environments SHOULD log the following for each
verified envelope, correlated with the corresponding settlement
transaction:

- `envelope.transactionId`
- `envelope.principal.did`
- The resolved issuer DID (from the verified credential)
- The verification timestamp
- The verification outcome (pass / fail at step N)
- The trust-list reference used (§8)

Spec does not mandate a log format. Implementations are RECOMMENDED to
use a structured log format (JSON Lines, CloudEvents) for downstream
correlation with x402 settlement records.

### 16.1 Audit-time binding via facilitator settle-time receipt

Logging is sufficient for the Verifier's own audit obligations. It is
*not* sufficient for an external auditor reconstructing context at
year-*N* who needs to prove that a specific on-chain settlement was
VCX-attested. The Verifier's logs can be lost, tampered with, or
unavailable to the auditing party. A facilitator-issued settlement
receipt that includes the envelope's content digest (§6.4) closes this
gap with an artifact that is independently observable, survives reorgs,
and does not depend on the Verifier's continuity.

Facilitators MAY embed the envelope digest in settle-time receipts as
follows:

```json
{
  "settled_payment_ref": "...",
  "vcx": {
    "envelopeDigest": "sha256:<lowercase-hex>",
    "issuerDid": "did:web:paypal.com"
  }
}
```

- `envelopeDigest` is the digest defined in §6.4.
- `issuerDid` is the resolved Issuer DID of the verified credential
  (whatever the trust-list resolution at §8 returned). Including only
  these two fields preserves principal-claim privacy at audit-binding
  time; the auditor can correlate without learning what was disclosed.

This subsection is a placeholder. The full normative shape of the
facilitator receipt — algorithm tag set, signature requirements,
which scheme adapters MUST/MAY emit it, the relationship to existing
x402 settlement receipts — is being specified in a companion PR and is
out of scope for VCX v1.0. v1.0 verifiers MUST NOT depend on the
presence of `vcx.envelopeDigest` in any receipt; producers MUST treat
it as opt-in until the companion spec lands.

## 17. Canonicalization

VCX defines a canonical JSON encoding for any envelope digest site (§6.4)
and for any future digest, signature, or content-address surface inside
the protocol. The canonical encoding is **JSON Canonicalization Scheme
(JCS)** per [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), defined
inline below to fix the algorithm to this revision without external
revision risk.

### 17.1 Algorithm

A canonical serialization of a JSON value is produced as follows:

1. **Object keys are sorted by UTF-16 code-unit order** per RFC 8785 §3.2.3.
   This matches JavaScript's default `Array.prototype.sort` comparison on
   strings. For property names containing only BMP characters (the typical
   case for VCX envelopes), this is identical to Unicode code-point order;
   the two diverge only for keys containing characters above U+FFFF.
2. **No insignificant whitespace.** No spaces, tabs, or newlines outside
   string values. No trailing whitespace.
3. **Number serialization** follows ECMA-404 / ECMA-262 §7.1.12.1
   (`ToString` applied to a Number): no leading zeros except for `0`
   itself, no trailing zeros after a decimal point, exponential notation
   only when the magnitude requires it. Integers MUST be serialised
   without a decimal point.
4. **String escaping** uses the minimal escape set: `"`, `\`, U+0000–
   U+001F. Other characters are emitted as raw UTF-8 bytes; no `\u`
   escapes for characters that do not require them.
5. **Arrays preserve declaration order.** No sorting; element-position
   semantics are part of the canonical form.

Implementers MAY use any conformant JCS library. The TypeScript
reference SDK uses the `canonicalize` npm package (RFC 8785 reference
implementation, MIT).

### 17.2 Determinism property

Two serializations of the same JSON value MUST produce byte-identical
output. The reference test corpus (`test/fixtures/canonicalize/`)
includes cross-language conformance vectors; new VCX implementations
SHOULD pass these vectors before claiming JCS conformance.

### 17.3 Where canonicalization is mandatory

| Site | Section | Notes |
|------|---------|-------|
| `envelopeDigest` over the envelope | §6.4 | The single normative digest site in v1.0. |
| `didDocumentHash` over a resolved DID document | §8.2 | Computed by the trust-list publisher at registration time; recomputed by the Verifier at resolution time; bytes MUST match exactly. |
| Future digest, signature, or content-address sites added in v1.1+ | n/a | Reserved. v1 implementations MUST NOT invent additional digest sites. |

## 18. Open Questions

1. **AP2 alignment.** When AP2 (or any agentic-payments orchestration
   layer) sits on top of x402 v2, what does the VCX envelope look like
   for AP2-mediated transactions? Does the agent layer identify the AP2
   instance, the principal's session, or both? A v1.1 profile may be
   needed.
2. **Trust-list governance at the foundation level.** §8 defines *how*
   trust lists are distributed but not *who* maintains the foundation-
   recommended issuer list (if any). Foundation-governance question; the
   answer affects deployment.

## 19. v1.0 Implementation Status

The `@x402/vcx` v1.0 reference implementation conforms to all v1.0
normative MUSTs in this specification. Other-language SDKs claiming v1.0
conformance MUST implement every item in the **v1.0 SDK conformance** list
below.

**v1.0 SDK conformance (MUST be implemented):**

- §6 Identity Envelope with `version`, `protocol`, `transactionId`,
  `vcxPresent`, `principal`, `agent`, `paymentSource` fields
- §6.1 `credentialFormat` field parsing and enum enforcement
- §6.2 `delegationProofFormat` field parsing and enum enforcement
- §6.4 `envelopeDigest` computation over JCS-canonicalized bytes
- §7.1 `did:key` (Ed25519) resolution
- §7.2 `did:web` resolution with full TLS hardening (HTTPS-only, chain
  validation, hostname match, no cross-host redirect)
- §8.1 Inline trust-list references (DID URIs)
- §8.2 Well-known JWS-signed trust list transport, with `didDocumentHash`
  pinning enforcement when present
- §9.1 Step 1 full: JWS signature, trust-list issuer membership,
  revocation per §11, subject-DID match, fail-closed KYC, plain-claim
  equality for `jwt-vc`, SD-JWT VC disclosure proof verification for
  `sd-jwt-vc`
- §9.2 Step 2 full: `agentDid` match, `paymentSource` match,
  `expiresAt` MUST + 30-day cap, `maxPerTransaction` enforcement,
  `allowedNetworks` enforcement, `allowedAssets` enforcement,
  fail-closed on unknown condition fields
- §9.3 Step 3: sender ↔ `sourceId` binding plus `sourceId` ↔
  `accountId`-address-component binding
- §9.4 Step 4 passthrough placeholder (settlement-correlation deferred —
  see v1.1 below)
- §10 `delegationProofFormat: "vc-embedded"` (the v1 normative profile)
- §11.1 Short-lived revocation profile (`exp - nbf ≤ 86400s`)
- §11.2 Bitstring Status List v1.0 revocation with JWS-verified status
  list and Cache-Control-respecting cache
- §12 All three disclosure tiers: Tier 0 (plain JWT VC), Tier 1 (SD-JWT
  VC with cryptographic disclosure proof), Tier 2 (plain JWT VC full)
- §13.1 transactionId uniqueness via pluggable storage, verify-then-
  record ordering
- §13.2 Envelope-to-payment binding
- §13.4 Fail-closed on unknown delegation condition fields
- §17 JCS canonicalization for the `envelopeDigest` and `didDocumentHash`
  sites

**Deferred to v1.1 (explicit non-goals for v1.0):**

- §7.4 DID Method Registry (registration mechanism for DID methods
  beyond `did:key` and `did:web`). v1.0 SDKs are not expected to
  implement registry resolution.
- §8.3 ETSI Trusted List transport (`ETSI TS 119 612` XML signature
  verification). v1.0 verifiers MUST reject ETSI references with an
  explicit "deferred" error rather than silently fail.
- §9.4 Step 4 actual settlement-correlation. v1.0 marks Step 4 success
  on the x402 v2 settlement-completion signal; richer correlation with
  the settled receipt is a v1.1 binding. See §16.1 for the audit-time
  binding shape that v1.1 will normatively specify.
- §13.6 OHTTP herd-based issuer-privacy lookups (verifier-side). v1.1.
- §16 `onAfterSettle` audit-log correlation with the settled receipt
  (operationally orthogonal to §16.1 audit-time binding).
- Settlement-attestation profile and composite-trust-query profile —
  located at the profile layer, addressed in future profile documents.

**Reference SDK release history:**

- `@x402/vcx@0.1.0` (released 2026-05): initial protocol shape and
  four-step verification with the v1.0-deferred items omitted.
- `@x402/vcx@0.2.0` – `@x402/vcx@0.6.0` (in flight): incremental v1.0
  conformance closure (envelope hardening, observability/audit-binding,
  full delegation, revocation, did:web TLS hardening, well-known trust
  list).
- `@x402/vcx@1.0.0` (planned): SD-JWT VC selective disclosure lands;
  full v1.0 SDK conformance per the list above.

Deployers running pre-1.0 SDK versions MUST treat their deployment as
non-conformant against the missing items and SHOULD upgrade to 1.0.0
before relying on VCX-attested decisions in regulated environments.

## Appendix A — Example Flow

### A.1 Server 402 response

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "scheme": "exact",
  "network": "eip155:8453",
  "maxAmountRequired": "1000000",
  "resource": "/premium/data",
  "payTo": "0xC8EA702C...",
  "extensions": {
    "vcx": {
      "protocol": "x402-vcx-v1",
      "disclosureTier": 1,
      "requiredClaims": ["kycLevel", "ageOver18"],
      "minKycLevel": "IdentityVerified",
      "acceptedIssuers": ["did:web:paypal.com"]
    }
  }
}
```

### A.2 Client resumed request

```http
GET /premium/data HTTP/1.1
X-PAYMENT: <unchanged base64 of x402 v2 payment payload>
VCX: <base64 of the JSON below>
```

```json
{
  "version": "1.0",
  "protocol": "x402-vcx-v1",
  "transactionId": "8f3a8b21-...-uuid",
  "principal": {
    "credentialFormat": "sd-jwt-vc",
    "credentialJwt": "eyJhbGciOiJFZERTQSIs...~WyJyYW5kb20iLCJrW...",
    "did": "did:web:paypal.com:user/abc",
    "disclosed": {
      "kycLevel": "IdentityVerified",
      "ageOver18": true
    }
  },
  "agent": {
    "did": "did:key:z6MkAgent...",
    "name": "my-payment-agent",
    "delegationProofFormat": "vc-embedded",
    "delegationProof": "eyJhbGciOiJFZERTQSIs..."
  },
  "paymentSource": {
    "accountId": "eip155:8453:0xA11CE...",
    "sourceId": "0xA11CE...",
    "network": "eip155:8453"
  }
}
```

### A.3 Verifier success response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "data": "..." }
```

### A.4 Verifier failure response (verification step 3 fails)

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json

{
  "error": "Identity verification failed",
  "failedStep": "payment_source_binding",
  "detail": "Payment source 0xA11CE... does not match payment sender 0xOTHER..."
}
```

## References

### Public Standards

VCX is an application of established, openly published specifications and
conventions. It implements them independently; it does not depend on or derive
from any single vendor implementation of them.

| Standard / Convention | Reference | Used in |
|---|---|---|
| JSON Canonicalization Scheme (JCS) | RFC 8785 | §6.4, §17 (canonical bytes for digesting/signing) |
| SHA-256 | FIPS 180-4 | §6.4, §8.2 (envelope and document digests) |
| `sha256:<lowercase-hex>` digest prefix | Multihash / OCI-style content-digest convention | §6.4, §8.2 |
| Verifiable Credentials Data Model | W3C VC Data Model 1.1 | §6 (envelope), §10 (delegation), §12 (disclosure) |
| Bitstring Status List | W3C Bitstring Status List v1.0 | §11.2 (revocation) |
| SD-JWT Verifiable Credentials | SD-JWT VC (IETF, draft) | §12 Tier 1 (selective disclosure) |
| Decentralized Identifiers | W3C DID Core; `did:key`, `did:web` methods | §7 (agent identity) |
| JSON Web Signature | RFC 7515 (JWS) | §8 (trust-list signatures), §9 (verification) |

These building blocks are widely used across the ecosystem and are not specific
to any one implementation. VCX composes them in TypeScript, against general-purpose
libraries, applied to the identity envelope defined in this specification.

### Normative

- x402 core protocol v2 — https://github.com/x402-foundation/x402
- [W3C Verifiable Credentials Data Model 1.1](https://www.w3.org/TR/vc-data-model/)
- [W3C Decentralized Identifiers (DIDs) 1.0](https://www.w3.org/TR/did-core/)
- [W3C Bitstring Status List v1.0](https://www.w3.org/TR/vc-bitstring-status-list/) — Recommendation 15 May 2025
- [SD-JWT VC (draft-ietf-oauth-sd-jwt-vc-16)](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/) — April 2026
- [CAIP-10: Account ID Specification](https://chainagnostic.org/CAIPs/caip-10)
- [CAIP-2: Blockchain ID Specification](https://chainagnostic.org/CAIPs/caip-2)
- [ETSI TS 119 612](https://www.etsi.org/deliver/etsi_ts/119600_119699/119612/) v2.2.1 or later
- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119): Key words for use in RFCs to Indicate Requirement Levels
- [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174): Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words
- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) §15.5.2: HTTP 402 Payment Required

### Informative

- [UCAN](https://github.com/ucan-wg/spec) — referenced future delegation profile
- [CACAO / CAIP-74](https://chainagnostic.org/CAIPs/caip-74) — referenced future delegation profile
- [HDP (draft-helixar-hdp-agentic-delegation-00)](https://datatracker.ietf.org/doc/draft-helixar-hdp-agentic-delegation/) — referenced future delegation profile (individual submission)
- [did-jwt-vc](https://github.com/decentralized-identity/did-jwt-vc) — reference implementation library
- [RFC 9458](https://www.rfc-editor.org/rfc/rfc9458): Oblivious HTTP — referenced for issuer-privacy mitigation
- Sign-In-With-X (SIWX) extension — sibling extension under `@x402/extensions`, used as the architectural precedent for VCX
