package org.x402.mechanisms.cardano.utils;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.Map;

/**
 * The confirmation policy carried in {@code extra.confirmationPolicy}: a
 * closed object whose only member is an integer {@code l1Confirmations} from -1 to 20, default 1.
 */
public final class CardanoPolicies {

  private CardanoPolicies() {}

  /**
   * Resolves {@code l1Confirmations} from a requirements {@code extra} block.
   *
   * @param extra the extra block, may be {@code null}
   * @return the threshold, or {@code null} when the policy is malformed
   */
  public static Integer l1Confirmations(Map<String, ?> extra) {
    if (extra == null || !extra.containsKey("confirmationPolicy")) {
      return CardanoConstants.DEFAULT_L1_CONFIRMATIONS;
    }
    return normalize(extra.get("confirmationPolicy"));
  }

  /**
   * Normalizes a declared policy value (present in the JSON).
   *
   * @param value the raw value
   * @return the threshold, or {@code null} when malformed or out of range
   */
  public static Integer normalize(Object value) {
    if (!(value instanceof Map<?, ?> map) || map.size() != 1 || !map.containsKey("l1Confirmations")) {
      return null;
    }
    Integer l1 = integerValue(map.get("l1Confirmations"));
    if (l1 == null
        || l1 < CardanoConstants.MIN_L1_CONFIRMATIONS
        || l1 > CardanoConstants.MAX_L1_CONFIRMATIONS) {
      return null;
    }
    return l1;
  }

  /**
   * Whether observed evidence meets a required threshold.
   *
   * @param observed the strongest verified evidence level
   * @param required the threshold
   * @return {@code observed >= required}
   */
  public static boolean confirmationsSatisfy(int observed, int required) {
    return observed >= required;
  }

  /**
   * A JSON number that is an integer in JS terms ({@code Number.isInteger}), within int range.
   *
   * @param value the value
   * @return the integer, or {@code null}
   */
  static Integer integerValue(Object value) {
    if (!(value instanceof Number number)) {
      return null;
    }
    BigDecimal decimal;
    if (number instanceof Double || number instanceof Float) {
      double d = number.doubleValue();
      if (!Double.isFinite(d)) {
        return null;
      }
      decimal = BigDecimal.valueOf(d);
    } else if (number instanceof BigDecimal bd) {
      decimal = bd;
    } else if (number instanceof BigInteger bi) {
      decimal = new BigDecimal(bi);
    } else {
      decimal = BigDecimal.valueOf(number.longValue());
    }
    try {
      return decimal.stripTrailingZeros().intValueExact();
    } catch (ArithmeticException e) {
      return null;
    }
  }
}
