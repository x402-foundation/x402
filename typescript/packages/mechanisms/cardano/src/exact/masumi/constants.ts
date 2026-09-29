/**
 * Masumi `PaymentSourceType` targeted by this implementation. `Web3CardanoV2`
 * is the `vested_pay` payment-v2 escrow whose datum this scheme builds. Any
 * other value MUST be rejected: the field selects the contract generation and
 * is not advisory.
 */
export const MASUMI_PAYMENT_SOURCE_TYPE = "Web3CardanoV2";

/**
 * Global Masumi V2 registry policy id. A non-empty `terms.agentIdentifier`
 * makes a registry claim and MUST start with this policy — another policy is
 * not a Masumi V2 registry.
 */
export const MASUMI_REGISTRY_POLICY_ID = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b";

/**
 * Non-zero `collateral_return_lovelace` floor. The client computes the
 * collateral itself, but a positive value below this floor is rejected by
 * Masumi's off-chain validation (`CONSTANTS.MIN_COLLATERAL_LOVELACE`).
 */
export const MASUMI_MIN_COLLATERAL_LOVELACE = 1_435_230n;

/** Minimum gap from `pay_by_time` to `submit_result_time`. */
export const MASUMI_MIN_PAY_TO_SUBMIT_MS = 5n * 60n * 1000n;

/** Minimum gap from `submit_result_time` to `unlock_time`. */
export const MASUMI_MIN_SUBMIT_TO_UNLOCK_MS = 15n * 60n * 1000n;

/** Minimum gap from `unlock_time` to `external_dispute_unlock_time`. */
export const MASUMI_MIN_UNLOCK_TO_DISPUTE_MS = 15n * 60n * 1000n;

/**
 * Minimum lead time from issuance to `submit_result_time`. Masumi's own
 * purchase and payment endpoints refuse a `submitResultTime` closer than this,
 * so an issuer that undercuts it mints a 402 Masumi tooling will not register.
 * Only the issuer can check it — by the time a facilitator sees the payment the
 * clock has already moved, and re-checking it there would reject a lock that was
 * legitimate when it was built.
 */
export const MASUMI_MIN_SUBMIT_RESULT_LEAD_MS = 15n * 60n * 1000n;

/**
 * How far past issuance the last escrow deadline may sit.
 *
 * The minimum gaps stop a seller from making the window uselessly short; this
 * stops the opposite attack. `vested_pay` gates the buyer's `WithdrawRefund` on
 * `must_start_after(validity_range, submit_result_time)`, so until that deadline
 * passes the buyer cannot recover the payment **or** its collateral. Without a
 * ceiling a hostile 402 can name a deadline years out and freeze the buyer's
 * funds for that long while passing every other check.
 *
 * 30 days is far beyond any legitimate agent settlement — Masumi's own defaults
 * are `submitResultTime + 6h` and `+ 12h` — and is overridable per call.
 */
export const MASUMI_MAX_DEADLINE_HORIZON_MS = 30n * 24n * 60n * 60n * 1000n;

/**
 * Default ceiling on `collateral_return_lovelace` a client will lock.
 *
 * The collateral is derived from the datum size, and the datum carries the
 * seller's `reference_key` and `reference_signature` verbatim — each allowed up
 * to `MAX_MASUMI_COSE_BYTES`. A seller who pads them inflates the min-UTXO the
 * escrow must clear and therefore the buyer's own locked funds. A realistic lock
 * is a ~450-byte datum needing at most ~3.7 ADA of collateral; padding toward
 * the ledger's transaction limit pushes that above 50 ADA.
 *
 * The ceiling sits well above legitimate use and far below the attack range.
 */
export const MASUMI_DEFAULT_MAX_COLLATERAL_LOVELACE = 15_000_000n;

/**
 * Whether the four escrow deadlines are ordered and clear the minimum gaps.
 *
 * This is the single copy of the rule: the issuer applies it to what it is about
 * to sign, the client to the seller-signed `terms`, and the facilitator to the
 * integers actually in the datum. They must not drift — a gap one side accepts
 * and another rejects is a 402 that can never be paid, and the values are inside
 * `termsDigest` so it cannot be repaired after issuance.
 *
 * @param payByTime - Datum `pay_by_time`.
 * @param submitResultTime - Datum `submit_result_time`.
 * @param unlockTime - Datum `unlock_time`.
 * @param externalDisputeUnlockTime - Datum `external_dispute_unlock_time`.
 * @returns True when every interval clears its minimum.
 */
export function masumiDeadlineIntervalsHold(
  payByTime: bigint,
  submitResultTime: bigint,
  unlockTime: bigint,
  externalDisputeUnlockTime: bigint,
): boolean {
  return (
    payByTime + MASUMI_MIN_PAY_TO_SUBMIT_MS <= submitResultTime &&
    submitResultTime + MASUMI_MIN_SUBMIT_TO_UNLOCK_MS <= unlockTime &&
    unlockTime + MASUMI_MIN_UNLOCK_TO_DISPUTE_MS <= externalDisputeUnlockTime
  );
}

// Min-UTXO for the escrow output must cover the datum as it will look AFTER the
// seller submits a result, not at lock time: `result_hash` grows from empty to
// 32 bytes and the cooldowns from 0 to real POSIX-ms timestamps. Otherwise the
// seller's SubmitResult output falls below min-UTXO and cannot be built. These
// mirror Masumi's `calculateMinUtxo` (utils/min-utxo) so a lock this facilitator
// accepts also clears their off-chain check.
/** CBOR byte delta of an empty vs 32-byte `result_hash` bytestring (0x40 -> 0x5820…). */
const MASUMI_RESULT_HASH_DELTA_BYTES = 33;
/** Constant overhead (input + UTXO-map entry), same as the ledger's `160`. */
const MASUMI_MINUTXO_OVERHEAD_BYTES = 160;
/** Headroom buffer for the submitted result hash. */
const MASUMI_MINUTXO_RESULT_HASH_BUFFER = 50;
/** Headroom buffer for the two cooldown timestamps becoming non-zero. */
const MASUMI_MINUTXO_COOLDOWN_BUFFER = 15;
/** Safety margin keeping the estimate above the ledger floor. */
const MASUMI_MINUTXO_SAFETY_MARGIN = 100;
/** Per-native-token headroom buffer. */
const MASUMI_MINUTXO_PER_TOKEN_BUFFER = 50;

/**
 * Minimum lovelace the escrow output must carry, computed on the datum as it
 * will look after `SubmitResult` (32-byte `result_hash` + buffers), mirroring
 * Masumi's `calculateMinUtxo`.
 *
 * @param lockDatumBytes - Byte length of the current (empty-result) lock datum.
 * @param nativeTokenCount - Distinct native tokens carried by the escrow output.
 * @param coinsPerUtxoByte - Live `coinsPerUtxoByte` protocol parameter.
 * @returns The minimum lovelace the escrow output must hold.
 */
export function masumiMinUtxoLovelace(
  lockDatumBytes: number,
  nativeTokenCount: number,
  coinsPerUtxoByte: bigint,
): bigint {
  const totalBytes =
    lockDatumBytes +
    MASUMI_RESULT_HASH_DELTA_BYTES +
    MASUMI_MINUTXO_OVERHEAD_BYTES +
    MASUMI_MINUTXO_RESULT_HASH_BUFFER +
    MASUMI_MINUTXO_COOLDOWN_BUFFER +
    MASUMI_MINUTXO_SAFETY_MARGIN +
    MASUMI_MINUTXO_PER_TOKEN_BUFFER * nativeTokenCount;
  return coinsPerUtxoByte * BigInt(totalBytes);
}

/**
 * The `collateral_return_lovelace` a lock must carry.
 *
 * The seller never supplies or signs this value: the client computes it from
 * the requested asset and live protocol parameters, and the escrow output must
 * satisfy `lockedLovelace = requestedLovelace + collateral_return_lovelace`.
 *
 * A **lovelace** payment can therefore run with zero collateral when the
 * requested amount already clears the post-`SubmitResult` min-UTXO. A
 * **native-token** payment has `requestedLovelace = 0`, so zero collateral
 * cannot satisfy both rules and the collateral must be at least the larger of
 * the floor and that min-UTXO.
 *
 * @param requestedLovelace - `amount` for a lovelace payment, `0` for a token.
 * @param lockDatumBytes - Byte length of the current (empty-result) lock datum.
 * @param nativeTokenCount - Distinct native tokens carried by the escrow output.
 * @param coinsPerUtxoByte - Live `coinsPerUtxoByte` protocol parameter.
 * @returns The collateral to place in the datum.
 */
export function masumiCollateralLovelace(
  requestedLovelace: bigint,
  lockDatumBytes: number,
  nativeTokenCount: number,
  coinsPerUtxoByte: bigint,
): bigint {
  const minUtxo = masumiMinUtxoLovelace(lockDatumBytes, nativeTokenCount, coinsPerUtxoByte);
  if (requestedLovelace >= minUtxo) return 0n;
  const shortfall = minUtxo - requestedLovelace;
  return shortfall > MASUMI_MIN_COLLATERAL_LOVELACE ? shortfall : MASUMI_MIN_COLLATERAL_LOVELACE;
}
