---
"@x402/svm": minor
---

Added simulation-based smart wallet verification (Path 2) to the SVM exact facilitator. When `enableSmartWalletVerification` is set, transactions that the static positional path rejects (smart-wallet-wrapped layouts, extra instructions) are re-verified by simulating the transaction and inspecting CPI inner instructions for a matching `TransferChecked` — so a facilitator can accept payments from any allowlisted smart-wallet program (Squads, Swig, SPL Governance, Metaplex Core, Lighthouse) without a per-wallet parser. Includes fee-payer isolation with Address Lookup Table resolution, operator-configurable compute-budget caps, post-settlement transfer verification (TOCTOU defense), and seller-required memo enforcement at parity with the static path. The static path's instruction-count ceiling was raised from 6 to 7 so wallets that inject multiple Lighthouse assertions (e.g. Phantom) verify without falling back to simulation.
