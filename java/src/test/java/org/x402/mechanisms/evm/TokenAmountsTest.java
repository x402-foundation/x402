package org.x402.mechanisms.evm;

import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TokenAmountsTest {

    /** Fixtures of Go's {@code TestConvertToTokenAmount} ({@code go/utils_test.go}). */
    @Test
    void convertsGoFixtures() {
        assertAtomic("1000000", "1.0000005", 6);
        assertAtomic("0", "0.0000005", 6);
        assertAtomic("0", "0.0000009", 6);
        assertAtomic("0", "0", 6);
        assertAtomic("0", "0.00", 6);
        assertAtomic("8975978289462729000000", "8975.978289462729", 18);
        assertAtomic("8975978289", "8975.978289462729", 6);
    }

    @Test
    void rejectsGoInvalidFixtures() {
        IllegalArgumentException scientific = assertThrows(IllegalArgumentException.class,
                () -> TokenAmounts.toAtomic("1e6", 6));
        assertTrue(scientific.getMessage().contains("not scientific notation"), scientific.getMessage());
        assertThrows(IllegalArgumentException.class, () -> TokenAmounts.toAtomic("not-a-number", 6));
    }

    @Test
    void truncatesInsteadOfRounding() {
        assertAtomic("10000", "0.01", 6);
        assertAtomic("1", "1.999", 0);
        assertAtomic("999999", "0.9999999", 6);
    }

    @Test
    void acceptsTrailingDot() {
        assertAtomic("1000000", "1.", 6);
    }

    @Test
    void rejectsSignsWhitespaceAndOtherNotations() {
        for (String invalid : List.of("-1", "+1", ".5", " 1", "1 ", "1E6", "0x10", "1,5", "")) {
            assertThrows(IllegalArgumentException.class, () -> TokenAmounts.toAtomic(invalid, 6), invalid);
        }
    }

    @Test
    void convertsBigDecimals() {
        assertEquals(BigInteger.valueOf(1_500_000), TokenAmounts.toAtomic(new BigDecimal("1.5"), 6));
        assertEquals(BigInteger.valueOf(1_000_000), TokenAmounts.toAtomic(BigDecimal.ONE, 6));
        assertEquals(new BigInteger("10000000"), TokenAmounts.toAtomic(new BigDecimal("1E+1"), 6));
    }

    @Test
    void rejectsNegativeBigDecimals() {
        assertThrows(IllegalArgumentException.class, () -> TokenAmounts.toAtomic(new BigDecimal("-0.01"), 6));
    }

    @Test
    void validatesDecimalsRange() {
        assertEquals(BigInteger.ONE, TokenAmounts.toAtomic("1", 0));
        assertEquals(BigInteger.ONE, TokenAmounts.toAtomic("0." + "0".repeat(254) + "1", TokenAmounts.MAX_DECIMALS));
        assertThrows(IllegalArgumentException.class, () -> TokenAmounts.toAtomic("1", -1));
        assertThrows(IllegalArgumentException.class, () -> TokenAmounts.toAtomic("1", 256));
    }

    @Test
    void capsResultAtUint256() {
        assertEquals(Uint256.MAX_VALUE, TokenAmounts.toAtomic(Uint256.MAX_VALUE.toString(), 0));
        assertThrows(IllegalArgumentException.class,
                () -> TokenAmounts.toAtomic(Uint256.MAX_VALUE.add(BigInteger.ONE).toString(), 0));
        assertThrows(IllegalArgumentException.class, () -> TokenAmounts.toAtomic("1", 78));
    }

    @Test
    void convertsZeroAtAnyDecimals() {
        assertAtomic("0", "0", 78);
        assertAtomic("0", "0.000", TokenAmounts.MAX_DECIMALS);
        assertEquals(BigInteger.ZERO, TokenAmounts.toAtomic(new BigDecimal("0E+80"), 6));
    }

    @Test
    void rejectsHugeExponentsWithoutExpandingThem() {
        assertThrows(IllegalArgumentException.class, () -> TokenAmounts.toAtomic(new BigDecimal("1E+999999999"), 6));
    }

    private static void assertAtomic(String expected, String amount, int decimals) {
        assertEquals(new BigInteger(expected), TokenAmounts.toAtomic(amount, decimals), amount + "@" + decimals);
    }
}
