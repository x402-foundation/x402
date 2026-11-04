---
'@x402/evm': patch
---

Fail closed on batch-settlement lock-store and storage implementation errors. A `TypeError`, `SyntaxError`, or `RangeError` while persisting a deposit charge after a successful settle now aborts the settle (`AfterSettleAbortError`, `voucher_store_unavailable`) instead of escaping core's `afterSettle` handling and returning a successful settle without a recorded charge. Any exception in `beforeVerify` after the admission `pendingId` is minted (lock acquire errors, corrupt stored channel rows) now returns a `verification_state_unavailable` abort and drops the request context, rather than being warned by core and continuing to facilitator verification with only the onchain `totalClaimed` baseline.
