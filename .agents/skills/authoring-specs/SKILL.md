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
- Do not define fields a role can derive from other fields, and give each field one canonical encoding.
- Keep normative text SDK-agnostic: no SDK package or type names, and no test data or measurements. Put those in the PR description.
- List every scheme- or extension-specific error code in the spec, so third-party SDKs emit the same codes.

### Roles and payment flow

- Facilitators are optional and interchangeable. A resource server must be able to switch facilitators, use several, or self-facilitate at any time, and a client must never need an account, registration, or infrastructure tied to a particular facilitator. Which facilitator a server uses stays opaque to the client.
- In the `authorization` flow the order is verify, then the resource handler, then settle. A design that needs funds committed before the handler runs declares `extra.paymentFlow` (`upfront` or `escrow`) instead of reordering an existing flow.
- A new way of moving the asset is a new `extra.assetTransferMethod` on an existing scheme. A change in who bears the risk, or in when verify and settle run, is a new scheme or payment flow.
- Put behavior the protocol cannot enforce, or that only some participants need, in an extension rather than a scheme or the core spec.
- Advertise facilitator capabilities and any policy another party must plan around (limits, time windows, optional features) in `/supported` `extra`, and state what an absent field means. Servers copy these values into `PaymentRequirements`; they may narrow them but never widen them. A network or facilitator that does not implement an advertised capability must reject requirements that use it, not ignore them.

### Settlement outcomes

- `/settle` returns `success: true` at most once per payload. A replay is rejected, not answered with a second success. Idempotent retries belong to the `payment-identifier` extension, not to schemes.
- Report success only after confirming onchain that the expected transfer happened, not only that the transaction did not revert.
- When a transaction was broadcast but its outcome is unknown, return `settlement_pending` with the transaction hash. Never report it as a failure the client may retry by signing again.
- Use separate error codes for retryable infrastructure failures (RPC, storage, timeouts) and for terminal rejections of the payload.

## References

- New network scheme spec (`scheme_<name>_<chain>.md`): see [references/new-network-scheme-spec.md](references/new-network-scheme-spec.md).
- New extension spec: to be added.
