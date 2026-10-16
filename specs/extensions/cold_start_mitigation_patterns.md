# Cold-Start Mitigation Patterns for `8004-reputation`

## Status

Informative draft.

This document describes pre-payment trust signals that can complement the in-flight `8004-reputation` work during a service or agent's cold-start phase. It does **not** modify the `8004-reputation` protocol flow, define universal trust thresholds, or replace post-payment reputation.

## Motivation

`8004-reputation` is strongest after a client has already:

1. discovered a service
2. paid through x402
3. received the service
4. submitted feedback into the reputation system

That feedback loop is exactly what should remain authoritative over time. The gap is earlier:

- a new service may have no feedback yet
- a service moving to a new market may have thin local history
- a client may want independently verifiable signals before the first paid request

Without a shared shape for those signals, every client invents a different bootstrap policy and every provider has to satisfy one-off integrations.

## Design Goals

Cold-start signal patterns should be:

- **complementary** to `8004-reputation`, not a replacement for it
- **optional**, so clients can ignore them and apply local policy
- **provider-agnostic**, so new providers do not need bespoke client integrations
- **independently verifiable**, so clients can validate what they trust
- **forward-compatible**, so unknown categories and signal types do not break older clients

## Data Model

A registration record or discovered resource MAY expose a `coldStartSignals` object directly, or nest it under `metadata.coldStartSignals`. This draft standardizes the inner object only.

```json
{
  "coldStartSignals": {
    "onChainCredentials": [],
    "onChainActivity": [],
    "offChainAttestations": [],
    "discoveryAttestations": []
  }
}
```

### Known Categories

| Category | Purpose | Example signal families |
| --- | --- | --- |
| `onChainCredentials` | Third-party credentials anchored onchain | EAS attestations, registry entries, non-transferable credentials, compliance attestations |
| `onChainActivity` | Observed wallet or economic behavior | stablecoin balances, staking participation, long-lived activity, wallet trust profiles |
| `offChainAttestations` | Signed claims not anchored directly in chain state | DIDs, verifiable credentials, domain or organization proofs, reasoning attestations |
| `discoveryAttestations` | Signed observations about service behavior | uptime, compatibility checks, availability probes, registry health JWTs |

Clients MUST ignore unknown categories.

### Generic Signal Shape

Each signal entry MUST include a provider-defined `type`, a `subject` identifying the service, agent, account, or request evaluated by the signal, and a stable `provider` identifier. Unknown `type` values MUST be ignored unless a client has explicit policy for them.

```json
{
  "type": "serviceHealth",
  "subject": "https://agent.example/x402",
  "provider": "discovery-service",
  "checkedAt": "2026-03-11T12:00:00Z",
  "ttlSeconds": 300,
  "sig": "base64url-signature",
  "kid": "provider-key-1",
  "jwks": "https://provider.example/.well-known/jwks.json",
  "alg": "EdDSA"
}
```

### Common Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | `string` | Provider-defined signal type |
| `subject` | `string` | Stable identifier for the service, agent, account, or request evaluated by the signal |
| `provider` | `string` | Stable identifier for the signal provider or issuer |
| `checkedAt` | `string` | RFC 3339 timestamp for when the signal was checked or issued |
| `ttlSeconds` | `number` | Non-negative integer freshness window in seconds |
| `sig` | `string` | Optional detached signature over the signal payload |
| `kid` | `string` | Optional key identifier for the signing key |
| `jwks` | `string` | Optional HTTPS JWKS hint |
| `alg` | `string` | Optional signature algorithm hint |

Signals used in an automated pre-payment decision MUST include `type`, `subject`, `provider`, `checkedAt`, and `ttlSeconds`. Signed signals MUST include `sig` and `kid`. A client MAY display incomplete or unsigned signals as advisory metadata, but MUST NOT count them as trusted evidence unless it verifies the claim directly against an authoritative source defined by its policy.

`subject` prevents a valid signal from being copied to a different registration or resource. Before using a signal, a client MUST compare `subject` with the canonical identifier of the service, agent, account, or request it is evaluating. Subject matching rules are signal-type-specific and MUST be part of the client's allowlisted policy.

### Verification and Key Trust

A signal is usable for an automated decision only when all of the following are true:

1. its category, `type`, and `provider` are recognized by explicit client policy
2. its `subject` matches the object being evaluated
3. its freshness metadata passes the checks in [Freshness and Replay](#freshness-and-replay)
4. the client verifies either a detached signature from a locally trusted issuer or the claim directly against an authoritative source

The `jwks` field is a discovery hint, not a trust anchor. Clients MUST NOT trust or fetch an arbitrary key solely because its URL appears in a signal. Key resolution MUST start from pinned configuration, an allowlisted provider-to-JWKS mapping, or another authenticated local trust relationship. A `kid` MUST be resolved within the trusted provider's key namespace rather than as a globally meaningful identifier. Networked resolvers MUST require HTTPS and apply normal SSRF protections.

This draft is intentionally algorithm-agnostic. Providers MAY use RSA, P-256 ECDSA, Ed25519, or other JWK-expressible schemes. Clients MUST restrict accepted algorithms through local policy and MUST ensure the selected algorithm is compatible with the trusted JWK metadata. The untrusted `alg` field MUST NOT override that policy.

### Default Detached Signature Payload

Unless a signal type defines another signed envelope, providers and clients MUST construct the default detached signature payload as follows:

1. copy the signal object and remove `sig`, `kid`, `jwks`, and `alg`
2. require the remaining value to conform to the I-JSON constraints used by [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)
3. canonicalize the object with the JSON Canonicalization Scheme defined by RFC 8785
4. encode the canonical JSON as UTF-8
5. sign or verify those bytes with the policy-approved algorithm and key

`sig` MUST contain the resulting signature using the unpadded base64url alphabet from [RFC 4648, Section 5](https://www.rfc-editor.org/rfc/rfc4648#section-5).

Signal types that use JWS, JWT, Verifiable Credentials, or another signed envelope MUST define their own payload and verification rules. They MUST still bind the claim to `subject` and meet this document's trust and freshness requirements.

## Category Guidance

### `onChainCredentials`

Use this category for third-party credentials that are anchored in onchain data and attributable to an issuer.

```json
{
  "type": "eas",
  "subject": "eip155:8453:0x1234...",
  "provider": "eas-indexer.example",
  "chainId": 8453,
  "schemaId": "0x...",
  "attester": "0x...",
  "result": true,
  "checkedAt": "2026-03-11T12:00:00Z",
  "ttlSeconds": 300,
  "sig": "base64url-signature",
  "kid": "provider-key-1",
  "jwks": "https://provider.example/.well-known/jwks.json",
  "alg": "ES256"
}
```

Other valid examples in this category include:

- `type: "compliance-attestation"` for AML/CFT or sanctions screening receipts
- provider-signed ERC-8004 registration or validation snapshots
- non-transferable credential checks such as SBT presence

### `onChainActivity`

Use this category for observed wallet behavior or economic participation signals derived from chain state.

```json
{
  "type": "walletTrust",
  "subject": "eip155:8453:0x1234...",
  "provider": "example-provider",
  "compositeScore": 0.65,
  "dimensions": {
    "stablecoins": { "score": 0.8 },
    "governance": { "score": 0.6 },
    "staking": { "score": 0.5 }
  },
  "checkedAt": "2026-03-11T12:00:00Z",
  "ttlSeconds": 300,
  "sig": "base64url-signature",
  "kid": "provider-key-1",
  "jwks": "https://provider.example/.well-known/jwks.json",
  "alg": "ES256"
}
```

Clients SHOULD prefer dimension-aware evaluation over a single composite score when task-specific context matters.

### `offChainAttestations`

Use this category for signed claims that are portable but not directly anchored in chain state.

```json
{
  "type": "did",
  "subject": "did:pkh:eip155:8453:0x1234...",
  "provider": "did-verifier.example",
  "id": "did:pkh:eip155:8453:0x1234...",
  "alternateIds": [
    "did:key:z6Mk...",
    "did:web:agent.example.com"
  ],
  "verifiableCredentials": [
    {
      "type": "HumannessCredential",
      "issuer": "did:web:issuer.example"
    }
  ],
  "checkedAt": "2026-03-11T12:00:00Z",
  "ttlSeconds": 300
}
```

The current issue discussion treats `did:pkh`, `did:key`, and `did:web` as all in-bounds. For EVM-native agents, `did:pkh` is a natural default because it reuses the existing wallet identity with minimal extra setup.

Other valid examples in this category include:

- domain verification proofs
- code audit or organization credentials
- `type: "reasoningAttestation"` or equivalent verifier receipts for payment-decision integrity

### `discoveryAttestations`

Use this category for signed observations about service behavior or availability.

```json
{
  "type": "serviceHealth",
  "subject": "https://agent.example/x402",
  "provider": "x402-discovery",
  "serviceId": "legacy/cf-pay-per-crawl",
  "uptimePct": 98.2,
  "avgLatencyMs": 340,
  "facilitatorCompatible": true,
  "chainVerifications": {
    "erc8004Registered": true,
    "operatorWalletTrust": {
      "provider": "trust-provider",
      "trustId": "TRST-XXXXX"
    }
  },
  "checkedAt": "2026-03-11T12:00:00Z",
  "ttlSeconds": 300,
  "sig": "base64url-signature",
  "kid": "discovery-key-1",
  "jwks": "https://discovery.example/.well-known/jwks.json",
  "alg": "EdDSA"
}
```

This category answers a different question than identity-oriented categories:

- identity categories ask: **who is this actor?**
- discovery attestations ask: **does this service appear to work as advertised?**

Providers MAY also package discovery attestations as signed JWTs or equivalent signed envelopes, as long as the payload shape, subject binding, freshness semantics, and verification metadata are documented.

## Client Processing Model

Recommended high-level flow:

1. discover the service or registration record
2. inspect available `8004-reputation` history
3. if reputation is thin, inspect `coldStartSignals`
4. retain only categories, signal types, and providers recognized by explicit local policy
5. require each signal's `subject` to match the object being evaluated
6. apply the freshness and future-timestamp checks defined below
7. verify each remaining claim with a trusted signature or authoritative-source check
8. combine the verified signals with local payment policy
9. after real interactions, increasingly defer to accumulated `8004-reputation`

This document does **not** standardize thresholds or score cutoffs. It also does not mandate a universal trust-tier table. However, tiered local policy is an expected use of these signals, and implementers may reasonably map combinations of cold-start signals to payment tiers such as trial, standard, or high-trust access.

## Implementation Guidance

Parsers SHOULD ignore unknown categories without rejecting recognized categories. They MAY preserve unknown signal types for diagnostics or future policy updates, but trust evaluation MUST use an explicit allowlist rather than treating every syntactically valid signal as evidence.

Implementations SHOULD keep parsing, cryptographic verification, and payment policy separate. A cryptographically valid signal means only that a particular key signed a particular payload; it does not establish that the issuer, signal type, subject, or claim is appropriate for the current payment.

## Freshness and Replay

Cold-start signals often depend on changing state. For a signal checked at time `checkedAt`, clients MUST calculate `expiresAt = checkedAt + ttlSeconds` and reject the signal when `now > expiresAt`.

Clients MUST reject a signal from automated trust evaluation when:

- either `checkedAt` or `ttlSeconds` is missing
- `checkedAt` is not a valid RFC 3339 timestamp
- `ttlSeconds` is not a non-negative integer
- the signal is expired
- `checkedAt` is later than `now` plus the client's allowed clock skew

The allowed clock skew is local policy and SHOULD default to no more than 60 seconds. A future timestamp inside that allowance does not extend `expiresAt`; expiration is always calculated from the signed `checkedAt` value.

Clients SHOULD scale accepted TTLs and verification depth with payment risk.

- low-value payments may accept cached signals
- medium-value payments should prefer recent signed signals
- high-value payments may require direct provider refresh or direct verification

Some signal families are especially time-sensitive:

- compliance receipts may need shorter TTLs because sanctions lists can change quickly
- discovery attestations may need tighter windows for high-value routing decisions
- reasoning or verification attestations may be tied to a single payment or request and should include a request identifier or nonce in their type-specific signed payload

## Security Considerations

### Provider compromise

Signed signals are only as trustworthy as their signing keys, issuance controls, and verification policy. Clients SHOULD pin or otherwise trust-manage key material for high-value flows.

### Subject substitution

Signature validity without subject matching permits a valid claim to be copied onto another registration or resource. Clients MUST verify `subject` before using a signal and MUST reject ambiguous or mismatched identifiers.

### Key discovery and SSRF

An attacker controls the contents of an unverified signal, including `jwks`. Clients MUST NOT use that hint as authority to access arbitrary network locations or accept an otherwise untrusted key. Resolvers SHOULD use pinned or allowlisted HTTPS endpoints, reject redirects to disallowed origins, and block private or link-local network targets unless explicitly configured.

### Temporary or manipulated positions

Onchain activity can be inflated temporarily. Signed attestations with short TTLs provide freshness and tamper evidence, but do not prove that the underlying position is durable. Clients SHOULD avoid treating activity-only signals as equivalent to long-lived reputation.

### Category concentration

Relying on a single category creates a single failure mode. Higher-value interactions SHOULD prefer signals from multiple categories when available.

### Canonical payload and algorithm confusion

The default detached-signature procedure is defined above to prevent implementations from signing different JSON byte sequences. Clients MUST reject payloads that cannot be represented under RFC 8785 rather than silently transforming them. Clients MUST also reject algorithms or key types outside local policy, even when `alg` or the supplied JWK requests them.

## Relationship to `8004-reputation`

These patterns are intentionally complementary:

- `coldStartSignals` help when there is little or no interaction history
- `8004-reputation` becomes the stronger signal after real usage accumulates
- clients MAY keep both as defense-in-depth, but cold-start signals should not redefine the `8004-reputation` flow

## Future Work

Possible follow-on work:

- standard schemas and subject-matching rules for common signal types
- support for additional signature algorithms and key-distribution helpers
- optional vocabulary for trust tiers or minimum signal counts
- tighter linkage with registry-specific schemas once the surrounding discovery work settles

## Acknowledgements

The design of the `coldStartSignals` schema and the patterns in this document emerged from the community discussion in [#1375](https://github.com/x402-foundation/x402/issues/1375). Key contributions include:

- **@douglasborthwick-crypto** — the three-category signal taxonomy (`onChainCredentials`, `onChainActivity`, `offChainAttestations`), the inline `sig`/`kid`/`jwks` verification pattern, the freshness/TTL model, and detailed EAS attestation and wallet trust schemas
- **@ruhil6789** — DID/Verifiable Credentials integration design, the `did:pkh` recommendation for EVM agents, and the category-based extensible schema structure
- **@rplryan** — `discoveryAttestations` as a fourth category, the behavioral trust dimension, service health attestation schemas, and the first signed attestation prototype
- **@ThoughtProof** — reasoning attestation concept for payment-decision integrity verification
- **@INJprotocol** — compliance attestation schema for AML/CFT signals
- **@0xtus** — concrete implementation notes from the Azeth smart account + ERC-8004 integration
