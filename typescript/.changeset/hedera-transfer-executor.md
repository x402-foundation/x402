---
"@x402/hedera": minor
---

Add the `transferExecutor` asset transfer method: payers whose funds a contract controls pay `exact` quotes through an admitted `ITransferExecutor`. Clients sign with the `createTransferExecutorAuthorization` hook; facilitators enable the `transferExecutor` option, with SDK defaults (`createHederaResolveEvmAddress`, …). New exports: `Err*` codes from `@x402/hedera/exact/facilitator`, root guards `isTransferExecutorPayload` and `isCryptoTransferPayload`, and `HEDERA_*` constants.

**Behavior changes:** an `extra.assetTransferMethod` this package does not define is now rejected instead of paid with `cryptoTransfer`, as the scheme spec requires. `transferExecutor` quotes may use `upfront`, and fail to build when they list an executor the facilitator does not advertise or carry `extra.splits` other than `[]` or `null`. Registering under `"hedera:*"` with executors admitted makes `/supported` throw.
