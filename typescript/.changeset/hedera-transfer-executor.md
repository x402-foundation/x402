---
"@x402/hedera": minor
---

Add the `transferExecutor` asset transfer method: payers whose funds a contract controls pay `exact` quotes through an admitted `ITransferExecutor`. Clients sign with the `createTransferExecutorAuthorization` hook; facilitators enable the `transferExecutor` option, with SDK defaults (`createHederaResolveEvmAddress`, …). New exports: `Err*` codes from `@x402/hedera/exact/facilitator`, root guards `isTransferExecutorPayload` and `isCryptoTransferPayload`, and `HEDERA_*` constants.

**Behavior changes:** an `extra.assetTransferMethod` this package does not define is now rejected instead of paid with `cryptoTransfer`, as the scheme spec requires. `transferExecutor` quotes may use `upfront`, and fail to build when they list an executor the facilitator does not advertise or carry `extra.splits` other than `[]` or `null`. Registering under `"hedera:*"` with executors admitted makes `/supported` throw. Against `cryptoTransfer` requirements, a payment whose `accepted` names another defined method is now rejected with `accepted_payment_requirements_mismatch`; 2.28.0 ignored the method. The server scheme's `defaultAssetTransferMethod` is now `"cryptoTransfer"` instead of `"default"`: routes that omit the method get the same flows and the same wire output.
