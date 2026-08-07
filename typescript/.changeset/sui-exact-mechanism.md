---
"@x402/sui": minor
---

Add @x402/sui: exact-scheme mechanism for Sui (client, server, facilitator) per
specs/schemes/exact/scheme_exact_sui.md. Supports gasless Address Balance transfers
(protocol v125): zero-gas USDC payments with no coin object creation, optional declared
outputs (extra.outputs) verified against exact payer debit, and optional prebuilt
transactions (extra.buildUrl). Networks: sui:mainnet, sui:testnet, sui:devnet.
