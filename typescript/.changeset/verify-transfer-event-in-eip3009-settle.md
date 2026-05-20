---
"@x402/evm": patch
---

Verified the Transfer event in the post-settle receipt for exact/eip3009 settle, matching the defensive event-shape check already performed by @x402/evm batch-settlement and @x402/stellar exact. Added ErrTransferEventMismatch (`invalid_exact_evm_transfer_event_mismatch`) so a successful tx that emitted no matching Transfer is no longer reported as a successful settlement.
