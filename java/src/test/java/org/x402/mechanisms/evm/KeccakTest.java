package org.x402.mechanisms.evm;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;

class KeccakTest {

    @Test
    void hashesEmptyInput() {
        // cast keccak ''
        assertEquals("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
                Hex.encode(Keccak.keccak256(new byte[0])));
        assertEquals("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
                Hex.encode(Keccak.keccak256()));
    }

    @Test
    void hashesUtf8Text() {
        // cast keccak abc
        assertEquals("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
                Hex.encode(Keccak.keccak256("abc".getBytes(StandardCharsets.UTF_8))));
    }

    @Test
    void hashesRawBytes() {
        // cast keccak 0xdeadbeef
        assertEquals("0xd4fd4e189132273036449fc9e11198c739161b4c0116a9a2dccdfa1c492006f1",
                Hex.encode(Keccak.keccak256(Hex.decode("0xdeadbeef"))));
    }

    @Test
    void hashesTheConcatenationOfParts() {
        byte[] joined = Keccak.keccak256("abc".getBytes(StandardCharsets.UTF_8));
        byte[] parts = Keccak.keccak256(
                "a".getBytes(StandardCharsets.UTF_8), new byte[0], "bc".getBytes(StandardCharsets.UTF_8));

        assertArrayEquals(joined, parts);
    }
}
