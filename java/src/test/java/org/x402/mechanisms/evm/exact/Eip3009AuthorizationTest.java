package org.x402.mechanisms.evm.exact;

import org.junit.jupiter.api.Test;
import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.Secp256k1;
import org.x402.mechanisms.evm.TypedDataDomain;
import org.x402.mechanisms.evm.Uint256;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_CHAIN_ID;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_DIGEST;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_SIGNATURE;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_USDC;
import static org.x402.mechanisms.evm.CastVectors.NONCE;
import static org.x402.mechanisms.evm.CastVectors.VALID_BEFORE;

class Eip3009AuthorizationTest {

    static final Eip3009Authorization AUTHORIZATION =
            new Eip3009Authorization(ANVIL_ADDRESS_0, ANVIL_ADDRESS_1, "1000", "0", VALID_BEFORE, NONCE);

    @Test
    void computesTheDigestCastSigned() {
        TypedDataDomain domain = new TypedDataDomain("USDC", "2", BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC);

        byte[] digest = AUTHORIZATION.digest(domain);

        assertEquals(BASE_SEPOLIA_DIGEST, Hex.encode(digest));
        assertEquals(ANVIL_ADDRESS_0, Secp256k1.recoverAddress(digest, Hex.decode(BASE_SEPOLIA_SIGNATURE)));
    }

    @Test
    void roundTripsThroughItsMapForm() {
        Map<String, Object> map = AUTHORIZATION.toMap();

        assertEquals(List.of("from", "to", "value", "validAfter", "validBefore", "nonce"), List.copyOf(map.keySet()));
        assertEquals("1000", map.get("value"));
        assertEquals(AUTHORIZATION, Eip3009Authorization.fromMap(map));
        assertThrows(UnsupportedOperationException.class, () -> map.put("value", "1"));
    }

    @Test
    void ignoresUnknownKeys() {
        Map<String, Object> map = new LinkedHashMap<>(AUTHORIZATION.toMap());
        map.put("extra", 1);

        assertEquals(AUTHORIZATION, Eip3009Authorization.fromMap(map));
    }

    @Test
    void keepsWireFormVerbatim() {
        String lowerTo = ANVIL_ADDRESS_1.toLowerCase(Locale.ROOT);
        Eip3009Authorization authorization =
                new Eip3009Authorization(ANVIL_ADDRESS_0, lowerTo, "0001000", "0", VALID_BEFORE, NONCE.substring(2));

        assertEquals(lowerTo, authorization.toMap().get("to"));
        assertEquals("0001000", authorization.toMap().get("value"));
        assertEquals(NONCE.substring(2), authorization.toMap().get("nonce"));
    }

    @Test
    void reportsMissingAndNonStringMembers() {
        Map<String, Object> missing = new LinkedHashMap<>(AUTHORIZATION.toMap());
        missing.remove("validBefore");
        Map<String, Object> number = new LinkedHashMap<>(AUTHORIZATION.toMap());
        number.put("value", 1000);

        assertEquals("authorization.validBefore is missing", assertThrows(IllegalArgumentException.class,
                () -> Eip3009Authorization.fromMap(missing)).getMessage());
        assertEquals("authorization.value must be a string", assertThrows(IllegalArgumentException.class,
                () -> Eip3009Authorization.fromMap(number)).getMessage());
    }

    @Test
    void rejectsMalformedMembers() {
        assertInvalid("authorization.from is not an EVM address",
                "0x1234", ANVIL_ADDRESS_1, "1000", "0", VALID_BEFORE, NONCE);
        assertInvalid("authorization.to is not an EVM address",
                ANVIL_ADDRESS_0, "", "1000", "0", VALID_BEFORE, NONCE);
        assertInvalid("authorization.value must be a base-10 uint256",
                ANVIL_ADDRESS_0, ANVIL_ADDRESS_1, "-1", "0", VALID_BEFORE, NONCE);
        assertInvalid("authorization.value must be a base-10 uint256",
                ANVIL_ADDRESS_0, ANVIL_ADDRESS_1, "1.5", "0", VALID_BEFORE, NONCE);
        assertInvalid("authorization.validAfter must be a base-10 uint256",
                ANVIL_ADDRESS_0, ANVIL_ADDRESS_1, "1000", "0x0", VALID_BEFORE, NONCE);
        assertInvalid("authorization.validBefore must be a base-10 uint256",
                ANVIL_ADDRESS_0, ANVIL_ADDRESS_1, "1000", "0", Uint256.MAX_VALUE + "0", NONCE);
        assertInvalid("authorization.nonce must be 32 bytes of hex",
                ANVIL_ADDRESS_0, ANVIL_ADDRESS_1, "1000", "0", VALID_BEFORE, "0x1234");
    }

    private static void assertInvalid(String message, String from, String to, String value, String validAfter,
            String validBefore, String nonce) {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> new Eip3009Authorization(from, to, value, validAfter, validBefore, nonce));
        assertEquals(message, e.getMessage());
    }
}
