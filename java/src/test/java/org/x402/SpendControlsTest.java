package org.x402;

import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SpendControlsTest {

    private static final String BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

    @Test
    void defaultsAllowOnlyDefaultAssetsUpToOneDollar() {
        SpendControls defaults = SpendControls.defaults();

        assertTrue(defaults.isEnabled());
        assertEquals(Optional.of(new BigDecimal("1")), defaults.maxAmountPerPayment());
        assertFalse(defaults.allowsAnyAsset());
        assertTrue(defaults.allowedAssets().isEmpty());
        assertEquals("$1", SpendControls.DEFAULT_MAX_AMOUNT_PER_PAYMENT);
        assertEquals(defaults.toString(), SpendControls.builder().build().toString());
    }

    @Test
    void disabledControlsEnforceNothing() {
        SpendControls disabled = SpendControls.disabled();

        assertFalse(disabled.isEnabled());
        assertTrue(disabled.maxAmountPerPayment().isEmpty());
        assertTrue(disabled.allowsAnyAsset());
        assertEquals("SpendControls[disabled]", disabled.toString());
    }

    @Test
    void parsesUsdCapsWithOrWithoutDollarSign() {
        assertEquals(new BigDecimal("0.50"), cap("$0.50"));
        assertEquals(new BigDecimal("2"), cap("2"));
        assertEquals(new BigDecimal("1.5"), cap("$ 1.5"));
        assertEquals(new BigDecimal("0"), cap("$0"));
    }

    @Test
    void rejectsMalformedUsdCaps() {
        for (String value : List.of("", "$", "-1", "$-1", "1e3", "1.5 USDC", "1.", ".5", "abc", "1,000")) {
            assertThrows(IllegalArgumentException.class,
                    () -> SpendControls.builder().maxAmountPerPayment(value), value);
        }
    }

    @Test
    void acceptsBigDecimalCapsButNotNegativeOnes() {
        SpendControls controls = SpendControls.builder().maxAmountPerPayment(new BigDecimal("0.25")).build();

        assertEquals(Optional.of(new BigDecimal("0.25")), controls.maxAmountPerPayment());
        assertThrows(IllegalArgumentException.class,
                () -> SpendControls.builder().maxAmountPerPayment(new BigDecimal("-0.01")));
    }

    @Test
    void noMaxAmountPerPaymentRemovesTheUsdCap() {
        SpendControls controls = SpendControls.builder().noMaxAmountPerPayment().build();

        assertTrue(controls.isEnabled());
        assertTrue(controls.maxAmountPerPayment().isEmpty());
        assertTrue(controls.toString().contains("maxAmountPerPayment=none"), controls.toString());
    }

    @Test
    void recordsAllowedAssetsInOrder() {
        SpendControls controls = SpendControls.builder()
                .allowAsset("eip155:*", "0xCustomToken")
                .allowAsset("eip155:8453", BASE_USDC, BigInteger.valueOf(500_000))
                .build();

        assertEquals(List.of(
                new SpendControls.AllowedAsset("eip155:*", "0xCustomToken", null),
                new SpendControls.AllowedAsset("eip155:8453", BASE_USDC, BigInteger.valueOf(500_000))),
                controls.allowedAssets());
        assertNull(controls.allowedAssets().get(0).maxAmountPerPayment());
        assertThrows(UnsupportedOperationException.class, () -> controls.allowedAssets().clear());
        assertTrue(controls.toString().contains("0xCustomToken"), controls.toString());
    }

    @Test
    void builtControlsAreNotAffectedByLaterBuilderChanges() {
        SpendControls.Builder builder = SpendControls.builder().allowAsset("eip155:1", "0xA");
        SpendControls first = builder.build();

        builder.allowAsset("eip155:1", "0xB").maxAmountPerPayment("$9");

        assertEquals(1, first.allowedAssets().size());
        assertEquals(Optional.of(new BigDecimal("1")), first.maxAmountPerPayment());
    }

    @Test
    void rejectsInvalidAllowedAssets() {
        SpendControls.Builder builder = SpendControls.builder();

        assertThrows(IllegalArgumentException.class, () -> builder.allowAsset("base", "0xA"));
        assertThrows(IllegalArgumentException.class, () -> builder.allowAsset("eip155:1", " "));
        assertThrows(IllegalArgumentException.class,
                () -> builder.allowAsset("eip155:1", "0xA", BigInteger.valueOf(-1)));
    }

    @Test
    void allowAnyAssetCannotBeCombinedWithAllowedAssets() {
        SpendControls.Builder builder = SpendControls.builder().allowAnyAsset().allowAsset("eip155:1", "0xA");

        assertThrows(IllegalStateException.class, builder::build);
        assertTrue(SpendControls.builder().allowAnyAsset().build().allowsAnyAsset());
    }

    @Test
    void sharedInstancesAreReused() {
        assertSame(SpendControls.defaults(), SpendControls.defaults());
        assertSame(SpendControls.disabled(), SpendControls.disabled());
    }

    private static BigDecimal cap(String value) {
        return SpendControls.builder().maxAmountPerPayment(value).build().maxAmountPerPayment().orElseThrow();
    }
}
