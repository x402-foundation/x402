---
"@x402/stellar": patch
---

`ClientStellarSigner` accepts an optional `authorizeEntry`, forwarded to `signAuthEntries`. Contract (C) accounts can now sign their own auth entries; the SDK's default resolves signers through `Keypair.fromPublicKey`, which rejects a contract address. Keypair signers are unaffected.
