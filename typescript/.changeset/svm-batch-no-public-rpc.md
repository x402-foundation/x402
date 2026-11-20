---
"@x402/svm": minor
---

`BatchChannelManager` no longer reads settled or payout watermarks from a network's public Solana RPC when `rpcUrl` is omitted. A confirmed claim without `extra.accepts` is recorded at the voucher amount unless `readSettledWatermark` or `rpcUrl` is set. A distribute leaves the channel payable unless `readPayoutWatermark` or `rpcUrl` is set. A configured read that fails is still reported and left for the next pass.
