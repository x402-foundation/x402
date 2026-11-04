package org.x402.mechanisms.evm;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.StringJoiner;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * EIP-712 typed structured data hashing for flat structs.
 *
 * <p>The signed digest is {@code keccak256(0x19 || 0x01 || domainSeparator || hashStruct(message))}, where
 * {@code hashStruct(s) = keccak256(typeHash || encodeData(s))} and {@code typeHash} is the Keccak-256 of the type
 * string, e.g. {@code TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,
 * uint256 validBefore,bytes32 nonce)}.
 *
 * <p>Only flat structs are supported: every field has one of the atomic types below, so nested structs and
 * arrays are rejected. Message values may be given in their JSON form (what {@code eth_signTypedData_v4} takes)
 * or as the matching Java type:
 * <table>
 *   <caption>Accepted message values</caption>
 *   <tr><th>Solidity type</th><th>Accepted Java values</th></tr>
 *   <tr><td>{@code address}</td><td>{@code String} of 40 hex digits, any case, optional {@code 0x}</td></tr>
 *   <tr><td>{@code uint8} ... {@code uint256} (multiples of 8)</td>
 *       <td>{@code BigInteger}, {@code Long}, {@code Integer}, {@code Short}, {@code Byte}, or a base-10
 *       {@code String}; must be non-negative and fit the width</td></tr>
 *   <tr><td>{@code bytes1} ... {@code bytes32}</td>
 *       <td>{@code byte[]} or hex {@code String} of exactly that many bytes</td></tr>
 *   <tr><td>{@code string}</td><td>{@code String}, hashed as UTF-8</td></tr>
 *   <tr><td>{@code bool}</td><td>{@code Boolean}</td></tr>
 * </table>
 *
 * <p>The message must contain exactly the declared fields: a missing or {@code null} value and an undeclared
 * key are both rejected, as in go-ethereum's {@code apitypes}.
 *
 * <p>This class is stateless and thread-safe.
 */
public final class Eip712 {

    /** Name of the EIP-712 domain struct type. */
    public static final String DOMAIN_TYPE = "EIP712Domain";

    private static final byte[] DIGEST_PREFIX = {0x19, 0x01};
    private static final Pattern IDENTIFIER = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*");
    private static final Pattern UINT = Pattern.compile("uint([1-9][0-9]{0,2})");
    private static final Pattern FIXED_BYTES = Pattern.compile("bytes([1-9][0-9]?)");

    private Eip712() {
    }

    /**
     * Computes the EIP-712 digest that is signed: {@code keccak256(0x19 || 0x01 || domainSeparator ||
     * hashStruct(primaryType, message))}.
     *
     * @param domain the signing domain
     * @param fields the fields of {@code primaryType}, in declaration order
     * @param primaryType the struct name, e.g. {@code "TransferWithAuthorization"}
     * @param message the field values, see the class documentation for accepted types
     * @return the 32-byte digest
     * @throws IllegalArgumentException if the type is not a supported flat struct or the message does not match
     *     it
     */
    public static byte[] hashTypedData(
            TypedDataDomain domain, List<TypedDataField> fields, String primaryType, Map<String, ?> message) {
        byte[] domainSeparator = domainSeparator(domain);
        byte[] structHash = hashStruct(primaryType, fields, message);
        return Keccak.keccak256(DIGEST_PREFIX, domainSeparator, structHash);
    }

    /**
     * Computes the domain separator, {@code hashStruct("EIP712Domain", domain)}, declaring only the present
     * domain members.
     *
     * @param domain the signing domain
     * @return the 32-byte domain separator
     */
    public static byte[] domainSeparator(TypedDataDomain domain) {
        Objects.requireNonNull(domain, "domain");
        List<TypedDataField> fields = new ArrayList<>(4);
        Map<String, Object> values = new LinkedHashMap<>();
        if (domain.name() != null) {
            fields.add(new TypedDataField("name", "string"));
            values.put("name", domain.name());
        }
        if (domain.version() != null) {
            fields.add(new TypedDataField("version", "string"));
            values.put("version", domain.version());
        }
        if (domain.chainId() != null) {
            fields.add(new TypedDataField("chainId", "uint256"));
            values.put("chainId", domain.chainId());
        }
        if (domain.verifyingContract() != null) {
            fields.add(new TypedDataField("verifyingContract", "address"));
            values.put("verifyingContract", domain.verifyingContract());
        }
        return hashStruct(DOMAIN_TYPE, fields, values);
    }

    /**
     * Computes {@code hashStruct(message) = keccak256(typeHash || encodeData(message))}.
     *
     * @param primaryType the struct name
     * @param fields the fields of the struct, in declaration order
     * @param message the field values, see the class documentation for accepted types
     * @return the 32-byte struct hash
     * @throws IllegalArgumentException if the type is not a supported flat struct or the message does not match
     *     it
     */
    public static byte[] hashStruct(String primaryType, List<TypedDataField> fields, Map<String, ?> message) {
        byte[] typeHash = typeHash(primaryType, fields);
        Objects.requireNonNull(message, "message");
        Set<String> declared = new HashSet<>();
        for (TypedDataField field : fields) {
            declared.add(field.name());
        }
        for (String key : message.keySet()) {
            if (!declared.contains(key)) {
                throw new IllegalArgumentException("Message field '" + key + "' is not declared in " + primaryType);
            }
        }
        byte[][] words = new byte[fields.size() + 1][];
        words[0] = typeHash;
        for (int i = 0; i < fields.size(); i++) {
            words[i + 1] = encodeField(fields.get(i), message.get(fields.get(i).name()));
        }
        return Keccak.keccak256(words);
    }

    /**
     * Computes the type hash, {@code keccak256(encodeType(primaryType, fields))}.
     *
     * @param primaryType the struct name
     * @param fields the fields of the struct, in declaration order
     * @return the 32-byte type hash
     * @throws IllegalArgumentException if the type is not a supported flat struct
     */
    public static byte[] typeHash(String primaryType, List<TypedDataField> fields) {
        return Keccak.keccak256(encodeType(primaryType, fields).getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Builds the type string of a flat struct, e.g. {@code Mail(address from,string contents)}.
     *
     * @param primaryType the struct name, a Solidity identifier
     * @param fields the fields of the struct, in declaration order; names must be unique identifiers
     * @return the type string
     * @throws IllegalArgumentException if a name is not an identifier, a field name repeats, or a field type is
     *     not supported
     */
    public static String encodeType(String primaryType, List<TypedDataField> fields) {
        requireIdentifier(primaryType, "Type name");
        Objects.requireNonNull(fields, "fields");
        Set<String> names = new HashSet<>();
        StringJoiner type = new StringJoiner(",", primaryType + "(", ")");
        for (TypedDataField field : fields) {
            Objects.requireNonNull(field, "field");
            requireIdentifier(field.name(), "Field name");
            if (!names.add(field.name())) {
                throw new IllegalArgumentException("Duplicate field '" + field.name() + "' in " + primaryType);
            }
            AtomicType.parse(field.type());
            type.add(field.type() + " " + field.name());
        }
        return type.toString();
    }

    private static byte[] encodeField(TypedDataField field, Object value) {
        if (value == null) {
            throw new IllegalArgumentException("Missing value for field '" + field.name() + "'");
        }
        AtomicType type = AtomicType.parse(field.type());
        try {
            return switch (type.kind()) {
                case ADDRESS -> leftPad(EvmAddress.toBytes(requireString(value)));
                case BOOL -> Uint256.toBytes(requireBoolean(value) ? BigInteger.ONE : BigInteger.ZERO);
                case STRING -> Keccak.keccak256(requireString(value).getBytes(StandardCharsets.UTF_8));
                case UINT -> Uint256.toBytes(toUnsigned(value, type.size()));
                case FIXED_BYTES -> rightPad(toFixedBytes(value, type.size()));
            };
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(
                    "Invalid value for field '" + field.name() + "' (" + field.type() + "): " + e.getMessage(), e);
        }
    }

    private static BigInteger toUnsigned(Object value, int bits) {
        BigInteger number;
        if (value instanceof BigInteger big) {
            number = big;
        } else if (value instanceof Long || value instanceof Integer || value instanceof Short
                || value instanceof Byte) {
            number = BigInteger.valueOf(((Number) value).longValue());
        } else if (value instanceof String text) {
            number = Uint256.parse(text);
        } else {
            throw new IllegalArgumentException(
                    "expected BigInteger, integral Number or base-10 String, got " + value.getClass().getSimpleName());
        }
        if (number.signum() < 0 || number.bitLength() > bits) {
            throw new IllegalArgumentException("value does not fit in uint" + bits);
        }
        return number;
    }

    private static byte[] toFixedBytes(Object value, int size) {
        if (value instanceof byte[] bytes) {
            if (bytes.length != size) {
                throw new IllegalArgumentException("expected " + size + " bytes, got " + bytes.length);
            }
            return bytes;
        }
        if (value instanceof String hex) {
            return Hex.decode(hex, size);
        }
        throw new IllegalArgumentException("expected byte[] or hex String, got " + value.getClass().getSimpleName());
    }

    private static String requireString(Object value) {
        if (value instanceof String text) {
            return text;
        }
        throw new IllegalArgumentException("expected String, got " + value.getClass().getSimpleName());
    }

    private static boolean requireBoolean(Object value) {
        if (value instanceof Boolean flag) {
            return flag;
        }
        throw new IllegalArgumentException("expected Boolean, got " + value.getClass().getSimpleName());
    }

    private static byte[] leftPad(byte[] bytes) {
        byte[] word = new byte[Uint256.BYTES];
        System.arraycopy(bytes, 0, word, Uint256.BYTES - bytes.length, bytes.length);
        return word;
    }

    private static byte[] rightPad(byte[] bytes) {
        byte[] word = new byte[Uint256.BYTES];
        System.arraycopy(bytes, 0, word, 0, bytes.length);
        return word;
    }

    private static void requireIdentifier(String name, String what) {
        Objects.requireNonNull(name, what);
        if (!IDENTIFIER.matcher(name).matches()) {
            throw new IllegalArgumentException(what + " '" + name + "' is not a Solidity identifier");
        }
    }

    /** The supported field types, parsed from their Solidity spelling. */
    private record AtomicType(Kind kind, int size) {

        private enum Kind { ADDRESS, BOOL, STRING, UINT, FIXED_BYTES }

        static AtomicType parse(String type) {
            return switch (type) {
                case "address" -> new AtomicType(Kind.ADDRESS, 0);
                case "bool" -> new AtomicType(Kind.BOOL, 0);
                case "string" -> new AtomicType(Kind.STRING, 0);
                default -> parseSized(type);
            };
        }

        private static AtomicType parseSized(String type) {
            Matcher uint = UINT.matcher(type);
            if (uint.matches()) {
                int bits = Integer.parseInt(uint.group(1));
                if (bits % 8 == 0 && bits <= 256) {
                    return new AtomicType(Kind.UINT, bits);
                }
            }
            Matcher fixed = FIXED_BYTES.matcher(type);
            if (fixed.matches() && Integer.parseInt(fixed.group(1)) <= Uint256.BYTES) {
                return new AtomicType(Kind.FIXED_BYTES, Integer.parseInt(fixed.group(1)));
            }
            throw new IllegalArgumentException("Unsupported EIP-712 field type '" + type + "': only flat structs of"
                    + " address, bool, string, uint8..uint256 and bytes1..bytes32 are supported");
        }
    }
}
