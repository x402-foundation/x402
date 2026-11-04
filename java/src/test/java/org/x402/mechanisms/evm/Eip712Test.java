package org.x402.mechanisms.evm;

import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.BASE_MAX_DIGEST;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_CHAIN_ID;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_DIGEST;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_DOMAIN_SEPARATOR;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_STRUCT_HASH;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_USDC;
import static org.x402.mechanisms.evm.CastVectors.BASE_USDC;
import static org.x402.mechanisms.evm.CastVectors.EIP712_DOMAIN_TYPEHASH;
import static org.x402.mechanisms.evm.CastVectors.MAX_NONCE;
import static org.x402.mechanisms.evm.CastVectors.NONCE;
import static org.x402.mechanisms.evm.CastVectors.NOTE_DIGEST;
import static org.x402.mechanisms.evm.CastVectors.NOTE_STRUCT_HASH;
import static org.x402.mechanisms.evm.CastVectors.NOTE_TYPEHASH;
import static org.x402.mechanisms.evm.CastVectors.PERMIT2;
import static org.x402.mechanisms.evm.CastVectors.PERMIT2_BASE_SEPOLIA_DOMAIN_SEPARATOR;
import static org.x402.mechanisms.evm.CastVectors.TRANSFER_WITH_AUTHORIZATION_TYPEHASH;
import static org.x402.mechanisms.evm.CastVectors.VALID_BEFORE;

class Eip712Test {

    private static final TypedDataDomain BASE_SEPOLIA_USDC_DOMAIN =
            new TypedDataDomain("USDC", "2", BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC);

    private static final List<TypedDataField> NOTE_FIELDS = List.of(
            new TypedDataField("author", "address"),
            new TypedDataField("approved", "bool"),
            new TypedDataField("priority", "uint8"),
            new TypedDataField("text", "string"),
            new TypedDataField("tag", "bytes4"),
            new TypedDataField("amount", "uint64"));

    @Test
    void encodesTransferWithAuthorizationType() {
        assertEquals("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,"
                        + "uint256 validBefore,bytes32 nonce)",
                Eip712.encodeType(EvmConstants.TRANSFER_WITH_AUTHORIZATION,
                        EvmConstants.TRANSFER_WITH_AUTHORIZATION_FIELDS));
        assertEquals(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, Hex.encode(Eip712.typeHash(
                EvmConstants.TRANSFER_WITH_AUTHORIZATION, EvmConstants.TRANSFER_WITH_AUTHORIZATION_FIELDS)));
    }

    @Test
    void hashesDomainType() {
        List<TypedDataField> domainFields = List.of(
                new TypedDataField("name", "string"),
                new TypedDataField("version", "string"),
                new TypedDataField("chainId", "uint256"),
                new TypedDataField("verifyingContract", "address"));

        assertEquals(EIP712_DOMAIN_TYPEHASH, Hex.encode(Eip712.typeHash(Eip712.DOMAIN_TYPE, domainFields)));
    }

    @Test
    void computesUsdcDomainSeparatorDeployedOnBaseSepolia() {
        assertEquals(BASE_SEPOLIA_DOMAIN_SEPARATOR, Hex.encode(Eip712.domainSeparator(BASE_SEPOLIA_USDC_DOMAIN)));
    }

    @Test
    void leavesAbsentDomainMembersOutOfTheDomainType() {
        TypedDataDomain permit2 = new TypedDataDomain("Permit2", null, BASE_SEPOLIA_CHAIN_ID, PERMIT2);

        assertEquals(PERMIT2_BASE_SEPOLIA_DOMAIN_SEPARATOR, Hex.encode(Eip712.domainSeparator(permit2)));
    }

    @Test
    void hashesTransferWithAuthorizationLikeCast() {
        Map<String, Object> message = baseSepoliaMessage();

        assertEquals(BASE_SEPOLIA_STRUCT_HASH, Hex.encode(Eip712.hashStruct(
                EvmConstants.TRANSFER_WITH_AUTHORIZATION, EvmConstants.TRANSFER_WITH_AUTHORIZATION_FIELDS, message)));
        assertEquals(BASE_SEPOLIA_DIGEST, Hex.encode(twaDigest(BASE_SEPOLIA_USDC_DOMAIN, message)));
    }

    @Test
    void hashesUint256AndBytes32Extremes() {
        TypedDataDomain base = new TypedDataDomain("USD Coin", "2", BigInteger.valueOf(8453), BASE_USDC);
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("from", ANVIL_ADDRESS_1);
        message.put("to", ANVIL_ADDRESS_0);
        message.put("value", Uint256.MAX_VALUE.toString());
        message.put("validAfter", "1700000000");
        message.put("validBefore", "1800000000");
        message.put("nonce", MAX_NONCE);

        assertEquals(BASE_MAX_DIGEST, Hex.encode(twaDigest(base, message)));
    }

    @Test
    void acceptsJavaTypesAndJsonFormsInterchangeably() {
        Map<String, Object> javaTyped = new HashMap<>();
        javaTyped.put("from", ANVIL_ADDRESS_0.toLowerCase(Locale.ROOT));
        javaTyped.put("to", ANVIL_ADDRESS_1.substring(2));
        javaTyped.put("value", 1000L);
        javaTyped.put("validAfter", 0);
        javaTyped.put("validBefore", new BigInteger(VALID_BEFORE));
        javaTyped.put("nonce", Hex.decode(NONCE));

        assertEquals(BASE_SEPOLIA_DIGEST, Hex.encode(twaDigest(BASE_SEPOLIA_USDC_DOMAIN, javaTyped)));
    }

    @Test
    void hashesEverySupportedFieldTypeLikeCast() {
        TypedDataDomain domain = new TypedDataDomain("x402 Java", null, BigInteger.ONE, null);

        assertEquals(NOTE_TYPEHASH, Hex.encode(Eip712.typeHash("Note", NOTE_FIELDS)));
        assertEquals(NOTE_STRUCT_HASH, Hex.encode(Eip712.hashStruct("Note", NOTE_FIELDS, noteMessage())));
        assertEquals(NOTE_DIGEST, Hex.encode(Eip712.hashTypedData(domain, NOTE_FIELDS, "Note", noteMessage())));
    }

    @Test
    void acceptsSmallerIntegralNumberTypes() {
        Map<String, Object> message = noteMessage();
        message.put("priority", (short) 255);
        message.put("amount", new BigInteger("18446744073709551615"));

        assertEquals(NOTE_STRUCT_HASH, Hex.encode(Eip712.hashStruct("Note", NOTE_FIELDS, message)));

        message.put("priority", (byte) 1);
        assertEquals(32, Eip712.hashStruct("Note", NOTE_FIELDS, message).length);
    }

    @Test
    void rejectsMissingAndNullValues() {
        Map<String, Object> missing = baseSepoliaMessage();
        missing.remove("nonce");
        Map<String, Object> nullValue = baseSepoliaMessage();
        nullValue.put("nonce", null);

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> twaDigest(BASE_SEPOLIA_USDC_DOMAIN, missing));
        assertEquals("Missing value for field 'nonce'", e.getMessage());
        assertThrows(IllegalArgumentException.class, () -> twaDigest(BASE_SEPOLIA_USDC_DOMAIN, nullValue));
    }

    @Test
    void rejectsUndeclaredMessageFields() {
        Map<String, Object> extra = baseSepoliaMessage();
        extra.put("memo", "hi");

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> twaDigest(BASE_SEPOLIA_USDC_DOMAIN, extra));
        assertEquals("Message field 'memo' is not declared in TransferWithAuthorization", e.getMessage());
    }

    @Test
    void rejectsValuesThatDoNotMatchTheirType() {
        assertInvalidNote("author", "0x1234");
        assertInvalidNote("author", 42);
        assertInvalidNote("approved", "true");
        assertInvalidNote("priority", 256);
        assertInvalidNote("priority", -1);
        assertInvalidNote("priority", 1.0);
        assertInvalidNote("priority", "1.5");
        assertInvalidNote("text", new byte[0]);
        assertInvalidNote("tag", "0xdeadbeefff");
        assertInvalidNote("tag", new byte[5]);
        assertInvalidNote("tag", 4);
        assertInvalidNote("amount", "18446744073709551616");
    }

    @Test
    void namesTheOffendingFieldInErrors() {
        Map<String, Object> message = noteMessage();
        message.put("priority", 256);

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> Eip712.hashStruct("Note", NOTE_FIELDS, message));
        assertEquals("Invalid value for field 'priority' (uint8): value does not fit in uint8", e.getMessage());
    }

    @Test
    void rejectsUnsupportedFieldTypes() {
        for (String type : List.of("uint7", "uint264", "uint", "int256", "bytes", "bytes0", "bytes33",
                "address[]", "TokenPermissions")) {
            List<TypedDataField> fields = List.of(new TypedDataField("x", type));

            assertThrows(IllegalArgumentException.class, () -> Eip712.encodeType("T", fields), type);
        }
    }

    @Test
    void rejectsInvalidStructDefinitions() {
        List<TypedDataField> duplicate = List.of(new TypedDataField("a", "bool"), new TypedDataField("a", "bool"));
        List<TypedDataField> badName = List.of(new TypedDataField("a b", "bool"));

        assertThrows(IllegalArgumentException.class, () -> Eip712.encodeType("T", duplicate));
        assertThrows(IllegalArgumentException.class, () -> Eip712.encodeType("T", badName));
        assertThrows(IllegalArgumentException.class, () -> Eip712.encodeType("T(", List.of()));
        assertThrows(IllegalArgumentException.class, () -> new TypedDataField("", "bool"));
        assertThrows(IllegalArgumentException.class, () -> new TypedDataField("a", ""));
        assertEquals("Empty()", Eip712.encodeType("Empty", List.of()));
    }

    @Test
    void rejectsInvalidDomains() {
        assertThrows(IllegalArgumentException.class,
                () -> new TypedDataDomain("USDC", "2", BigInteger.valueOf(-1), BASE_SEPOLIA_USDC));
        assertThrows(IllegalArgumentException.class,
                () -> new TypedDataDomain("USDC", "2", BASE_SEPOLIA_CHAIN_ID, "0x1234"));
    }

    private static byte[] twaDigest(TypedDataDomain domain, Map<String, ?> message) {
        return Eip712.hashTypedData(domain, EvmConstants.TRANSFER_WITH_AUTHORIZATION_FIELDS,
                EvmConstants.TRANSFER_WITH_AUTHORIZATION, message);
    }

    private static Map<String, Object> baseSepoliaMessage() {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("from", ANVIL_ADDRESS_0);
        message.put("to", ANVIL_ADDRESS_1);
        message.put("value", "1000");
        message.put("validAfter", "0");
        message.put("validBefore", VALID_BEFORE);
        message.put("nonce", NONCE);
        return message;
    }

    /** The message of {@code all_types.json}, in its JSON form. */
    private static Map<String, Object> noteMessage() {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("author", ANVIL_ADDRESS_0);
        message.put("approved", true);
        message.put("priority", 255);
        message.put("text", "héllo ₮");
        message.put("tag", "0xdeadbeef");
        message.put("amount", "18446744073709551615");
        return message;
    }

    private static void assertInvalidNote(String field, Object value) {
        Map<String, Object> message = noteMessage();
        message.put(field, value);

        assertThrows(IllegalArgumentException.class, () -> Eip712.hashStruct("Note", NOTE_FIELDS, message),
                field + "=" + value);
    }
}
