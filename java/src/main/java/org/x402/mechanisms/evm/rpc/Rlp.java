package org.x402.mechanisms.evm.rpc;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.util.List;
import java.util.Objects;

/**
 * Recursive Length Prefix encoding, the serialization Ethereum uses for transactions (Yellow Paper, appendix B).
 *
 * <p>A byte string of one byte below {@code 0x80} encodes as itself. Other strings get a {@code 0x80 + length}
 * prefix, or {@code 0xb7 + lengthOfLength} followed by the length when longer than 55 bytes. Lists work the same
 * way on the concatenation of their encoded items with the {@code 0xc0} and {@code 0xf7} offsets. Integers are
 * byte strings holding the minimal big-endian form, so zero encodes as the empty string {@code 0x80}.
 *
 * <p>Only encoding is implemented: the facilitator builds transactions and never parses them. This class is
 * stateless and thread-safe.
 */
final class Rlp {

    private static final int SHORT_STRING_OFFSET = 0x80;
    private static final int LONG_STRING_OFFSET = 0xb7;
    private static final int SHORT_LIST_OFFSET = 0xc0;
    private static final int LONG_LIST_OFFSET = 0xf7;
    private static final int MAX_SHORT_LENGTH = 55;

    private Rlp() {
    }

    /**
     * Encodes a byte string.
     *
     * @param bytes the string, possibly empty
     * @return the encoding
     */
    static byte[] encodeString(byte[] bytes) {
        Objects.requireNonNull(bytes, "bytes");
        if (bytes.length == 1 && (bytes[0] & 0xff) < SHORT_STRING_OFFSET) {
            return bytes.clone();
        }
        return withPrefix(SHORT_STRING_OFFSET, LONG_STRING_OFFSET, bytes);
    }

    /**
     * Encodes a non-negative integer as its minimal big-endian byte string, without leading zeros.
     *
     * @param value the integer
     * @return the encoding; {@code 0x80} for zero
     * @throws IllegalArgumentException if {@code value} is negative
     */
    static byte[] encodeInteger(BigInteger value) {
        Objects.requireNonNull(value, "value");
        if (value.signum() < 0) {
            throw new IllegalArgumentException("RLP integers are unsigned, got a negative value");
        }
        return encodeString(minimalBytes(value));
    }

    /**
     * Encodes a list whose items are already RLP encoded.
     *
     * @param encodedItems the encoded items, in order
     * @return the encoding of the list
     */
    static byte[] encodeList(List<byte[]> encodedItems) {
        Objects.requireNonNull(encodedItems, "encodedItems");
        ByteArrayOutputStream payload = new ByteArrayOutputStream();
        for (byte[] item : encodedItems) {
            payload.writeBytes(Objects.requireNonNull(item, "item"));
        }
        return withPrefix(SHORT_LIST_OFFSET, LONG_LIST_OFFSET, payload.toByteArray());
    }

    /**
     * Returns the big-endian bytes of a non-negative integer without leading zeros; zero is the empty array.
     */
    static byte[] minimalBytes(BigInteger value) {
        if (value.signum() == 0) {
            return new byte[0];
        }
        byte[] bytes = value.toByteArray();
        // toByteArray() adds a leading 0x00 sign byte when the top bit of the magnitude is set
        if (bytes[0] == 0) {
            byte[] trimmed = new byte[bytes.length - 1];
            System.arraycopy(bytes, 1, trimmed, 0, trimmed.length);
            return trimmed;
        }
        return bytes;
    }

    private static byte[] withPrefix(int shortOffset, int longOffset, byte[] payload) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(payload.length + 9);
        if (payload.length <= MAX_SHORT_LENGTH) {
            out.write(shortOffset + payload.length);
        } else {
            byte[] length = minimalBytes(BigInteger.valueOf(payload.length));
            out.write(longOffset + length.length);
            out.writeBytes(length);
        }
        out.writeBytes(payload);
        return out.toByteArray();
    }
}
