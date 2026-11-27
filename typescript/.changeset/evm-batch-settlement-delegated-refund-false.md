---
"@x402/evm": patch
---

The batch-settlement facilitator now advertises `delegatedRefund` next to `receiverAuthorizer` in `/supported`. It is `false` by default, since the scheme has no `/settle` caller authentication and rejects unsigned refunds, so a self-managed server that delegates `receiverAuthorizer` to it fails at `initialize()` instead of on its first refund. A host that authenticates `/settle` callers out of band can opt in with `new BatchSettlementEvmScheme(signer, authorizerSigner, { delegatedRefund: true })`, which advertises `true` and signs unsigned refunds with `authorizerSigner`.
