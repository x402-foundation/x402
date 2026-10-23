package org.x402.core.types;

import java.math.BigDecimal;
import java.util.Objects;

/**
 * A money string such as {@code "$0.50"} or {@code "0.50 USDM"}. The scheme's
 * {@code parsePrice} turns it into an {@link AssetAmount}; {@code $} means the network's default
 * stablecoin at 1:1.
 *
 * @param value the money string as written
 */
public record Money(String value) implements Price {

  /** Validates. */
  public Money {
    Objects.requireNonNull(value, "value");
  }

  /**
   * Creates money from a decimal.
   *
   * @param amount the amount
   * @return the money
   */
  public static Money of(BigDecimal amount) {
    return new Money(amount.stripTrailingZeros().toPlainString());
  }
}
