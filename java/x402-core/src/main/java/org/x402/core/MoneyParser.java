package org.x402.core;

import org.x402.core.types.AssetAmount;

/** Custom conversion of a decimal money amount on a network. */
@FunctionalInterface
public interface MoneyParser {

  /**
   * Converts an amount, or declines.
   *
   * @param amount the decimal amount, e.g. {@code "0.50"}
   * @param network the network
   * @return the asset amount, or {@code null} to try the next parser
   */
  AssetAmount parse(String amount, String network);
}
