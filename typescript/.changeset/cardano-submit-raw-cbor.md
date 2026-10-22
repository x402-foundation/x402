---
"@x402/cardano": patch
---

The reference facilitator signer now broadcasts the client's signed transaction byte-for-byte through the provider's raw-CBOR endpoint (Blockfrost `/tx/submit`, Koios `/submittx`). It previously decoded and re-encoded the transaction, which tags untagged Conway sets with 258; that changed the body hash, so valid payments built by cardano-cli and other wallets were rejected with `MissingVKeyWitnessesUTXOW`.
