---
"@x402/evm": patch
---

Fixed the upto facilitator's settle-time simulation to charge the actual settlement amount instead of the authorized maximum, so a partial settlement no longer fails when the payer can cover the settled amount but not the full ceiling. Zero settlements skip the simulation, and a settlement above the ceiling is rejected before re-verification.
