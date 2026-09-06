---
"@x402/svm": patch
---

SVM upto facilitator channel-account re-reads now back off linearly (200/400/600/800/1000ms across 6 reads) rather than doubling (200/400/800/1600ms across 5 reads). Replica lag behind a confirmed open is a small multiple of Solana's slot time, so the same 3.0s budget now buys one more read and caps any single wait at 1s. `UptoSvmFacilitatorConfig.channelReadMaxAttempts` and `channelReadBackoffStepMs` make it configurable.
