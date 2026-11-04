package org.x402.mechanisms.evm;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

class HexTest {

    @Test
    void encodesLowercaseWithAndWithoutPrefix() {
        byte[] bytes = {0x0a, (byte) 0xff, 0x00};

        assertEquals("0x0aff00", Hex.encode(bytes));
        assertEquals("0aff00", Hex.encodeNoPrefix(bytes));
        assertEquals("0x", Hex.encode(new byte[0]));
    }

    @Test
    void decodesAnyCaseWithOrWithoutPrefix() {
        byte[] expected = {0x0a, (byte) 0xff};

        assertArrayEquals(expected, Hex.decode("0x0aff"));
        assertArrayEquals(expected, Hex.decode("0X0AFF"));
        assertArrayEquals(expected, Hex.decode("0aFf"));
        assertArrayEquals(new byte[0], Hex.decode("0x"));
        assertArrayEquals(new byte[0], Hex.decode(""));
    }

    @Test
    void rejectsOddNumberOfDigits() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> Hex.decode("0xabc"));

        assertEquals("Invalid hex: odd number of digits (3)", e.getMessage());
    }

    @Test
    void rejectsNonHexCharactersIncludingWhitespaceAndNonAsciiDigits() {
        assertThrows(IllegalArgumentException.class, () -> Hex.decode("0xzz"));
        assertThrows(IllegalArgumentException.class, () -> Hex.decode(" 0x00"));
        assertThrows(IllegalArgumentException.class, () -> Hex.decode("0x00 "));
        assertThrows(IllegalArgumentException.class, () -> Hex.decode("0x0x00"));
        // Fullwidth digits are digits to Character.digit but not hex on the wire
        assertThrows(IllegalArgumentException.class, () -> Hex.decode("０１"));
    }

    @Test
    void errorMessagesDoNotEchoTheInput() {
        String secretLooking = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ffZZ";

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> Hex.decode(secretLooking));

        assertFalse(e.getMessage().contains("ac0974"), e.getMessage());
    }

    @Test
    void decodesFixedLength() {
        assertArrayEquals(new byte[] {1, 2}, Hex.decode("0x0102", 2));

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> Hex.decode("0x0102", 32));
        assertEquals("Invalid hex: expected 32 bytes, got 2", e.getMessage());
    }
}
