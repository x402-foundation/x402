package org.x402;

import java.math.BigDecimal;
import java.util.Locale;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The price of a protected resource.
 *
 * <p>Either a {@link Money} amount, which the scheme converts into the network's default asset or the asset its
 * symbol names, or an explicit {@link AssetAmount}.
 */
public sealed interface Price permits Price.Money, AssetAmount {

    /**
     * Parses a money price such as {@code "$0.001"}, {@code "0.01"} or {@code "1.5 USDC"}:
     * <ul>
     *   <li>{@code "$0.001"}, {@code "0.001"} and {@code "0.001 USD"} are amounts of the network's default asset,
     *       so {@link Money#symbol()} is empty.</li>
     *   <li>{@code "1.5 USDC"} names an asset by symbol; {@code "1.5 usdc"} parses to the same value.</li>
     *   <li>The amount keeps its exact digits, e.g. {@code "8975.978289462729"}; no floating point is used.</li>
     *   <li>Surrounding whitespace is ignored. Negative amounts, scientific notation ({@code "1e6"}) and a symbol
     *       glued to the number ({@code "1.50USDT"}) are rejected.</li>
     * </ul>
     * A malformed price therefore fails when the route is configured, not on its first request. Whether the
     * network has an asset with that symbol is checked later, by the scheme.
     *
     * @param value the price expression
     * @return the parsed price
     * @throws IllegalArgumentException if {@code value} is not a non-negative decimal amount with an optional
     *     {@code $} prefix and an optional space-separated symbol
     */
    static Money money(String value) {
        Objects.requireNonNull(value, "value");
        Matcher matcher = Money.EXPRESSION.matcher(value.strip());
        if (!matcher.matches()) {
            throw new IllegalArgumentException("Invalid money format: " + value);
        }
        return new Money(new BigDecimal(matcher.group(1)), Objects.requireNonNullElse(matcher.group(2), ""));
    }

    /**
     * A decimal amount of a network's default asset, or of the default asset with the given symbol. Usually
     * created with {@link Price#money(String)}.
     *
     * <p>Two values are equal only if their amounts have the same scale, as with {@link BigDecimal#equals}:
     * {@code "1.5"} and {@code "1.50"} parse to different (but numerically equal) values.
     *
     * @param amount the non-negative decimal amount, e.g. {@code 0.001} for {@code "$0.001"}
     * @param symbol the upper-case asset symbol, e.g. {@code "USDT0"}, or an empty string for the default asset
     */
    record Money(BigDecimal amount, String symbol) implements Price {

        /** Optional {@code $}, a decimal amount, then an optional spaced symbol. */
        private static final Pattern EXPRESSION =
                Pattern.compile("^\\$?\\s*(\\d+(?:\\.\\d+)?)(?:\\s+([A-Za-z][A-Za-z0-9.]*))?$");
        private static final String USD = "USD";

        /**
         * Creates a money price. The symbol is upper-cased, and {@code "USD"} becomes the empty default symbol.
         *
         * @throws IllegalArgumentException if {@code amount} is negative
         */
        public Money {
            Objects.requireNonNull(amount, "amount");
            Objects.requireNonNull(symbol, "symbol");
            if (amount.signum() < 0) {
                throw new IllegalArgumentException("Money amount must not be negative: " + amount.toPlainString());
            }
            symbol = symbol.toUpperCase(Locale.ROOT);
            if (USD.equals(symbol)) {
                symbol = "";
            }
        }
    }
}
