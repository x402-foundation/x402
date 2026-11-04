package org.x402.mechanisms.evm.exact;

import org.junit.jupiter.api.Test;
import org.x402.AssetAmount;
import org.x402.Price;
import org.x402.types.PaymentRequirements;
import org.x402.types.SupportedKind;
import org.x402.util.Json;

import java.io.IOException;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_USDC;
import static org.x402.mechanisms.evm.CastVectors.BASE_USDC;

class ExactEvmServerSchemeTest {

    private static final String BASE_SEPOLIA = "eip155:84532";
    private static final String BASE = "eip155:8453";
    private static final String CELO = "eip155:42220";
    private static final String MEGAETH = "eip155:4326";
    private static final String MEGA_USD = "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7";
    /** An address outside the default-asset table. */
    private static final String CUSTOM_TOKEN = "0x0000000000000000000000000000000000000001";
    private static final Map<String, Object> BASE_SEPOLIA_DOMAIN = domain("USDC", "2");

    private final ExactEvmServerScheme server = new ExactEvmServerScheme();

    @Test
    void parsesADollarPriceIntoBaseSepoliaUsdc() {
        AssetAmount amount = server.parsePrice(Price.money("$0.001"), BASE_SEPOLIA);

        assertEquals(new AssetAmount("1000", BASE_SEPOLIA_USDC, BASE_SEPOLIA_DOMAIN), amount);
        assertEquals(List.of("name", "version"), List.copyOf(amount.extra().keySet()));
    }

    @Test
    void convertsMoneyLikeTheReferenceSdks() {
        // Expected values from TS exact/server tests (Base Sepolia) and Go exact/server tests (Base)
        Map<String, String> baseSepolia = Map.of(
                "$0.10", "100000", "0.10", "100000", "100.50", "100500000", "1", "1000000", "$4.02", "4020000");
        Map<String, String> base = Map.of(
                "1.00", "1000000", "10", "10000000", "1.5", "1500000", "8975.978289462729", "8975978289",
                "0.0000005", "0");

        baseSepolia.forEach((price, atomic) -> assertEquals(new AssetAmount(atomic, BASE_SEPOLIA_USDC,
                BASE_SEPOLIA_DOMAIN), server.parsePrice(Price.money(price), BASE_SEPOLIA), price));
        base.forEach((price, atomic) -> assertEquals(new AssetAmount(atomic, BASE_USDC, domain("USD Coin", "2")),
                server.parsePrice(Price.money(price), BASE), price));
    }

    @Test
    void selectsDefaultAssetsBySymbol() {
        assertEquals(new AssetAmount("10000", "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", domain("Tether USD", "1")),
                server.parsePrice(Price.money("0.01 USDT"), CELO));
        assertEquals(new AssetAmount("1500000", "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771",
                domain("Tether America USD", "1")), server.parsePrice(Price.money("1.5 usat"), CELO));
        assertEquals(new AssetAmount("2000000", "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", domain("USDC", "2")),
                server.parsePrice(Price.money("2 USD"), CELO));
        assertEquals(new AssetAmount("1000000", "0x9cb8142aEBBcdc60AF7c97Af897A67A8f3CA71C2", domain("USDC.e", "2")),
                server.parsePrice(Price.money("1 USDC.e"), "eip155:36900"));
    }

    @Test
    void reportsMissingDefaultAssets() {
        IllegalArgumentException symbol = assertThrows(IllegalArgumentException.class,
                () -> server.parsePrice(Price.money("1 USDT"), BASE));
        IllegalArgumentException network = assertThrows(IllegalArgumentException.class,
                () -> server.parsePrice(Price.money("1.00"), "eip155:999999"));

        assertEquals("no USDT default asset configured for network eip155:8453", symbol.getMessage());
        assertEquals("no default asset configured for network eip155:999999", network.getMessage());
    }

    @Test
    void refusesPermit2DefaultAssets() {
        // MegaETH, Mezo, Mezo testnet, Radius, Radius testnet, Igra
        for (String network : List.of(MEGAETH, "eip155:31612", "eip155:31611", "eip155:723487", "eip155:72344",
                "eip155:38833")) {
            IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                    () -> server.parsePrice(Price.money("$1"), network));

            assertTrue(e.getMessage().contains("permit2") && e.getMessage().contains("EIP-3009"), e.getMessage());
        }
    }

    @Test
    void rejectsMoneyBeyondUint256() {
        Price huge = Price.money("1" + "0".repeat(80));

        assertThrows(IllegalArgumentException.class, () -> server.parsePrice(huge, BASE_SEPOLIA));
    }

    @Test
    void passesAssetAmountsThrough() {
        AssetAmount custom = new AssetAmount("123456", CUSTOM_TOKEN, Map.of("foo", "bar"));
        AssetAmount withoutExtra = AssetAmount.of("1", BASE_SEPOLIA_USDC);

        assertSame(custom, server.parsePrice(custom, BASE_SEPOLIA));
        assertSame(withoutExtra, server.parsePrice(withoutExtra, "eip155:999999"));
    }

    @Test
    void requiresAnAssetOnAssetAmounts() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> server.parsePrice(AssetAmount.of("1000", ""), BASE_SEPOLIA));

        assertTrue(e.getMessage().startsWith(ExactEvmErrors.SERVER_ASSET_ADDRESS_REQUIRED + ": "), e.getMessage());
    }

    @Test
    void fillsAMissingAssetAndItsDomain() {
        for (String asset : Arrays.asList(null, "")) {
            PaymentRequirements enhanced = server.enhancePaymentRequirements(requirements(asset, "1000", null), null);

            assertEquals(requirements(BASE_SEPOLIA_USDC, "1000", BASE_SEPOLIA_DOMAIN), enhanced);
        }
    }

    @Test
    void addsNameAndVersionOnlyWhereUnset() {
        Map<String, Object> nullName = new HashMap<>();
        nullName.put("name", null);

        assertEquals(domain("Custom", "2"), enhancedExtra(Map.of("name", "Custom")));
        assertEquals(domain("USDC", "9"), enhancedExtra(Map.of("version", "9")));
        assertEquals(domain("Custom", "9"), enhancedExtra(domain("Custom", "9")));
        assertEquals(BASE_SEPOLIA_DOMAIN, enhancedExtra(nullName));
    }

    @Test
    void keepsOtherMembersOfTheRequirements() {
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("foo", List.of(1, 2));
        extra.put("assetTransferMethod", "eip3009");
        PaymentRequirements requirements = new PaymentRequirements(
                "exact", BASE_SEPOLIA, BASE_SEPOLIA_USDC.toLowerCase(Locale.ROOT), "1000", ANVIL_ADDRESS_1, 42, extra);

        PaymentRequirements enhanced = server.enhancePaymentRequirements(requirements, null);

        assertEquals(List.of("foo", "assetTransferMethod", "name", "version"), List.copyOf(enhanced.extra().keySet()));
        assertEquals(new PaymentRequirements("exact", BASE_SEPOLIA, BASE_SEPOLIA_USDC.toLowerCase(Locale.ROOT),
                "1000", ANVIL_ADDRESS_1, 42, enhanced.extra()), enhanced);
        assertEquals(List.of(1, 2), enhanced.extra().get("foo"));
    }

    @Test
    void ignoresTheSupportedKind() {
        SupportedKind kind = new SupportedKind(2, "exact", BASE_SEPOLIA, Map.of("feePayer", "0xabc"));

        PaymentRequirements enhanced = server.enhancePaymentRequirements(requirements(null, "1000", null), kind);

        assertEquals(BASE_SEPOLIA_DOMAIN, enhanced.extra());
    }

    @Test
    void convertsDecimalAmountsAtTheDefaultAssetDecimals() {
        // Extra precision is truncated
        Map<String, String> cases = Map.of("0.5", "500000", "0.0000019", "1", "1.", "1000000", "2.25", "2250000");

        cases.forEach((decimal, atomic) -> assertEquals(atomic,
                server.enhancePaymentRequirements(requirements(BASE_SEPOLIA_USDC, decimal, null), null).amount(),
                decimal));
    }

    @Test
    void keepsIntegerAmountsVerbatim() {
        assertEquals("0001000",
                server.enhancePaymentRequirements(requirements(BASE_SEPOLIA_USDC, "0001000", null), null).amount());
    }

    @Test
    void rejectsMalformedAmounts() {
        for (String amount : Arrays.asList("abc", "1.2.3", "-1", ".5", "1e6", "0x10", "", null)) {
            IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                    () -> server.enhancePaymentRequirements(requirements(BASE_SEPOLIA_USDC, amount, null), null));

            assertTrue(e.getMessage().startsWith(ExactEvmErrors.SERVER_FAILED_TO_PARSE_AMOUNT + ": "),
                    amount + ": " + e.getMessage());
        }
    }

    @Test
    void acceptsCustomTokensWithACompleteDomain() {
        PaymentRequirements requirements = requirements(CUSTOM_TOKEN, "1000", domain("My Token", "1"));

        assertSame(requirements, server.enhancePaymentRequirements(requirements, null));
    }

    @Test
    void rejectsCustomTokensWithoutADomain() {
        List<Map<String, Object>> incomplete = Arrays.asList(null, Map.of("name", "My Token"), Map.of("version", "1"),
                domain("", "1"), Map.of("name", 1, "version", "1"));

        for (Map<String, Object> extra : incomplete) {
            IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                    () -> server.enhancePaymentRequirements(requirements(CUSTOM_TOKEN, "1000", extra), null));

            assertTrue(e.getMessage().startsWith(ExactEvmErrors.MISSING_EIP712_DOMAIN + ": "), e.getMessage());
        }
    }

    @Test
    void rejectsCustomTokenAmountsThatAreNotAtomic() {
        // A decimal amount cannot be converted: the token's decimals are unknown
        for (String amount : Arrays.asList("1.5", "abc", null)) {
            PaymentRequirements requirements = requirements(CUSTOM_TOKEN, amount, domain("My Token", "1"));

            IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                    () -> server.enhancePaymentRequirements(requirements, null));

            assertTrue(e.getMessage().startsWith(ExactEvmErrors.SERVER_FAILED_TO_PARSE_AMOUNT + ": "),
                    amount + ": " + e.getMessage());
        }
    }

    @Test
    void rejectsAssetsThatAreNotAddresses() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> server.enhancePaymentRequirements(requirements("USDC", "1000", null), null));

        assertEquals("requirements.asset is not an EVM address: USDC", e.getMessage());
    }

    @Test
    void reportsNetworksWithoutADefaultAsset() {
        PaymentRequirements requirements =
                new PaymentRequirements("exact", "eip155:999999", null, "1000", ANVIL_ADDRESS_1, 300, null);

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> server.enhancePaymentRequirements(requirements, null));

        assertEquals(ExactEvmErrors.SERVER_NO_ASSET_SPECIFIED + ": no default asset configured for network "
                + "eip155:999999", e.getMessage());
    }

    @Test
    void refusesPermit2AssetsAndTransferMethods() {
        List<PaymentRequirements> permit2 = List.of(
                new PaymentRequirements("exact", MEGAETH, MEGA_USD, "1", ANVIL_ADDRESS_1, 300, null),
                new PaymentRequirements("exact", MEGAETH, null, "1", ANVIL_ADDRESS_1, 300, null),
                requirements(BASE_SEPOLIA_USDC, "1000", Map.of("assetTransferMethod", "permit2")),
                requirements(CUSTOM_TOKEN, "1000", Map.of("assetTransferMethod", "permit2", "name", "T", "version",
                        "1")));

        for (PaymentRequirements requirements : permit2) {
            IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                    () -> server.enhancePaymentRequirements(requirements, null));

            assertTrue(e.getMessage().contains("permit2") && e.getMessage().contains("EIP-3009"), e.getMessage());
        }
    }

    @Test
    void buildsTheWireRequirementsOfGo() throws IOException {
        AssetAmount price = server.parsePrice(Price.money("$0.001"), BASE_SEPOLIA);

        PaymentRequirements requirements = server.enhancePaymentRequirements(new PaymentRequirements(
                "exact", BASE_SEPOLIA, price.asset(), price.amount(), ANVIL_ADDRESS_1, 300, price.extra()), null);

        assertEquals(Json.readTree("{\"scheme\":\"exact\",\"network\":\"eip155:84532\","
                + "\"asset\":\"0x036CbD53842c5426634e7929541eC2318f3dCF7e\",\"amount\":\"1000\","
                + "\"payTo\":\"" + ANVIL_ADDRESS_1 + "\",\"maxTimeoutSeconds\":300,"
                + "\"extra\":{\"name\":\"USDC\",\"version\":\"2\"}}"), Json.toTree(requirements));
    }

    @Test
    void identifiesAsTheExactScheme() {
        assertEquals("exact", server.scheme());
    }

    @Test
    void requiresTheRequirementsNetwork() {
        PaymentRequirements noNetwork = new PaymentRequirements("exact", null, null, "1", ANVIL_ADDRESS_1, 300, null);

        assertThrows(NullPointerException.class, () -> server.enhancePaymentRequirements(noNetwork, null));
    }

    private Map<String, Object> enhancedExtra(Map<String, Object> extra) {
        return server.enhancePaymentRequirements(requirements(BASE_SEPOLIA_USDC, "1000", extra), null).extra();
    }

    private static PaymentRequirements requirements(String asset, String amount, Map<String, Object> extra) {
        return new PaymentRequirements("exact", BASE_SEPOLIA, asset, amount, ANVIL_ADDRESS_1, 300, extra);
    }

    private static Map<String, Object> domain(String name, String version) {
        Map<String, Object> domain = new LinkedHashMap<>();
        domain.put("name", name);
        domain.put("version", version);
        return domain;
    }
}
