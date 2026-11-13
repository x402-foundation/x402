---
"@x402/stellar": minor
---

Upgrade `@stellar/stellar-sdk` from `^16.4.1` to `^17.4.0`. SDK 17 rebuilds the `xdr` namespace on `@stellar/js-xdr` v5: union arms and struct fields are now properties (`.switch()` becomes `.type`), and `toXDR()`/`fromXDR()` become `toXdr()`/`fromXdr()`. The client, facilitator and shared helpers are migrated, and the wire format is unchanged. Callers that pass `xdr` values into exported helpers such as `getAddressCredentials` must build them with SDK 17. SDK 17 also signs CAP-71 V2 (`sorobanCredentialsAddressV2`) auth entries by default. The facilitator already accepts V2 entries, and the network accepts them from Protocol 28. `engines.node` is raised to `>=22.12.0` to match the SDK, whose CommonJS build needs unflagged `require(esm)`.
