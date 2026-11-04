package org.x402.mechanisms.evm;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * Ethereum account and contract addresses: 20 bytes written as 40 hex digits.
 *
 * <p>Input is accepted in any letter case, with or without a {@code 0x} prefix. Mixed-case input is not checked
 * against its EIP-55 checksum. Output is always
 * the {@code 0x}-prefixed EIP-55 checksummed form, e.g. {@code 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}.
 *
 * <p>This class is stateless and thread-safe.
 */
public final class EvmAddress {

    /** Length of an address in bytes. */
    public static final int LENGTH = 20;

    private static final Pattern ADDRESS = Pattern.compile("(?:0[xX])?[0-9a-fA-F]{40}");
    private static final int HEX_LENGTH = 2 * LENGTH;

    private EvmAddress() {
    }

    /**
     * Returns whether a string is 40 hex digits, optionally prefixed with {@code 0x}.
     *
     * @param address the string to check; {@code null} is not an address
     * @return {@code true} if it is a well-formed address
     */
    public static boolean isValid(String address) {
        return address != null && ADDRESS.matcher(address).matches();
    }

    /**
     * Decodes an address into its 20 bytes.
     *
     * @param address the address, in any case, with or without {@code 0x}
     * @return the 20 address bytes
     * @throws IllegalArgumentException if {@code address} is not a well-formed address
     */
    public static byte[] toBytes(String address) {
        return Hex.decode(requireValid(address));
    }

    /**
     * Returns the EIP-55 checksummed form of an address.
     *
     * <p>Each hex letter is upper-cased when the matching nibble of {@code keccak256(lowercaseHex)} is 8 or more,
     * e.g. {@code 0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed} becomes
     * {@code 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed}.
     *
     * @param address the address, in any case, with or without {@code 0x}
     * @return the {@code 0x}-prefixed checksummed address
     * @throws IllegalArgumentException if {@code address} is not a well-formed address
     */
    public static String toChecksum(String address) {
        String lower = Hex.stripPrefix(requireValid(address)).toLowerCase(Locale.ROOT);
        byte[] hash = Keccak.keccak256(lower.getBytes(StandardCharsets.US_ASCII));
        StringBuilder out = new StringBuilder(HEX_LENGTH + 2).append("0x");
        for (int i = 0; i < HEX_LENGTH; i++) {
            char c = lower.charAt(i);
            int nibble = (hash[i / 2] >> (i % 2 == 0 ? 4 : 0)) & 0x0f;
            out.append(c >= 'a' && nibble >= 8 ? Character.toUpperCase(c) : c);
        }
        return out.toString();
    }

    /**
     * Returns the EIP-55 checksummed form of a 20-byte address.
     *
     * @param address the 20 address bytes
     * @return the {@code 0x}-prefixed checksummed address
     * @throws IllegalArgumentException if {@code address} is not 20 bytes long
     */
    public static String toChecksum(byte[] address) {
        Objects.requireNonNull(address, "address");
        if (address.length != LENGTH) {
            throw new IllegalArgumentException("Address must be " + LENGTH + " bytes, got " + address.length);
        }
        return toChecksum(Hex.encodeNoPrefix(address));
    }

    /**
     * Derives the address of a secp256k1 public key: the last 20 bytes of {@code keccak256(X || Y)}.
     *
     * @param publicKey the public key as 65-byte uncompressed SEC1 ({@code 0x04 || X || Y}), 33-byte compressed
     *     SEC1, or raw 64-byte {@code X || Y}
     * @return the checksummed address
     * @throws IllegalArgumentException if the bytes are not a valid secp256k1 public key
     */
    public static String fromPublicKey(byte[] publicKey) {
        byte[] uncompressed = Secp256k1.uncompressedPublicKey(publicKey);
        byte[] hash = Keccak.keccak256(Arrays.copyOfRange(uncompressed, 1, uncompressed.length));
        return toChecksum(Arrays.copyOfRange(hash, hash.length - LENGTH, hash.length));
    }

    /**
     * Returns whether two strings are well-formed addresses of the same account, ignoring letter case and the
     * optional {@code 0x} prefix.
     *
     * @param a an address, or {@code null}
     * @param b an address, or {@code null}
     * @return {@code true} if both are valid and denote the same 20 bytes; {@code false} if either is
     *     {@code null} or malformed
     */
    public static boolean equalsIgnoreCase(String a, String b) {
        return isValid(a) && isValid(b) && Hex.stripPrefix(a).equalsIgnoreCase(Hex.stripPrefix(b));
    }

    private static String requireValid(String address) {
        Objects.requireNonNull(address, "address");
        if (!isValid(address)) {
            throw new IllegalArgumentException("Not an EVM address (expected 40 hex digits, optionally 0x-prefixed)");
        }
        return address;
    }
}
