---
"@x402/svm": minor
---

SVM batch-settlement no longer resubmits a claim, distribute or seal forever when the transaction confirmed but its response was lost. The facilitator attaches `extra.channelStates[]` to a claim or distribute rejected with `cumulative_amount_mismatch` because it is already applied, to a seal rejected with `close_state` because the channel is no longer `Closing` or the voucher is below `settled`, and to a successful distribute. `BatchChannelManager` adopts those states when they name exactly the submitted channels, resyncing claimed channels, re-claiming the rest once, and recording paid-out or sealed channels without counting them as new claims or seals. A missing or unusable snapshot falls back to a configured settled reader, payout reader, or `rpcUrl`. A refund of a channel that is already `Closing` stays a plain `close_state` error.

`BatchChannelManager` no longer reads watermarks from a network's public Solana RPC when `rpcUrl` is omitted; it reads only through `rpcUrl`, `readSettledWatermark` or `readPayoutWatermark`. A confirmed claim without `extra.accepts` is recorded at the voucher amount unless `readSettledWatermark` or `rpcUrl` is set, and a distribute leaves the channel payable unless `readPayoutWatermark` or `rpcUrl` is set. A configured read that fails is reported and left for the next pass.

A replayed `settle` result refreshes `extra.channelStates` from the channels' current state. When a channel PDA is absent onchain after a recovered `settle` or on a fresh `claim`, `seal`, or `settle` past `open_slot + OPEN_SLOT_WINDOW`, the facilitator reports `status: "closed"` (with zeroed amounts and `withdrawRequestedAt: 0`) in `extra.channelStates[]`, and `BatchChannelManager` retires closed channels without inflating `settled`, reports any lost unclaimed voucher delta, and retries remaining live channels in a mixed batch once.

Migration: if your facilitator does not return `extra.channelStates`, set `rpcUrl` or `readPayoutWatermark`; otherwise distributed channels stay payable.
