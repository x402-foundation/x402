package org.x402.mechanisms.cardano.exact.script;

import java.util.HexFormat;
import java.util.Map;
import org.x402.mechanisms.cardano.utils.CardanoConstants;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;

/**
 * The inline datum a {@code script} payment attaches. The
 * facilitator does not verify it; only the server that defined the contract can.
 */
public final class ScriptDatum {

  private ScriptDatum() {}

  /**
   * Parses {@code extra.datum}.
   *
   * @param extra the script extra block
   * @return the datum's CBOR bytes, or {@code null} when the extra carries none
   * @throws IllegalArgumentException when present but not CBOR hex
   */
  public static byte[] datumBytes(Map<String, ?> extra) {
    if (extra == null || !extra.containsKey("datum")) {
      return null;
    }
    Object datum = extra.get("datum");
    if (!(datum instanceof String hex)
        || hex.isEmpty()
        || hex.length() % 2 != 0
        || hex.length() / 2 > CardanoConstants.MAX_DATUM_BYTES) {
      throw new IllegalArgumentException("Cardano script payment \"datum\" must be non-empty CBOR hex");
    }
    try {
      byte[] bytes = HexFormat.of().parseHex(hex);
      PlutusEncoding.check(bytes);
      return bytes;
    } catch (RuntimeException e) {
      throw new IllegalArgumentException("Cardano script payment \"datum\" is not valid CBOR hex", e);
    }
  }
}
