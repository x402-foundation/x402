---
"@x402/svm": minor
---

Added an optional `beforeCloseOrDistribute` hook to the SVM payment-channel `RentCleanupOptions`, shared by the `upto` and batch-settlement rent cleanup managers. It runs with the channel's `channelId`, `payer`, `payTo` and `action` after the `maxClosesPerRun` and stored-`payTo` checks and before anything is signed; throwing skips the channel, reports the error through `onError`, and leaves the close slot unused so the channel is retried on the next pass. Reclaim never calls it, and omitting the hook leaves every due channel eligible. This matches the Go SDK's `BeforeCloseOrDistribute`.
