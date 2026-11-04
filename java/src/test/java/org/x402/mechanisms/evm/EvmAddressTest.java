package org.x402.mechanisms.evm;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Locale;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_PUBLIC_KEY_0;

class EvmAddressTest {

    /** The test vectors of EIP-55, each also confirmed with {@code cast to-check-sum-address}. */
    private static final List<String> EIP55_VECTORS = List.of(
            // All caps
            "0x52908400098527886E0F7030069857D2E4169EE7",
            "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
            // All lower
            "0xde709f2102306220921060314715629080e2fb77",
            "0x27b1fdb04752bbc536007a920d24acb045561c26",
            // Normal
            "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
            "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
            "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
            "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb");

    @Test
    void checksumsEip55SpecVectors() {
        for (String expected : EIP55_VECTORS) {
            String lower = "0x" + expected.substring(2).toLowerCase(Locale.ROOT);
            String upper = "0X" + expected.substring(2).toUpperCase(Locale.ROOT);

            assertEquals(expected, EvmAddress.toChecksum(lower));
            assertEquals(expected, EvmAddress.toChecksum(upper));
            assertEquals(expected, EvmAddress.toChecksum(expected.substring(2)));
            assertEquals(expected, EvmAddress.toChecksum(EvmAddress.toBytes(expected)));
        }
    }

    @Test
    void validatesShapeButNotChecksum() {
        assertTrue(EvmAddress.isValid(ANVIL_ADDRESS_0));
        assertTrue(EvmAddress.isValid(ANVIL_ADDRESS_0.substring(2)));
        assertTrue(EvmAddress.isValid(ANVIL_ADDRESS_0.toUpperCase(Locale.ROOT)));
        // EIP-55 is not verified: a wrong checksum is still an address
        assertTrue(EvmAddress.isValid("0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266"));

        assertFalse(EvmAddress.isValid(null));
        assertFalse(EvmAddress.isValid("0x"));
        assertFalse(EvmAddress.isValid(ANVIL_ADDRESS_0.substring(0, 41)));
        assertFalse(EvmAddress.isValid(ANVIL_ADDRESS_0 + "0"));
        assertFalse(EvmAddress.isValid("0xg39Fd6e51aad88F6F4ce6aB8827279cffFb92266"));
        assertFalse(EvmAddress.isValid(" " + ANVIL_ADDRESS_0));
    }

    @Test
    void decodesTo20Bytes() {
        assertEquals("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", Hex.encode(EvmAddress.toBytes(ANVIL_ADDRESS_0)));
    }

    @Test
    void rejectsMalformedAddresses() {
        assertThrows(IllegalArgumentException.class, () -> EvmAddress.toBytes("0x1234"));
        assertThrows(IllegalArgumentException.class, () -> EvmAddress.toChecksum("not an address"));
        assertThrows(IllegalArgumentException.class, () -> EvmAddress.toChecksum(new byte[19]));
    }

    @Test
    void derivesAddressFromPublicKey() {
        byte[] raw = Hex.decode(ANVIL_PUBLIC_KEY_0);
        byte[] uncompressed = Hex.decode("0x04" + Hex.stripPrefix(ANVIL_PUBLIC_KEY_0));

        assertEquals(ANVIL_ADDRESS_0, EvmAddress.fromPublicKey(raw));
        assertEquals(ANVIL_ADDRESS_0, EvmAddress.fromPublicKey(uncompressed));
    }

    @Test
    void comparesAddressesIgnoringCaseAndPrefix() {
        String lower = ANVIL_ADDRESS_0.toLowerCase(Locale.ROOT);

        assertTrue(EvmAddress.equalsIgnoreCase(ANVIL_ADDRESS_0, lower));
        assertTrue(EvmAddress.equalsIgnoreCase(ANVIL_ADDRESS_0, lower.substring(2)));
        assertFalse(EvmAddress.equalsIgnoreCase(ANVIL_ADDRESS_0, ANVIL_ADDRESS_1));
        assertFalse(EvmAddress.equalsIgnoreCase(ANVIL_ADDRESS_0, null));
        assertFalse(EvmAddress.equalsIgnoreCase(null, null));
        assertFalse(EvmAddress.equalsIgnoreCase("garbage", "garbage"));
    }
}
