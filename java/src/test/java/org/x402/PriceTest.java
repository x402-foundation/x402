package org.x402;

import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class PriceTest {

    @Test
    void keepsExactDigits() {
        Price.Money money = Price.money("8975.978289462729");

        assertEquals("8975.978289462729", money.amount().toPlainString());
        assertEquals("", money.symbol());
    }

    @Test
    void parsesTickerAndDollarPrefix() {
        assertEquals(new Price.Money(new BigDecimal("1.50"), "USDT"), Price.money("1.50 USDT"));
        assertEquals(new Price.Money(new BigDecimal("1.50"), ""), Price.money("1.50 USD"));
        assertEquals(new Price.Money(new BigDecimal("1.50"), ""), Price.money("$1.50"));
    }

    @Test
    void parsesPlainAmounts() {
        assertEquals("1.0000005", Price.money("1.0000005").amount().toPlainString());
        assertEquals("0.0000005", Price.money("0.0000005").amount().toPlainString());
        assertEquals("0.0000009", Price.money("0.0000009").amount().toPlainString());
        assertEquals("0", Price.money("0").amount().toPlainString());
        assertEquals("0.00", Price.money("0.00").amount().toPlainString());
        assertEquals("1.50", Price.money("$1.50").amount().toPlainString());
        assertEquals("0", Price.money("$0").amount().toPlainString());
    }

    @Test
    void normalizesSymbolsToUpperCase() {
        assertEquals("USDC", Price.money("1.5 usdc").symbol());
        assertEquals("USDC.E", Price.money("1.5 USDC.e").symbol());
        assertEquals("", Price.money("1.5 usd").symbol());
    }

    @Test
    void toleratesSurroundingAndInnerWhitespace() {
        assertEquals(new Price.Money(new BigDecimal("0.001"), ""), Price.money("  $ 0.001  "));
        assertEquals(new Price.Money(new BigDecimal("2"), "USDT0"), Price.money("2\tUSDT0"));
    }

    @Test
    void rejectsInvalidExpressionsWhenCreated() {
        for (String invalid : List.of("-1", "-1.5", "nope", "1.50USDT", "1e6", "$-1", ".5", "1.", "1. 5",
                "1.5 1USD", "USD 1.5", "1,5", "1,000", "$$1", "$", "$0.0O1", "")) {
            IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                    () -> Price.money(invalid), invalid);
            assertEquals("Invalid money format: " + invalid, e.getMessage());
        }
    }

    @Test
    void comparesAmountsIncludingScale() {
        assertNotEquals(Price.money("1.5"), Price.money("1.50"));
        assertEquals(0, Price.money("1.5").amount().compareTo(Price.money("1.50").amount()));
    }

    @Test
    void normalizesSymbolsOnConstruction() {
        assertEquals(Price.money("1.5 USDC"), new Price.Money(new BigDecimal("1.5"), "usdc"));
        assertEquals(Price.money("1.5"), new Price.Money(new BigDecimal("1.5"), "usd"));
    }

    @Test
    void rejectsNegativeAmountsOnConstruction() {
        assertThrows(IllegalArgumentException.class, () -> new Price.Money(new BigDecimal("-0.01"), ""));
    }
}
