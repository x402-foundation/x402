package org.x402.core.server;

import java.math.BigInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.utils.Amounts;

/**
 * Adjusts what is settled, e.g. partial settlement. Only schemes
 * that support partial settlement accept an amount below the authorized one.
 *
 * @param amount atomic units ({@code "1000"}), a percent of the requirements ({@code "50%"}, up to
 *     two decimals, floored) or a dollar price ({@code "$0.05"}, needs the asset's decimals)
 */
public record SettlementOverrides(String amount) {

  private static final Pattern PERCENT = Pattern.compile("^(\\d+(?:\\.\\d{0,2})?)%$");
  private static final Pattern DOLLAR = Pattern.compile("^\\$(\\d+(?:\\.\\d+)?)$");

  /**
   * Whether an override amount is in dollar form.
   *
   * @param raw the override amount
   * @return {@code true} for {@code $…}
   */
  public static boolean isDollar(String raw) {
    return DOLLAR.matcher(raw).matches();
  }

  /**
   * Resolves an override amount to atomic units: a percentage of the requirements' amount or a
   * dollar amount converted with the asset's decimals.
   *
   * @param raw the override amount
   * @param requirements the requirements whose amount a percent refers to
   * @param decimals the asset decimals, required for the dollar form
   * @return the atomic amount
   * @throws IllegalArgumentException for a dollar amount without decimals
   */
  public static String resolveAmount(String raw, PaymentRequirements requirements, Integer decimals) {
    Matcher percent = PERCENT.matcher(raw);
    if (percent.matches()) {
      String[] parts = percent.group(1).split("\\.", -1);
      String dec = parts.length > 1 ? parts[1] : "";
      while (dec.length() < 2) {
        dec = dec + "0";
      }
      BigInteger scaled = new BigInteger(parts[0]).multiply(BigInteger.valueOf(100))
          .add(new BigInteger(dec.substring(0, 2)));
      return new BigInteger(requirements.amount()).multiply(scaled)
          .divide(BigInteger.valueOf(10000)).toString();
    }
    Matcher dollar = DOLLAR.matcher(raw);
    if (dollar.matches()) {
      if (decimals == null) {
        throw new IllegalArgumentException("Cannot convert dollar settlement override \"" + raw
            + "\" to atomic units: asset decimals are unknown. Pass an atomic amount or register "
            + "the asset.");
      }
      return Amounts.convertToTokenAmount(dollar.group(1), decimals);
    }
    return raw;
  }
}
