---
"@x402/evm": minor
---

Facilitator-managed voucher custody for the batch-settlement client and server: `voucherStoreMode: "facilitator"`, `extra.voucherManager` / `extra.refundAuthorizer` on managed 402s, server pass-through `/verify` + `/settle` for every payload (including `voucher`) with a facilitator-minted `pendingId`, managed refund consent via `refundAuthorizerSigner` or the facilitator's `delegatedRefund`, and an optional server-side replica store. The client packs `extra.refundAuthorizer` into `ChannelConfig.salt` as `bytes12(entropy) || bytes20(refundAuthorizer)` and accepts a channel index as `salt`. Also adds the `m.x402ChargeCounts` claim attestation (`decodeClaimAttestation`) and the `@x402/evm/batch-settlement` export. Self-managed custody stays the default and is unchanged on the wire.
