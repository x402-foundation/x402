package org.x402.mechanisms.cardano.exact.masumi;

import java.math.BigInteger;

/** Masumi constants and the deadline / min-UTxO rules. */
public final class MasumiConstants {

  /** The only accepted {@code paymentType}. */
  public static final String PAYMENT_SOURCE_TYPE = "Web3CardanoV2";
  /** Global Masumi V2 registry policy id. */
  public static final String REGISTRY_POLICY_ID = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b";
  /** Non-zero {@code collateral_return_lovelace} floor. */
  public static final BigInteger MIN_COLLATERAL_LOVELACE = BigInteger.valueOf(1_435_230L);
  /** Minimum gap from {@code pay_by_time} to {@code submit_result_time}. */
  public static final BigInteger MIN_PAY_TO_SUBMIT_MS = BigInteger.valueOf(5L * 60 * 1000);
  /** Minimum gap from {@code submit_result_time} to {@code unlock_time}. */
  public static final BigInteger MIN_SUBMIT_TO_UNLOCK_MS = BigInteger.valueOf(15L * 60 * 1000);
  /** Minimum gap from {@code unlock_time} to {@code external_dispute_unlock_time}. */
  public static final BigInteger MIN_UNLOCK_TO_DISPUTE_MS = BigInteger.valueOf(15L * 60 * 1000);
  /** Minimum lead time from issuance to {@code submit_result_time}. */
  public static final BigInteger MIN_SUBMIT_RESULT_LEAD_MS = BigInteger.valueOf(15L * 60 * 1000);
  /** How far past issuance the last deadline may sit (30 days). */
  public static final BigInteger MAX_DEADLINE_HORIZON_MS = BigInteger.valueOf(30L * 24 * 60 * 60 * 1000);
  /** Default ceiling on the collateral a client locks. */
  public static final BigInteger DEFAULT_MAX_COLLATERAL_LOVELACE = BigInteger.valueOf(15_000_000L);

  /** Maximum request-commitment parts. */
  public static final int MAX_COMMITMENT_PARTS = 32;
  /** Maximum content bytes of one commitment part. */
  public static final int MAX_COMMITMENT_CONTENT_BYTES = 1024 * 1024;
  /** Maximum admin keys of a custom deployment. */
  public static final int MAX_ADMIN_KEYS = 64;
  /** Maximum compressed identifier bytes. */
  public static final int MAX_IDENTIFIER_COMPRESSED_BYTES = 8 * 1024;
  /** Maximum decoded identifier characters. */
  public static final int MAX_IDENTIFIER_TEXT_CHARS = 32 * 1024;
  /** Maximum bytes of one COSE field. */
  public static final int MAX_COSE_BYTES = 16 * 1024;
  /** Maximum memoized escrow script hashes. */
  public static final int MAX_SCRIPT_HASH_CACHE_ENTRIES = 256;

  private static final int RESULT_HASH_DELTA_BYTES = 33;
  private static final int MINUTXO_OVERHEAD_BYTES = 160;
  private static final int MINUTXO_RESULT_HASH_BUFFER = 50;
  private static final int MINUTXO_COOLDOWN_BUFFER = 15;
  private static final int MINUTXO_SAFETY_MARGIN = 100;
  private static final int MINUTXO_PER_TOKEN_BUFFER = 50;

  private MasumiConstants() {}

  /**
   * Whether the four escrow deadlines are ordered and clear the minimum gaps.
   *
   * @param payByTime {@code pay_by_time}
   * @param submitResultTime {@code submit_result_time}
   * @param unlockTime {@code unlock_time}
   * @param externalDisputeUnlockTime {@code external_dispute_unlock_time}
   * @return true when every interval clears its minimum
   */
  public static boolean deadlineIntervalsHold(
      BigInteger payByTime,
      BigInteger submitResultTime,
      BigInteger unlockTime,
      BigInteger externalDisputeUnlockTime) {
    return payByTime.add(MIN_PAY_TO_SUBMIT_MS).compareTo(submitResultTime) <= 0
        && submitResultTime.add(MIN_SUBMIT_TO_UNLOCK_MS).compareTo(unlockTime) <= 0
        && unlockTime.add(MIN_UNLOCK_TO_DISPUTE_MS).compareTo(externalDisputeUnlockTime) <= 0;
  }

  /**
   * Minimum lovelace of the escrow output after {@code SubmitResult} (Masumi {@code
   * calculateMinUtxo}).
   *
   * @param lockDatumBytes byte length of the lock datum
   * @param nativeTokenCount distinct native tokens on the escrow output
   * @param coinsPerUtxoByte the protocol parameter
   * @return the minimum lovelace
   */
  public static BigInteger minUtxoLovelace(int lockDatumBytes, int nativeTokenCount, BigInteger coinsPerUtxoByte) {
    long total =
        (long) lockDatumBytes
            + RESULT_HASH_DELTA_BYTES
            + MINUTXO_OVERHEAD_BYTES
            + MINUTXO_RESULT_HASH_BUFFER
            + MINUTXO_COOLDOWN_BUFFER
            + MINUTXO_SAFETY_MARGIN
            + (long) MINUTXO_PER_TOKEN_BUFFER * nativeTokenCount;
    return coinsPerUtxoByte.multiply(BigInteger.valueOf(total));
  }

  /**
   * The {@code collateral_return_lovelace} a lock must carry (client side).
   *
   * @param requestedLovelace {@code amount} for a lovelace payment, 0 for a token
   * @param lockDatumBytes byte length of the lock datum
   * @param nativeTokenCount distinct native tokens on the escrow output
   * @param coinsPerUtxoByte the protocol parameter
   * @return the collateral
   */
  public static BigInteger collateralLovelace(
      BigInteger requestedLovelace, int lockDatumBytes, int nativeTokenCount, BigInteger coinsPerUtxoByte) {
    BigInteger minUtxo = minUtxoLovelace(lockDatumBytes, nativeTokenCount, coinsPerUtxoByte);
    if (requestedLovelace.compareTo(minUtxo) >= 0) {
      return BigInteger.ZERO;
    }
    BigInteger shortfall = minUtxo.subtract(requestedLovelace);
    return shortfall.compareTo(MIN_COLLATERAL_LOVELACE) > 0 ? shortfall : MIN_COLLATERAL_LOVELACE;
  }
}
