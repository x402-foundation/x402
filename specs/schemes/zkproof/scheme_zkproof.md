# Scheme: `zkproof`

## Summary

`zkproof` is a scheme that grants access to resources based on zero-knowledge proofs (ZKPs) instead of monetary transfers. It leverages zkTLS proofs to verify user claims (e.g., "has active subscription") without revealing private data. This enables payment-free access for qualified clients or AI agents, while maintaining x402's trust-minimizing principles. The scheme sets `maxAmountRequired` to "0" and focuses on proof verification rather than settlement.

This proposal addresses the [Identity Solution](https://github.com/coinbase/x402/blob/main/ROADMAP.md#identity-solution-solutionsguides-first) roadmap item, which aims to provide KYC/eligibility signals using existing identity services compatible with x402. This specification uses **Reclaim Protocol as an example implementation**, but the scheme is designed to be compatible with multiple zkTLS providers including:

- **Reclaim Protocol** (used in this specification as reference)
- **Primus**
- **zkPass**
- **Opacity**
- **bringID**
- **TLSN (Transport Layer Security Notarization)**
- Other zkTLS/privacy-preserving attestation providers

The scheme architecture is provider-agnostic, allowing facilitators and resource servers to support multiple zkTLS backends.

## Use Cases

- AI agents proving eligibility (e.g., affiliation with a partner) to bypass payments.
- Users verifying subscriptions or identities for free access to paywalled content.
- Conditional access in DeFi or content platforms (e.g., prove KYC status without payment).
- Hybrid models: Accept `exact` payments or `zkproof` for verified users.

## Appendix

### Roadmap Alignment

This scheme directly addresses the x402 [Identity Solution roadmap item](https://github.com/coinbase/x402/blob/main/ROADMAP.md#identity-solution-solutionsguides-first), which seeks to provide KYC/eligibility signals without inventing a new identity protocol. Instead, it curates best-practice guides using existing identity services compatible with x402.

### zkTLS Provider Compatibility

This specification uses Reclaim Protocol as a reference implementation, but the `zkproof` scheme is designed to be provider-agnostic. Proofs are generated client-side using the provider's SDK and verified by the facilitator (offchain via provider SDK or onchain via verifier contracts). No funds are moved; "settlement" optionally records the proof onchain for immutability and replay prevention.

**Supported zkTLS Providers:**
- Reclaim Protocol (reference implementation in this spec)
- Primus
- zkPass
- Opacity
- bringID
- TLSN (Transport Layer Security Notarization)
- Other zkTLS/privacy-preserving attestation protocols

Future network implementations can extend this scheme to support additional zkTLS providers by following the same verification pattern: client generates proof → facilitator verifies proof → access granted if valid.

