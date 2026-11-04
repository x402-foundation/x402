package org.x402.mechanisms.evm;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * Conversion of human-readable token amounts into atomic units.
 *
 * <p>Digits beyond the token's precision are truncated, never rounded: {@code "1.0000005"} at 6 decimals is
 * {@code 1000000}, and {@code "0.0000009"} is {@code 0}. No floating point is involved.
 *
 * <p>This class is stateless and thread-safe.
 */
public final class TokenAmounts {

    /** The largest number of decimals an ERC-20 token can declare: {@code decimals()} returns a {@code uint8}. */
    public static final int MAX_DECIMALS = 255;

    /** Plain unsigned decimal notation: {@code "1"}, {@code "1."}. */
    private static final Pattern PLAIN_DECIMAL = Pattern.compile("[0-9]+(?:\\.[0-9]*)?");
    private static final Pattern EXPONENT = Pattern.compile("[eE]");
    /** {@link Uint256#MAX_VALUE} has 78 integer digits. */
    private static final int MAX_INTEGER_DIGITS = 78;

    private TokenAmounts() {
    }

    /**
     * Converts a decimal string such as {@code "0.01"} into atomic units, truncating extra precision.
     *
     * @param decimalAmount a non-negative amount in plain decimal notation, e.g. {@code "1.5"}; scientific
     *     notation, signs and whitespace are rejected
     * @param decimals the token's decimals, between 0 and {@value #MAX_DECIMALS}
     * @return the atomic amount, e.g. {@code 10000} for {@code "0.01"} at 6 decimals
     * @throws IllegalArgumentException if the amount is malformed, {@code decimals} is out of range, or the result
     *     exceeds {@code uint256}
     */
    public static BigInteger toAtomic(String decimalAmount, int decimals) {
        Objects.requireNonNull(decimalAmount, "decimalAmount");
        if (EXPONENT.matcher(decimalAmount).find()) {
            throw new IllegalArgumentException(
                    "Invalid amount: " + decimalAmount + " (use decimal notation, not scientific notation)");
        }
        if (!PLAIN_DECIMAL.matcher(decimalAmount).matches()) {
            throw new IllegalArgumentException("Invalid amount: " + decimalAmount);
        }
        return toAtomic(new BigDecimal(decimalAmount), decimals);
    }

    /**
     * Converts a decimal amount into atomic units, truncating extra precision.
     *
     * @param amount a non-negative amount, e.g. {@code new BigDecimal("1.5")}
     * @param decimals the token's decimals, between 0 and {@value #MAX_DECIMALS}
     * @return the atomic amount, e.g. {@code 1500000} for {@code 1.5} at 6 decimals
     * @throws IllegalArgumentException if {@code amount} is negative, {@code decimals} is out of range, or the
     *     result exceeds {@code uint256}
     */
    public static BigInteger toAtomic(BigDecimal amount, int decimals) {
        Objects.requireNonNull(amount, "amount");
        if (decimals < 0 || decimals > MAX_DECIMALS) {
            throw new IllegalArgumentException("Decimals must be between 0 and " + MAX_DECIMALS + ", got " + decimals);
        }
        if (amount.signum() < 0) {
            throw new IllegalArgumentException("Amount must not be negative: " + amount.toPlainString());
        }
        if (amount.signum() == 0) {
            // The digit count below would treat zero as one integer digit
            return BigInteger.ZERO;
        }
        // Integer digits after shifting; checked first so a huge exponent cannot allocate a huge BigInteger
        long integerDigits = (long) amount.precision() - amount.scale() + decimals;
        if (integerDigits > MAX_INTEGER_DIGITS) {
            throw new IllegalArgumentException("Amount exceeds uint256 at " + decimals + " decimals");
        }
        BigInteger atomic = amount.movePointRight(decimals).setScale(0, RoundingMode.DOWN).toBigIntegerExact();
        if (atomic.compareTo(Uint256.MAX_VALUE) > 0) {
            throw new IllegalArgumentException("Amount exceeds uint256 at " + decimals + " decimals");
        }
        return atomic;
    }
}
