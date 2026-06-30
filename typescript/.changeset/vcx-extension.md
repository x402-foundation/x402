---
"@x402/extensions": minor
---

Add VCX (Verifiable Credential Exchange) — a new identity extension under
`@x402/extensions/vcx` matching the spec at `specs/extensions/vcx.md`
(originally proposed on x402-foundation/x402#2400).

VCX adds a `VCX` HTTP header carrying a three-layer identity envelope
(Principal VC + Agent DID + Payment Source) and integrates via the
standard `onPaymentRequired` / `onProtectedRequest` v2 extension
lifecycle hooks. Verifiers run a four-step verification (principal
credential JWS + revocation + trust list + hash pinning, agent
delegation conditions, envelope-to-payment binding, settlement
passthrough). Implements every v1.0 spec MUST in §6–§17 with the
explicit §18 v1.1 carve-outs (ETSI Trusted List, full DID Method
Registry expansion, OHTTP, `onAfterSettle` correlation,
settlement-attestation profile).

Public surface (importable from `@x402/extensions/vcx` or via the
package root barrel):

- Extension factories: `createVCXResourceServerExtension`,
  `createVCXClientExtension`, `declareVCXExtension`
- Verification: `verifyEnvelope` (with `VerifyEnvelopeOptions` covering
  `paymentAmount`, `dailyLimitStore`, `strictDelegationConditions`,
  `statusListCache`, `trustListCache`, `fetchImpl`)
- Envelope: `buildIdentityEnvelope`, `buildEnvelopeFromRequirements`,
  `canonicalEnvelope`, `envelopeDigest`
- Revocation: `checkCredentialStatus`, `InMemoryStatusListCache`
- Trust list: `resolveAcceptedIssuers`, `verifyDidDocumentHash`,
  `InMemoryTrustListCache`
- Resolver: `getDidResolver`, `buildHardenedWebResolver`,
  `configureDidWebResolver`, `didWebToUrl`
- Credentials: `createVCXIssuer`, `issueCredential` (supports
  `format: "jwt-vc" | "sd-jwt-vc"` with `selectivelyDisclosable: string[]`)
- SD-JWT VC primitives: `verifySdJwtVcPresentation`, `buildDisclosure`,
  `disclosureHash`, `parseDisclosure`, `parseSdJwt`,
  `buildSdIssuerSubject`, `composeSdJwt`
- Identity primitives: `generateEd25519KeyPair`, `publicKeyToDidKey`,
  `buildDid`, `createAgent`, `buildDelegation`,
  `buildCredentialSubject`, `meetsKycRequirement`
- Storage: `InMemoryNonceStorage`, `NoOpNonceStorage`, plus the
  `NonceStorage` and `DailyLimitStore` interfaces
- Header transport: `VCX_HEADER_NAME`, `encodeVCXHeader`,
  `parseVCXHeader`
- Schema: `buildVCXEnvelopeSchema`

New runtime dependencies:

- `did-jwt` (^8.0.0, Apache 2.0) — JWS for VCs and SD-JWT VCs
- `did-jwt-vc` (^4.0.0, Apache 2.0) — W3C VC JWT issuance/verification
- `did-resolver` (^4.1.0, Apache 2.0) — DID resolution glue
- `canonicalize` (^2.0.0, MIT) — RFC 8785 JCS for envelope/document
  digest computation

Spec MUSTs implemented:

§6 envelope (vcxPresent + credentialFormat + delegationProofFormat),
§6.4 envelopeDigest, §7.1 did:key, §7.2 did:web with full TLS
hardening (HTTPS-only, cert validation, no cross-host redirect),
§8.1 inline + §8.2 well-known JWS-signed trust list + didDocumentHash
pinning, §9.1–§9.4 four-step verification, §10 vc-embedded delegation,
§11.1 short-lived + §11.2 Bitstring Status List v1.0 revocation,
§12 all three disclosure tiers including Tier 1 SD-JWT VC with
cryptographic disclosure-proof verification, §13.1 transactionId
uniqueness, §13.2 envelope-to-payment binding, §13.4 fail-closed on
unknown delegation conditions, §17 JCS canonicalization.

Notes on the SD-JWT VC layer: the v1.0 reference impl is self-contained
(~250 LOC under `src/vcx/envelope/sdjwtvc.ts`), supporting the
presentation flow VCX uses. Scope is deliberately narrow — no
key-binding-JWT verification, no recursive disclosures, no
array-element disclosures. A future PR MAY swap to `@sd-jwt/core`
without changing the public `verifySdJwtVcPresentation` signature.
