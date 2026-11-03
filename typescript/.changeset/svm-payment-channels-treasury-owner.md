---
"@x402/svm": patch
---

The SVM upto and batch-settlement facilitators take `paymentChannelsTreasuryOwner`, the treasury owner the payment-channels program was built with. `distribute`, the readiness simulation and rent cleanup derive the treasury token account from it instead of from the network label alone, so a facilitator can run against a custom or local build of the program (for example a localnet validator whose program carries the mainnet constant while requirements use devnet's CAIP-2 id). Unset keeps the deployed program's owner for the network.
