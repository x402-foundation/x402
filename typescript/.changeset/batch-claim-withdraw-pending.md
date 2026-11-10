---
"@x402/evm": patch
---

EVM batch-settlement channel managers now always claim outstanding vouchers on channels with a pending timed withdrawal. `claim()`, `getClaimableVouchers()`, and the automatic claim job no longer let `idleSecs` or `selectClaimChannels` skip those channels, so a voucher that already paid for delivered service lands before `finalizeWithdraw` drains the escrow.
