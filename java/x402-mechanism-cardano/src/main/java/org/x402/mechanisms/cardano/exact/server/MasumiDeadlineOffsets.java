package org.x402.mechanisms.cardano.exact.server;

/**
 * Escrow deadlines as offsets from {@code payByTime} in milliseconds. Defaults: 15, 35 and 55
 * minutes.
 *
 * @param submitResultAfterPayByMs {@code submitResultTime - payByTime}
 * @param unlockAfterPayByMs {@code unlockTime - payByTime}
 * @param externalDisputeUnlockAfterPayByMs {@code externalDisputeUnlockTime - payByTime}
 */
public record MasumiDeadlineOffsets(
    long submitResultAfterPayByMs, long unlockAfterPayByMs, long externalDisputeUnlockAfterPayByMs) {

  /** The default offsets: 15, 35 and 55 minutes. */
  public static final MasumiDeadlineOffsets DEFAULT =
      new MasumiDeadlineOffsets(15 * 60_000L, 35 * 60_000L, 55 * 60_000L);
}
