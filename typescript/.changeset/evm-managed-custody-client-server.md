---
"@x402/evm": minor
"@x402/core": minor
---

Added client and resource-server support for facilitator-managed EVM batch settlement, including refund channel identity, admission forwarding, cancellation and corrective recovery.

Pass trusted verification results to cancellation hooks after an afterVerify abort, and cancel known local settlement failures before facilitator dispatch without canceling pending or uncertain outcomes.
