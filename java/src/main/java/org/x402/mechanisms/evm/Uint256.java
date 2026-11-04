package org.x402.mechanisms.evm;

import java.math.BigInteger;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * Helpers for Solidity {@code uint256} values: atomic token amounts, timestamps and chain ids.
 *
 * <p>The x402 wire format carries these as base-10 strings without sign, exponent or separators, e.g.
 * {@code "1000"} or {@code "1740672154"}. This class parses that form strictly and produces the 32-byte
 * big-endian encoding used by EIP-712 and the ABI.
 *
 * <p>This class is stateless and thread-safe.
 */
public final class Uint256 {

    /** The largest {@code uint256}, {@code 2^256 - 1}. */
    public static final BigInteger MAX_VALUE = BigInteger.ONE.shiftLeft(256).subtract(BigInteger.ONE);

    /** Size of an encoded {@code uint256} in bytes. */
    public static final int BYTES = 32;

    /** {@code MAX_VALUE} has 78 decimal digits; longer input cannot be a {@code uint256}. */
    private static final int MAX_DECIMAL_DIGITS = 78;
    private static final Pattern DECIMAL = Pattern.compile("[0-9]+");

    private Uint256() {
    }

    /**
     * Parses a base-10 {@code uint256} string such as {@code "1000"}. Leading zeros are accepted; signs,
     * whitespace, decimal points, exponents and hex are not.
     *
     * @param value the decimal string
     * @return the parsed value, between 0 and {@link #MAX_VALUE}
     * @throws IllegalArgumentException if {@code value} is not a base-10 integer or exceeds {@link #MAX_VALUE}
     */
    public static BigInteger parse(String value) {
        Objects.requireNonNull(value, "value");
        if (!DECIMAL.matcher(value).matches()) {
            throw new IllegalArgumentException("Expected a base-10 unsigned integer (ASCII digits only)");
        }
        String digits = stripLeadingZeros(value);
        if (digits.length() > MAX_DECIMAL_DIGITS) {
            throw new IllegalArgumentException("Value exceeds uint256: " + digits.length() + " digits");
        }
        return requireInRange(new BigInteger(digits));
    }

    /**
     * Checks that a value fits in a {@code uint256}.
     *
     * @param value the value to check
     * @return {@code value}
     * @throws IllegalArgumentException if {@code value} is negative or exceeds {@link #MAX_VALUE}
     */
    public static BigInteger requireInRange(BigInteger value) {
        Objects.requireNonNull(value, "value");
        if (value.signum() < 0) {
            throw new IllegalArgumentException("Value is negative, uint256 is unsigned");
        }
        if (value.compareTo(MAX_VALUE) > 0) {
            throw new IllegalArgumentException("Value exceeds uint256: " + value.bitLength() + " bits");
        }
        return value;
    }

    /**
     * Encodes a value as 32 big-endian bytes, left-padded with zeros, as in {@code abi.encode(uint256)}.
     *
     * @param value the value to encode
     * @return the 32-byte encoding
     * @throws IllegalArgumentException if {@code value} is negative or exceeds {@link #MAX_VALUE}
     */
    public static byte[] toBytes(BigInteger value) {
        byte[] magnitude = requireInRange(value).toByteArray();
        byte[] out = new byte[BYTES];
        // toByteArray() may carry a leading 0x00 sign byte, which the range check guarantees is the only excess
        int copy = Math.min(magnitude.length, BYTES);
        System.arraycopy(magnitude, magnitude.length - copy, out, BYTES - copy, copy);
        return out;
    }

    private static String stripLeadingZeros(String digits) {
        int start = 0;
        while (start < digits.length() - 1 && digits.charAt(start) == '0') {
            start++;
        }
        return digits.substring(start);
    }
}
