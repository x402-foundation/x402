package org.x402.mechanisms.cardano.exact.facilitator;

/**
 * How strictly verify checks the datum of a script payment's locked output. Datum contents are
 * never interpreted; only whether the output can be spent by the script's Plutus version.
 */
public enum ScriptDatumPolicy {

  /**
   * The default: no datum-kind checks except that a Plutus V1 script's output with an inline datum
   * is refused, because Plutus V1 can never spend it.
   */
  REFERENCE,

  /**
   * Plutus V1 needs a datum hash; Plutus V2 and V3 need an inline datum or a datum hash; a
   * {@code scriptHash}-only descriptor (version unknown) needs some datum.
   */
  STRICT,

  /** {@link #STRICT}, except that a Plutus V3 output may also carry no datum. */
  V3_OPTIONAL
}
