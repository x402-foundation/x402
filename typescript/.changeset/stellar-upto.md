---
"@x402/stellar": minor
---

Adds the `upto` scheme on Stellar: `@x402/stellar/upto/client`, `@x402/stellar/upto/server` and `@x402/stellar/upto/facilitator`. The client signs one Soroban authorization entry over the payment terms (recipient, token, maximum, expiration and the facilitator's settlement authority) for the `x402-upto-stellar` settlement contract, and the facilitator settles any amount from zero up to the maximum after the resource is served. The contract is deployed on testnet; its address and WASM hash are built in.
