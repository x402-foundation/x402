package org.x402.core.utils;

import java.math.BigDecimal;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Money parsing and atomic-unit conversion.
 */
public final class Amounts {

  private static final Pattern MONEY =
      Pattern.compile("^\\$?\\s*(-?\\d+(?:\\.\\d+)?)(?:\\s+([A-Za-z][A-Za-z0-9.]*))?$");
  private static final Pattern MONEY_STRING = Pattern.compile("^\\d+(?:\\.\\d+)?$");
  private static final Pattern DECIMAL = Pattern.compile("^-?\\d+\\.?\\d*$");
  private static final Pattern EXPONENT = Pattern.compile("[eE]");

  private Amounts() {}

  /**
   * A parsed money value.
   *
   * @param amount the decimal amount as written
   * @param symbol the upper-case ticker, or {@code null} for USD / none
   */
  public record ParsedMoney(String amount, String symbol) {}

  /**
   * Parses a money string such as {@code "$0.50"}, {@code "0.50 USD"} or {@code "0.50 USDM"}.
   *
   * @param money the money string
   * @return the amount and optional ticker
   * @throws IllegalArgumentException when the format is invalid
   */
  public static ParsedMoney parseMoney(String money) {
    String trimmed = money.strip();
    Matcher m = MONEY.matcher(trimmed);
    if (!m.matches()) {
      throw new IllegalArgumentException("Invalid money format: " + money);
    }
    String amount = parseMoneyString(m.group(1));
    String rawSymbol = m.group(2);
    if (rawSymbol == null || rawSymbol.equalsIgnoreCase("USD")) {
      return new ParsedMoney(amount, null);
    }
    return new ParsedMoney(amount, rawSymbol.toUpperCase(java.util.Locale.ROOT));
  }

  /**
   * Parses a numeric money value.
   *
   * @param money the amount
   * @return the amount without ticker
   * @throws IllegalArgumentException when negative
   */
  public static ParsedMoney parseMoney(BigDecimal money) {
    if (money.signum() < 0) {
      throw new IllegalArgumentException("Invalid money format: " + numberText(money));
    }
    return new ParsedMoney(numberText(money), null);
  }

  /**
   * Strips a leading {@code $} and requires a plain decimal.
   *
   * @param money the money string
   * @return the decimal string
   * @throws IllegalArgumentException when invalid
   */
  public static String parseMoneyString(String money) {
    String cleaned = money.replaceFirst("^\\$", "").strip();
    if (!MONEY_STRING.matcher(cleaned).matches() || EXPONENT.matcher(cleaned).find()) {
      throw new IllegalArgumentException("Invalid money format: " + money);
    }
    return cleaned;
  }

  /**
   * Shifts a decimal by {@code decimals} places, truncating
   * extra digits.
   *
   * @param decimalAmount the decimal amount
   * @param decimals the asset's decimals
   * @return the atomic amount
   * @throws IllegalArgumentException when invalid
   */
  public static String convertToTokenAmount(String decimalAmount, int decimals) {
    if (EXPONENT.matcher(decimalAmount).find()) {
      throw new IllegalArgumentException(
          "Invalid amount: " + decimalAmount
              + " — use decimal notation, not scientific notation");
    }
    if (!DECIMAL.matcher(decimalAmount).matches()) {
      throw new IllegalArgumentException("Invalid amount: " + decimalAmount);
    }
    int dot = decimalAmount.indexOf('.');
    String intPart = dot < 0 ? decimalAmount : decimalAmount.substring(0, dot);
    String decPart = dot < 0 ? "" : decimalAmount.substring(dot + 1);
    StringBuilder padded = new StringBuilder(decPart);
    while (padded.length() < decimals) {
      padded.append('0');
    }
    String dec = padded.substring(0, decimals);
    String joined = (intPart + dec).replaceFirst("^0+", "");
    return joined.isEmpty() ? "0" : joined;
  }

  private static String numberText(BigDecimal value) {
    BigDecimal stripped = value.stripTrailingZeros();
    return stripped.scale() < 0 ? stripped.setScale(0).toPlainString() : stripped.toPlainString();
  }
}
