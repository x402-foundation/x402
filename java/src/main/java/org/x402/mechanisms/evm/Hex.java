package org.x402.mechanisms.evm;

import java.util.HexFormat;
import java.util.Objects;

/**
 * Hexadecimal encoding in the form used by Ethereum JSON-RPC and the x402 EVM payloads.
 *
 * <p>Encoding always produces lowercase digits. Decoding accepts upper- and lowercase digits with or without
 * a {@code 0x} (or {@code 0X}) prefix and rejects everything else: an odd number of digits, non-hex
 * characters and surrounding whitespace. Error messages describe the problem without echoing the input,
 * because the input may be a private key or a signature.
 *
 * <p>This class is stateless and thread-safe.
 */
public final class Hex {

    private static final HexFormat FORMAT = HexFormat.of();
    private static final String PREFIX = "0x";

    private Hex() {
    }

    /**
     * Encodes bytes as {@code 0x}-prefixed lowercase hex, e.g. {@code {0x0a, 0xff}} becomes {@code "0x0aff"}.
     *
     * @param bytes the bytes to encode; an empty array encodes to {@code "0x"}
     * @return the prefixed hex string
     */
    public static String encode(byte[] bytes) {
        return PREFIX + encodeNoPrefix(bytes);
    }

    /**
     * Encodes bytes as lowercase hex without a prefix, e.g. {@code {0x0a, 0xff}} becomes {@code "0aff"}.
     *
     * @param bytes the bytes to encode
     * @return the hex string, two digits per byte
     */
    public static String encodeNoPrefix(byte[] bytes) {
        return FORMAT.formatHex(Objects.requireNonNull(bytes, "bytes"));
    }

    /**
     * Decodes a hex string, with or without a {@code 0x} prefix.
     *
     * @param hex the hex string; {@code "0x"} and {@code ""} decode to an empty array
     * @return the decoded bytes
     * @throws IllegalArgumentException if {@code hex} has an odd number of digits or a non-hex character
     */
    public static byte[] decode(String hex) {
        String digits = stripPrefix(Objects.requireNonNull(hex, "hex"));
        if (digits.length() % 2 != 0) {
            throw new IllegalArgumentException("Invalid hex: odd number of digits (" + digits.length() + ")");
        }
        for (int i = 0; i < digits.length(); i++) {
            if (!HexFormat.isHexDigit(digits.charAt(i))) {
                throw new IllegalArgumentException("Invalid hex: non-hex character at index " + i);
            }
        }
        return FORMAT.parseHex(digits);
    }

    /**
     * Decodes a hex string that must encode exactly {@code length} bytes, e.g. 32 for a {@code bytes32}.
     *
     * @param hex the hex string, with or without a {@code 0x} prefix
     * @param length the required number of bytes
     * @return the decoded bytes, exactly {@code length} long
     * @throws IllegalArgumentException if {@code hex} is malformed or does not encode {@code length} bytes
     */
    public static byte[] decode(String hex, int length) {
        byte[] bytes = decode(hex);
        if (bytes.length != length) {
            throw new IllegalArgumentException("Invalid hex: expected " + length + " bytes, got " + bytes.length);
        }
        return bytes;
    }

    /**
     * Returns whether a string starts with {@code 0x} or {@code 0X}.
     *
     * @param value the string to inspect
     * @return {@code true} if it carries a hex prefix
     */
    static boolean hasPrefix(String value) {
        return value.length() >= 2 && value.charAt(0) == '0' && (value.charAt(1) == 'x' || value.charAt(1) == 'X');
    }

    /**
     * Removes a leading {@code 0x} or {@code 0X}, if present.
     *
     * @param value the string to strip
     * @return the string without its prefix
     */
    static String stripPrefix(String value) {
        return hasPrefix(value) ? value.substring(2) : value;
    }
}
