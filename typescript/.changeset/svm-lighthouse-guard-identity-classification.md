---
"@x402/svm": patch
---

Fixed the exact SVM facilitator's Path 1 (static layout) verification rejecting legitimate Phantom-signed payments when Phantom injects Lighthouse assertion/guard instructions *before* the Compute Budget/`TransferChecked` sequence instead of strictly after it. Path 1 previously matched instructions by fixed position within a hard-capped 3-to-7 instruction window; it now classifies every instruction by identity (program ID + discriminator) instead. Protocol instructions (compute limit, compute price, transfer, optional memo) still must appear in that fixed relative order, but Lighthouse guard instructions — which only assert and abort, never mutate state — are now accepted anywhere in the instruction list with no upper bound, matching how Phantom and Solflare actually construct these transactions.

This is purely additive: old-style payloads (Lighthouse only after the transfer, within the previous instruction-count bounds) are still accepted, and no existing error constant was renamed or removed — `ErrUnknownInstruction` and `ErrProtocolInstructionOrder` are new reasons added alongside the existing ones.
