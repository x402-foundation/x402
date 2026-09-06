---
"@x402/core": patch
---

`resolveSettlementOverrideAmount()` now enforces the settlement override ceiling against `PaymentRequirements.amount` across raw, percent, and dollar override formats. Previously a settlement override could resolve above the requirement's authorized maximum, which contradicts the documented `SettlementOverrides.amount` contract and the `upto` scheme's maximum-amount rule.
