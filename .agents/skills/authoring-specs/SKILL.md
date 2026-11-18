---
name: authoring-specs
description: Guidelines for authoring x402 specification files. Use when writing or proposing a new x402 spec, such as a per-network scheme spec (scheme_<name>_<chain>.md).
---

# Authoring x402 specs

Guidance for writing x402 specification files under `specs/`. Use RFC-2119 keywords for normative statements (MUST / MUST NOT, SHOULD / SHOULD NOT, MAY).

## General rules

These apply to every spec type (scheme, extension). The references below add type-specific detail.

### Naming

- Name schemes and extensions in lowercase, hyphen-separated kebab-case (e.g. `batch-settlement`, `offer-receipt`), never camelCase.

### Protocol version, networks, and units

- Target protocol v2 only: `x402Version: 2`, the `amount` field (not v1's `maxAmount`), and the `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers (not v1's `X-PAYMENT` / `X-PAYMENT-RESPONSE`). See the [v1 to v2 migration guide](../../../docs/guides/migration-v1-to-v2.mdx).
- Use canonical CAIP-2 network notation (e.g. `eip155:84532`, not `base-sepolia`).
- Use atomic units for all amounts.

### Wire format

- Be transport agnostic: specify message contents, not how a particular transport carries them.
- Reference core types (`PaymentRequirements`, `PaymentPayload`, `SettlementResponse`) from [`x402-specification-v2.md`](../../../specs/x402-specification-v2.md).
- Every field a spec defines on the wire must be consumed by a downstream role. Do not include human-readable or otherwise purely informational fields.
- Reuse field names, patterns, and conventions established by existing specs instead of coining new ones.

## References

- New network scheme spec (`scheme_<name>_<chain>.md`): see [references/new-network-scheme-spec.md](references/new-network-scheme-spec.md).
- New extension spec: to be added.
