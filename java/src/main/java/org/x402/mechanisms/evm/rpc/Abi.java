package org.x402.mechanisms.evm.rpc;

import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.Keccak;
import org.x402.mechanisms.evm.Uint256;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The subset of the Solidity contract ABI the EVM facilitator needs: calldata for functions whose parameters are
 * all static, and decoding of single {@code uint256}, {@code bool} and {@code string} return values.
 *
 * <p>Calldata is the 4-byte selector, the first 4 bytes of {@code keccak256(signature)}, followed by one 32-byte
 * word per argument:
 * <pre>{@code
 * byte[] data = Abi.encodeCall("balanceOf(address)", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
 * BigInteger balance = Abi.decodeUint256(signer.call(token, data));
 * }</pre>
 *
 * <table>
 *   <caption>Supported parameter types</caption>
 *   <tr><th>Solidity type</th><th>Java argument</th><th>Encoding</th></tr>
 *   <tr><td>{@code address}</td><td>{@code String}, 40 hex digits, any case, optional {@code 0x}</td>
 *       <td>left-padded with zeros</td></tr>
 *   <tr><td>{@code bool}</td><td>{@code Boolean}</td><td>{@code 0} or {@code 1}</td></tr>
 *   <tr><td>{@code uint8} ... {@code uint256} (multiples of 8)</td>
 *       <td>{@code BigInteger}, {@code Long}, {@code Integer}, {@code Short} or {@code Byte}, non-negative and
 *       within the width</td><td>big-endian, left-padded</td></tr>
 *   <tr><td>{@code bytes1} ... {@code bytes32}</td><td>{@code byte[]} of exactly that length</td>
 *       <td>right-padded with zeros</td></tr>
 * </table>
 * Dynamic parameter types ({@code string}, {@code bytes}, arrays) and tuples are rejected.
 *
 * <p>Decoders read data returned by a node, which is untrusted: every offset and length is bounds-checked and
 * malformed data is rejected with {@link IllegalArgumentException}. This class is stateless and thread-safe.
 */
public final class Abi {

    /** Size of an ABI word in bytes. */
    public static final int WORD_LENGTH = 32;

    /** Length of a function selector in bytes. */
    public static final int SELECTOR_LENGTH = 4;

    private static final Pattern SIGNATURE = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*\\(([A-Za-z0-9,]*)\\)");
    private static final Pattern UINT = Pattern.compile("uint([1-9][0-9]{0,2})");
    private static final Pattern FIXED_BYTES = Pattern.compile("bytes([1-9][0-9]?)");
    private static final int ADDRESS_PADDING = WORD_LENGTH - EvmAddress.LENGTH;
    private static final byte[] ERROR_SELECTOR = selector("Error(string)");

    private Abi() {
    }

    /**
     * Computes a function selector: the first 4 bytes of {@code keccak256(signature)}.
     *
     * @param signature the canonical signature without spaces or parameter names, e.g.
     *     {@code "transfer(address,uint256)"}
     * @return the 4-byte selector, e.g. {@code 0xa9059cbb} for {@code transfer(address,uint256)}
     * @throws IllegalArgumentException if {@code signature} is not of the form {@code name(type,...)}
     */
    public static byte[] selector(String signature) {
        parseSignature(signature);
        return Arrays.copyOf(Keccak.keccak256(signature.getBytes(StandardCharsets.US_ASCII)), SELECTOR_LENGTH);
    }

    /**
     * Encodes a function call: the selector followed by the arguments, one word each.
     *
     * @param signature the canonical signature, e.g. {@code "authorizationState(address,bytes32)"}; every
     *     parameter type must be one of the supported static types
     * @param args the arguments in declaration order, with the Java types listed in the class documentation
     * @return the calldata, {@code 4 + 32 * args.length} bytes
     * @throws IllegalArgumentException if the signature is malformed or declares an unsupported type, the number
     *     of arguments differs from the number of parameters, or an argument has the wrong type or is out of range
     */
    public static byte[] encodeCall(String signature, Object... args) {
        Objects.requireNonNull(args, "args");
        List<String> types = parseSignature(signature);
        if (types.size() != args.length) {
            throw new IllegalArgumentException(
                    signature + " takes " + types.size() + " arguments, got " + args.length);
        }
        byte[] out = new byte[SELECTOR_LENGTH + WORD_LENGTH * args.length];
        System.arraycopy(selector(signature), 0, out, 0, SELECTOR_LENGTH);
        for (int i = 0; i < args.length; i++) {
            byte[] word = encodeStatic(types.get(i), args[i], i);
            System.arraycopy(word, 0, out, SELECTOR_LENGTH + WORD_LENGTH * i, WORD_LENGTH);
        }
        return out;
    }

    /**
     * Decodes a single {@code uint256} return value: the first word of the data.
     *
     * @param returnData the data returned by the call
     * @return the value
     * @throws IllegalArgumentException if the data is shorter than one word
     */
    public static BigInteger decodeUint256(byte[] returnData) {
        return new BigInteger(1, firstWord(returnData));
    }

    /**
     * Decodes a single {@code bool} return value. As in the Solidity decoder, the word must be exactly 0 or 1.
     *
     * @param returnData the data returned by the call
     * @return the value
     * @throws IllegalArgumentException if the data is shorter than one word or the word is neither 0 nor 1
     */
    public static boolean decodeBool(byte[] returnData) {
        BigInteger value = decodeUint256(returnData);
        if (value.compareTo(BigInteger.ONE) > 0) {
            throw new IllegalArgumentException("ABI bool must be 0 or 1");
        }
        return value.signum() == 1;
    }

    /**
     * Decodes a single {@code string} return value: an offset word pointing to a length word followed by the
     * UTF-8 bytes. Invalid UTF-8 sequences are replaced with U+FFFD.
     *
     * @param returnData the data returned by the call
     * @return the string
     * @throws IllegalArgumentException if the offset or length points outside the data
     */
    public static String decodeString(byte[] returnData) {
        Objects.requireNonNull(returnData, "returnData");
        int offset = readLength(returnData, 0, "string offset");
        int lengthPosition = checkedEnd(offset, WORD_LENGTH, returnData.length, "string offset");
        int length = readLength(returnData, offset, "string length");
        int end = checkedEnd(lengthPosition, length, returnData.length, "string length");
        return new String(returnData, lengthPosition, end - lengthPosition, StandardCharsets.UTF_8);
    }

    /**
     * Extracts the message of a Solidity {@code Error(string)} revert, as produced by {@code require(cond, "msg")}
     * and {@code revert("msg")}.
     *
     * @param revertData the revert data, i.e. selector {@code 0x08c379a0} followed by an ABI string
     * @return the message, or empty when the data is not a well-formed {@code Error(string)}, e.g. a custom error
     *     or a panic
     */
    public static Optional<String> decodeRevertReason(byte[] revertData) {
        Objects.requireNonNull(revertData, "revertData");
        if (revertData.length < SELECTOR_LENGTH
                || !Arrays.equals(revertData, 0, SELECTOR_LENGTH, ERROR_SELECTOR, 0, SELECTOR_LENGTH)) {
            return Optional.empty();
        }
        try {
            return Optional.of(decodeString(Arrays.copyOfRange(revertData, SELECTOR_LENGTH, revertData.length)));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    private static List<String> parseSignature(String signature) {
        Objects.requireNonNull(signature, "signature");
        Matcher matcher = SIGNATURE.matcher(signature);
        if (!matcher.matches()) {
            throw new IllegalArgumentException("Not a canonical function signature: " + signature);
        }
        String parameters = matcher.group(1);
        List<String> types = new ArrayList<>();
        if (!parameters.isEmpty()) {
            for (String type : parameters.split(",", -1)) {
                if (type.isEmpty()) {
                    throw new IllegalArgumentException("Empty parameter type in " + signature);
                }
                types.add(type);
            }
        }
        return types;
    }

    private static byte[] encodeStatic(String type, Object arg, int index) {
        if (arg == null) {
            throw new IllegalArgumentException("Argument " + index + " (" + type + ") is null");
        }
        if ("address".equals(type)) {
            if (!(arg instanceof String address) || !EvmAddress.isValid(address)) {
                throw new IllegalArgumentException("Argument " + index + " (address) must be a hex address string");
            }
            byte[] word = new byte[WORD_LENGTH];
            System.arraycopy(EvmAddress.toBytes(address), 0, word, ADDRESS_PADDING, EvmAddress.LENGTH);
            return word;
        }
        if ("bool".equals(type)) {
            if (!(arg instanceof Boolean flag)) {
                throw new IllegalArgumentException("Argument " + index + " (bool) must be a Boolean");
            }
            return Uint256.toBytes(flag ? BigInteger.ONE : BigInteger.ZERO);
        }
        Matcher uint = UINT.matcher(type);
        if (uint.matches()) {
            return Uint256.toBytes(unsigned(arg, Integer.parseInt(uint.group(1)), type, index));
        }
        Matcher bytes = FIXED_BYTES.matcher(type);
        if (bytes.matches()) {
            return fixedBytes(arg, Integer.parseInt(bytes.group(1)), type, index);
        }
        throw new IllegalArgumentException("Unsupported ABI parameter type: " + type);
    }

    private static BigInteger unsigned(Object arg, int bits, String type, int index) {
        if (bits % 8 != 0 || bits > 256) {
            throw new IllegalArgumentException("Unsupported ABI parameter type: " + type);
        }
        BigInteger value;
        if (arg instanceof BigInteger big) {
            value = big;
        } else if (arg instanceof Long || arg instanceof Integer || arg instanceof Short || arg instanceof Byte) {
            value = BigInteger.valueOf(((Number) arg).longValue());
        } else {
            throw new IllegalArgumentException("Argument " + index + " (" + type + ") must be an integer");
        }
        if (value.signum() < 0 || value.bitLength() > bits) {
            throw new IllegalArgumentException("Argument " + index + " (" + type + ") is out of range");
        }
        return value;
    }

    private static byte[] fixedBytes(Object arg, int length, String type, int index) {
        if (length > WORD_LENGTH) {
            throw new IllegalArgumentException("Unsupported ABI parameter type: " + type);
        }
        if (!(arg instanceof byte[] value) || value.length != length) {
            throw new IllegalArgumentException(
                    "Argument " + index + " (" + type + ") must be a byte[] of length " + length);
        }
        return Arrays.copyOf(value, WORD_LENGTH);
    }

    private static byte[] firstWord(byte[] returnData) {
        Objects.requireNonNull(returnData, "returnData");
        if (returnData.length < WORD_LENGTH) {
            throw new IllegalArgumentException(
                    "ABI return data must hold at least one word, got " + returnData.length + " bytes");
        }
        return Arrays.copyOf(returnData, WORD_LENGTH);
    }

    /** Reads the word at {@code position} as a length or offset that must fit the data. */
    private static int readLength(byte[] data, int position, String what) {
        checkedEnd(position, WORD_LENGTH, data.length, what);
        BigInteger value = new BigInteger(1, Arrays.copyOfRange(data, position, position + WORD_LENGTH));
        if (value.compareTo(BigInteger.valueOf(data.length)) > 0) {
            throw new IllegalArgumentException("ABI " + what + " points outside the return data");
        }
        return value.intValue();
    }

    private static int checkedEnd(int start, int length, int limit, String what) {
        if ((long) start + length > limit) {
            throw new IllegalArgumentException("ABI " + what + " points outside the return data");
        }
        return start + length;
    }
}
