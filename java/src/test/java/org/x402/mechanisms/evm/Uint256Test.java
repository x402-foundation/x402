package org.x402.mechanisms.evm;

import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.util.Arrays;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class Uint256Test {

    private static final String MAX_DECIMAL =
            "115792089237316195423570985008687907853269984665640564039457584007913129639935";

    @Test
    void maxValueIsTwoToThe256MinusOne() {
        assertEquals(new BigInteger(MAX_DECIMAL), Uint256.MAX_VALUE);
    }

    @Test
    void parsesBase10Strings() {
        assertEquals(BigInteger.ZERO, Uint256.parse("0"));
        assertEquals(BigInteger.valueOf(1000), Uint256.parse("1000"));
        assertEquals(BigInteger.valueOf(7), Uint256.parse("007"));
        assertEquals(Uint256.MAX_VALUE, Uint256.parse(MAX_DECIMAL));
        assertEquals(BigInteger.ONE, Uint256.parse("0".repeat(200) + "1"));
    }

    @Test
    void rejectsValuesAboveUint256() {
        String maxPlusOne = Uint256.MAX_VALUE.add(BigInteger.ONE).toString();

        assertThrows(IllegalArgumentException.class, () -> Uint256.parse(maxPlusOne));
        assertThrows(IllegalArgumentException.class, () -> Uint256.parse("9".repeat(79)));
    }

    @Test
    void rejectsAnythingButAsciiDigits() {
        for (String invalid : new String[] {"", "-1", "+1", "1.0", "1e6", "0x10", " 1", "1 ", "1_000", "١"}) {
            assertThrows(IllegalArgumentException.class, () -> Uint256.parse(invalid), invalid);
        }
    }

    @Test
    void encodesAsLeftPaddedBigEndianWord() {
        byte[] one = new byte[32];
        one[31] = 1;
        byte[] highBit = new byte[32];
        highBit[0] = (byte) 0x80;
        byte[] max = new byte[32];
        Arrays.fill(max, (byte) 0xff);

        assertArrayEquals(new byte[32], Uint256.toBytes(BigInteger.ZERO));
        assertArrayEquals(one, Uint256.toBytes(BigInteger.ONE));
        // BigInteger.toByteArray() adds a sign byte here, which must not shift the word
        assertArrayEquals(highBit, Uint256.toBytes(BigInteger.ONE.shiftLeft(255)));
        assertArrayEquals(max, Uint256.toBytes(Uint256.MAX_VALUE));
    }

    @Test
    void rejectsOutOfRangeValuesOnEncode() {
        assertThrows(IllegalArgumentException.class, () -> Uint256.toBytes(BigInteger.valueOf(-1)));
        assertThrows(IllegalArgumentException.class, () -> Uint256.toBytes(Uint256.MAX_VALUE.add(BigInteger.ONE)));
    }
}
