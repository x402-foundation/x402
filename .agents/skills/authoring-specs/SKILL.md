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
- Keep normative text SDK-agnostic: no SDK package or type names, and no empirical test results or measurements. Put those in the PR description.
- List every scheme- or extension-specific error code in the spec, so third-party SDKs emit the same codes.

### Roles and payment flow

- Facilitators are optional and interchangeable: on onchain networks a client never needs an account, registration, or infrastructure tied to one, and which facilitator a server uses stays opaque to the client. Anything that binds a server or payment to one facilitator, or to one shared store, must be justified and documented in the spec (see Statelessness in the [network scheme reference](references/new-network-scheme-spec.md#statelessness)).
- In the `authorization` flow the order is verify, then the resource handler, then settle. A design that needs funds committed before the handler runs declares `extra.paymentFlow` (`upfront` or `escrow`) instead of reordering an existing flow.
- A new way of moving the asset is a new `extra.assetTransferMethod` on an existing scheme. A change in who bears the risk, or in when verify and settle run, is a new scheme or payment flow.
- Put behavior the protocol cannot enforce in an extension rather than a scheme or the core spec.
- Advertise facilitator capabilities and limits that servers copy into `PaymentRequirements` in `/supported` `extra`, and state what an absent field means. Servers never exceed what the facilitator advertises, and the spec states per field whether a value may be narrowed or must be copied verbatim. A network or facilitator that does not implement or advertise a capability must reject requirements that use it, not ignore them.

### Settlement outcomes

- `/settle` returns `success: true` at most once per payload and settle step. A replay is rejected, never answered from a stored success. Idempotent retries belong to the `payment-identifier` extension, not to schemes.
- When a transaction was broadcast but its outcome is unknown, never report it as a failure the client may retry by signing again; use `settlement_pending` with the transaction hash (core spec §9).
- Use separate error codes for retryable infrastructure failures (RPC, storage, timeouts) and for terminal rejections of the payload.

## References

- New network scheme spec (`scheme_<name>_<chain>.md`): see [references/new-network-scheme-spec.md](references/new-network-scheme-spec.md).
- New extension spec: to be added.
