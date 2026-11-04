package org.x402.mechanisms.evm.rpc;

import org.x402.mechanisms.evm.Hex;

import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Vectors from the RLP specification (Ethereum wiki and Yellow Paper appendix B), each also reproduced with
 * {@code cast to-rlp}.
 */
class RlpTest {

    @Test
    void encodesShortStringsWithLengthPrefix() {
        // "dog"
        assertEquals("0x83646f67", hex(Rlp.encodeString(ascii("dog"))));
        // cast to-rlp '"0x"'
        assertEquals("0x80", hex(Rlp.encodeString(new byte[0])));
    }

    @Test
    void encodesSingleBytesBelow0x80AsThemselves() {
        // cast to-rlp '"0x00"', '"0x7f"', '"0x80"'
        assertEquals("0x00", hex(Rlp.encodeString(new byte[] {0x00})));
        assertEquals("0x7f", hex(Rlp.encodeString(new byte[] {0x7f})));
        assertEquals("0x8180", hex(Rlp.encodeString(new byte[] {(byte) 0x80})));
    }

    @Test
    void encodesLongStringsWithLengthOfLength() {
        // cast to-rlp "\"$(cast from-utf8 'Lorem ipsum dolor sit amet, consectetur adipisicing elit')\""
        byte[] lorem = ascii("Lorem ipsum dolor sit amet, consectetur adipisicing elit");
        assertEquals("0xb838" + Hex.encodeNoPrefix(lorem), hex(Rlp.encodeString(lorem)));
    }

    @Test
    void encodesStringsLongerThan255BytesWithTwoLengthBytes() {
        // cast to-rlp '"0xaa...aa" (1024 bytes)' starts with 0xb90400
        byte[] payload = new byte[1024];
        Arrays.fill(payload, (byte) 0xaa);

        byte[] encoded = Rlp.encodeString(payload);

        assertEquals("0xb90400", hex(Arrays.copyOf(encoded, 3)));
        assertEquals(1027, encoded.length);
    }

    @Test
    void encodesIntegersMinimally() {
        assertEquals("0x80", hex(Rlp.encodeInteger(BigInteger.ZERO)));
        assertEquals("0x0f", hex(Rlp.encodeInteger(BigInteger.valueOf(15))));
        assertEquals("0x820400", hex(Rlp.encodeInteger(BigInteger.valueOf(1024))));
        // The top bit is set, so toByteArray() carries a sign byte that must be dropped
        assertEquals("0x8180", hex(Rlp.encodeInteger(BigInteger.valueOf(128))));
        assertEquals("0xa0" + "ff".repeat(32),
                hex(Rlp.encodeInteger(BigInteger.ONE.shiftLeft(256).subtract(BigInteger.ONE))));
    }

    @Test
    void rejectsNegativeIntegers() {
        assertThrows(IllegalArgumentException.class, () -> Rlp.encodeInteger(BigInteger.valueOf(-1)));
    }

    @Test
    void encodesLists() {
        // cast to-rlp '["0x636174","0x646f67"]'
        byte[] catDog = Rlp.encodeList(List.of(Rlp.encodeString(ascii("cat")), Rlp.encodeString(ascii("dog"))));
        assertEquals("0xc88363617483646f67", hex(catDog));
        // cast to-rlp '[]'
        assertEquals("0xc0", hex(Rlp.encodeList(List.of())));
    }

    @Test
    void encodesNestedLists() {
        // The set theoretical representation of three, cast to-rlp '[[],[[]],[[],[[]]]]'
        byte[] empty = Rlp.encodeList(List.of());
        byte[] one = Rlp.encodeList(List.of(empty));
        byte[] two = Rlp.encodeList(List.of(empty, one));

        assertEquals("0xc7c0c1c0c3c0c1c0", hex(Rlp.encodeList(List.of(empty, one, two))));
    }

    @Test
    void encodesLongListsWithLengthOfLength() {
        byte[] item = Rlp.encodeString(new byte[60]);

        byte[] encoded = Rlp.encodeList(List.of(item));

        // cast to-rlp '["0x00...00" (60 bytes)]' starts with 0xf83eb83c: a 62-byte payload
        assertEquals("0xf83e", hex(Arrays.copyOf(encoded, 2)));
        assertArrayEquals(item, Arrays.copyOfRange(encoded, 2, encoded.length));
    }

    @Test
    void copiesSingleByteStringsInsteadOfAliasingThem() {
        byte[] input = {0x01};

        byte[] encoded = Rlp.encodeString(input);
        input[0] = 0x02;

        assertEquals(0x01, encoded[0]);
    }

    private static byte[] ascii(String text) {
        return text.getBytes(StandardCharsets.US_ASCII);
    }

    private static String hex(byte[] bytes) {
        return Hex.encode(bytes);
    }
}
