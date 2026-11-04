package org.x402;

import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequired;
import org.x402.types.PaymentRequirements;
import org.x402.types.ResourceInfo;
import org.x402.util.Json;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.OptionalInt;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class X402ClientTest {

    // Base mainnet USDC and Mezo testnet mUSD, from go/mechanisms/evm/default_assets.go.
    private static final String BASE = "eip155:8453";
    private static final String BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    private static final String MEZO_TESTNET = "eip155:31611";
    private static final String MEZO_TESTNET_MUSD = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
    private static final String CUSTOM_TOKEN = "0xCustomToken";
    private static final String PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
    private static final ResourceInfo RESOURCE = ResourceInfo.of(
            "https://api.example.com/premium-data", "Access to premium market data", "application/json");

    private final FakeSchemeNetworkClient exact = new FakeSchemeNetworkClient("exact").withDefaultAsset(BASE_USDC, 6);

    // ---------------------------------------------------------------- builder

    @Test
    void buildRequiresAtLeastOneScheme() {
        assertThrows(IllegalStateException.class, () -> X402Client.builder().build());
    }

    @Test
    void registerRejectsNetworksThatAreNeitherCaip2NorWildcards() {
        for (String network : List.of("base-sepolia", "eip155", "EIP155:1", "eip155:**", "*:*", "eip155:*:1")) {
            assertThrows(IllegalArgumentException.class, () -> X402Client.builder().register(network, exact),
                    network);
        }
    }

    @Test
    void registerRejectsMissingOrBlankSchemes() {
        assertThrows(IllegalArgumentException.class,
                () -> X402Client.builder().register(BASE, new FakeSchemeNetworkClient(" ")));
        assertThrows(IllegalArgumentException.class,
                () -> X402Client.builder().register(BASE, new FakeSchemeNetworkClient(null)));
    }

    // ---------------------------------------------------------------- PaymentRequired validation

    @Test
    void rejectsPaymentRequiredOfAnotherProtocolVersion() {
        PaymentRequired v1 = new PaymentRequired(1, null, RESOURCE, List.of(option(BASE, BASE_USDC, "1000")), null);

        PaymentException e = paymentFailure(() -> clientFor(BASE).selectPaymentRequirements(v1));

        assertEquals(PaymentException.INVALID_PAYMENT_REQUIRED, e.reason());
        assertTrue(e.getMessage().contains("x402Version is 1"), e.getMessage());
    }

    @Test
    void rejectsPaymentRequiredWithoutAccepts() {
        PaymentRequired missing = new PaymentRequired(2, null, RESOURCE, null, null);

        PaymentException e = paymentFailure(() -> clientFor(BASE).selectPaymentRequirements(missing));

        assertEquals(PaymentException.INVALID_PAYMENT_REQUIRED, e.reason());
    }

    @Test
    void rejectsNullAcceptsEntry() {
        PaymentRequired withNull = new PaymentRequired(2, null, RESOURCE, Arrays.asList(
                option(BASE, BASE_USDC, "1000"), null), null);

        PaymentException e = paymentFailure(() -> clientFor(BASE).selectPaymentRequirements(withNull));

        assertEquals(PaymentException.INVALID_PAYMENT_REQUIRED, e.reason());
        assertEquals("accepts[1] is null", e.getMessage());
    }

    @Test
    void rejectsAcceptsEntriesMissingARequiredField() {
        X402Client client = clientFor(BASE);
        List<PaymentRequirements> broken = List.of(
                new PaymentRequirements(null, BASE, BASE_USDC, "1", PAY_TO, 60, null),
                new PaymentRequirements("exact", null, BASE_USDC, "1", PAY_TO, 60, null),
                new PaymentRequirements("exact", BASE, null, "1", PAY_TO, 60, null),
                new PaymentRequirements("exact", BASE, BASE_USDC, null, PAY_TO, 60, null),
                new PaymentRequirements("exact", BASE, BASE_USDC, "1", null, 60, null));
        List<String> fields = List.of("scheme", "network", "asset", "amount", "payTo");

        for (int i = 0; i < broken.size(); i++) {
            PaymentRequired offer = offer(broken.get(i));
            PaymentException e = paymentFailure(() -> client.selectPaymentRequirements(offer));
            assertEquals(PaymentException.INVALID_PAYMENT_REQUIRED, e.reason());
            assertEquals("accepts[0]." + fields.get(i) + " is missing", e.getMessage());
        }
    }

    @Test
    void rejectsNetworksThatAreNotCaip2() {
        PaymentRequired legacyName = offer(option("base-sepolia", BASE_USDC, "1000"));

        PaymentException e = paymentFailure(() -> clientFor("eip155:*").selectPaymentRequirements(legacyName));

        assertEquals(PaymentException.INVALID_PAYMENT_REQUIRED, e.reason());
        assertTrue(e.getMessage().contains("base-sepolia"), e.getMessage());
    }

    // ---------------------------------------------------------------- scheme and network filtering

    @Test
    void selectsTheFirstPayableOptionInServerOrder() {
        PaymentRequirements first = option(BASE, BASE_USDC, "1000");
        PaymentRequirements second = option(BASE, BASE_USDC, "2000");

        assertSame(first, clientFor(BASE).selectPaymentRequirements(offer(first, second)));
    }

    @Test
    void skipsOptionsTheRegisteredSchemeCannotPay() {
        PaymentRequirements unpayable = option(BASE, BASE_USDC, "1000");
        PaymentRequirements payable = option(BASE, BASE_USDC, "2000");
        X402Client client = X402Client.builder().register(BASE, exact.rejectingAmount("1000")).build();

        assertSame(payable, client.selectPaymentRequirements(offer(unpayable, payable)));
        PaymentException e = assertThrows(PaymentException.class,
                () -> client.selectPaymentRequirements(offer(unpayable)));
        assertEquals(PaymentException.UNSUPPORTED_SCHEME, e.reason());
    }

    @Test
    void optionsWithoutExtraArePayable() {
        PaymentRequirements bare = new PaymentRequirements("exact", BASE, BASE_USDC, "1000", PAY_TO, 60, null);

        assertSame(bare, clientFor(BASE).selectPaymentRequirements(offer(bare)));
    }

    @Test
    void skipsOptionsWithoutARegisteredScheme() {
        PaymentRequirements solana = option("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "EPjFWdd5", "1000");
        PaymentRequirements upto = new PaymentRequirements("upto", BASE, BASE_USDC, "1000", PAY_TO, 60, null);
        PaymentRequirements payable = option(BASE, BASE_USDC, "1000");

        assertSame(payable, clientFor(BASE).selectPaymentRequirements(offer(solana, upto, payable)));
    }

    @Test
    void failsWithUnsupportedSchemeWhenNothingIsPayable() {
        PaymentRequirements solana = option("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "EPjFWdd5", "1000");

        PaymentException e = paymentFailure(() -> clientFor(BASE).selectPaymentRequirements(offer(solana)));

        assertEquals(PaymentException.UNSUPPORTED_SCHEME, e.reason());
        assertEquals("no supported payment schemes available", e.getMessage());
        PaymentException empty = paymentFailure(() -> clientFor(BASE).selectPaymentRequirements(offer()));
        assertEquals(PaymentException.UNSUPPORTED_SCHEME, empty.reason());
    }

    @Test
    void wildcardRegistrationCoversEveryNetworkOfItsNamespace() {
        X402Client client = clientFor("eip155:*");
        PaymentRequirements base = option(BASE, BASE_USDC, "1000");

        assertSame(base, client.selectPaymentRequirements(offer(base)));
        PaymentException e = paymentFailure(() -> client.selectPaymentRequirements(
                offer(option("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", BASE_USDC, "1000"))));
        assertEquals(PaymentException.UNSUPPORTED_SCHEME, e.reason());
    }

    @Test
    void exactRegistrationTakesPrecedenceOverWildcard() {
        FakeSchemeNetworkClient wildcard = new FakeSchemeNetworkClient("exact").withDefaultAsset(BASE_USDC, 6);
        FakeSchemeNetworkClient specific = new FakeSchemeNetworkClient("exact").withDefaultAsset(BASE_USDC, 6);
        X402Client client = X402Client.builder().register("eip155:*", wildcard).register(BASE, specific).build();
        PaymentRequired offer = offer(option(BASE, BASE_USDC, "1000"));

        client.createPaymentPayload(offer, client.selectPaymentRequirements(offer));

        assertEquals(1, specific.paid().size());
        assertTrue(wildcard.paid().isEmpty());
    }

    @Test
    void wildcardSchemeIsFoundWhenTheExactNetworkRegistersAnotherScheme() {
        FakeSchemeNetworkClient upto = new FakeSchemeNetworkClient("upto");
        X402Client client = X402Client.builder().register(BASE, upto).register("eip155:*", exact).build();
        PaymentRequired offer = offer(option(BASE, BASE_USDC, "1000"));

        client.createPaymentPayload(offer, client.selectPaymentRequirements(offer));

        assertEquals(1, exact.paid().size());
    }

    @Test
    void reRegisteringASchemeReplacesTheEarlierClient() {
        FakeSchemeNetworkClient replacement = new FakeSchemeNetworkClient("exact").withDefaultAsset(BASE_USDC, 6);
        X402Client client = X402Client.builder().register(BASE, exact).register(BASE, replacement).build();
        PaymentRequired offer = offer(option(BASE, BASE_USDC, "1000"));

        client.createPaymentPayload(offer, client.selectPaymentRequirements(offer));

        assertEquals(1, replacement.paid().size());
        assertTrue(exact.paid().isEmpty());
    }

    // ---------------------------------------------------------------- payment flows

    @Test
    void dropsOptionsWithAnUnrecognizedPaymentFlow() {
        PaymentRequirements streaming = withFlow(option(BASE, BASE_USDC, "1000"), "streaming");
        PaymentRequirements numeric = withFlow(option(BASE, BASE_USDC, "2000"), 1);
        PaymentRequirements plain = option(BASE, BASE_USDC, "3000");

        assertSame(plain, clientFor(BASE).selectPaymentRequirements(offer(streaming, numeric, plain)));
    }

    @Test
    void failsWhenEveryPaymentFlowIsUnrecognized() {
        PaymentRequired offer = offer(withFlow(option(BASE, BASE_USDC, "1000"), "streaming"));

        PaymentException e = paymentFailure(() -> clientFor(BASE).selectPaymentRequirements(offer));

        assertEquals(PaymentException.UNSUPPORTED_SCHEME, e.reason());
        assertEquals("no payment requirements with a recognized paymentFlow", e.getMessage());
    }

    @Test
    void prefersTheAuthorizationFlowOverUpfrontAndEscrow() {
        PaymentRequirements upfront = withFlow(option(BASE, BASE_USDC, "1000"), "upfront");
        PaymentRequirements escrow = withFlow(option(BASE, BASE_USDC, "1000"), "escrow");
        PaymentRequirements explicit = withFlow(option(BASE, BASE_USDC, "2000"), "authorization");
        PaymentRequirements nullFlow = withFlow(option(BASE, BASE_USDC, "3000"), null);
        PaymentRequirements implicit = option(BASE, BASE_USDC, "4000");
        X402Client client = clientFor(BASE);

        assertSame(explicit, client.selectPaymentRequirements(offer(upfront, escrow, explicit)));
        assertSame(nullFlow, client.selectPaymentRequirements(offer(upfront, nullFlow, implicit)));
        assertSame(implicit, client.selectPaymentRequirements(offer(escrow, implicit)));
    }

    @Test
    void paysAPreHandlerFlowWhenNoAuthorizationOptionRemains() {
        PaymentRequirements upfront = withFlow(option(BASE, BASE_USDC, "1000"), "upfront");
        PaymentRequirements escrow = withFlow(option(BASE, BASE_USDC, "1000"), "escrow");

        assertSame(upfront, clientFor(BASE).selectPaymentRequirements(offer(upfront, escrow)));
    }

    // ---------------------------------------------------------------- selector and policies

    @Test
    void customSelectorChoosesAmongTheCandidates() {
        PaymentRequirements expensive = option(BASE, BASE_USDC, "9000");
        PaymentRequirements cheap = option(BASE, BASE_USDC, "1000");
        X402Client client = X402Client.builder()
                .register(BASE, exact)
                .selector(candidates -> candidates.stream()
                        .min((a, b) -> new BigInteger(a.amount()).compareTo(new BigInteger(b.amount())))
                        .orElseThrow())
                .build();

        assertSame(cheap, client.selectPaymentRequirements(offer(expensive, cheap)));
    }

    @Test
    void selectorCannotReturnAnOptionThatWasNotOffered() {
        PaymentRequirements offered = option(BASE, BASE_USDC, "1000");
        PaymentRequirements foreign = option(BASE, BASE_USDC, "999999999");
        X402Client forging = X402Client.builder().register(BASE, exact).selector(candidates -> foreign).build();
        X402Client returningNull = X402Client.builder().register(BASE, exact).selector(candidates -> null).build();

        assertThrows(IllegalStateException.class, () -> forging.selectPaymentRequirements(offer(offered)));
        assertThrows(IllegalStateException.class, () -> returningNull.selectPaymentRequirements(offer(offered)));
    }

    @Test
    void selectorReceivesAnUnmodifiableList() {
        X402Client client = X402Client.builder()
                .register(BASE, exact)
                .selector(candidates -> candidates.remove(0))
                .build();

        assertThrows(UnsupportedOperationException.class,
                () -> client.selectPaymentRequirements(offer(option(BASE, BASE_USDC, "1000"))));
    }

    @Test
    void policiesRunInOrderAfterSpendControls() {
        PaymentRequirements overCap = option(BASE, BASE_USDC, "1000001");
        PaymentRequirements small = option(BASE, BASE_USDC, "1000");
        PaymentRequirements smaller = option(BASE, BASE_USDC, "500");
        List<List<PaymentRequirements>> seen = new ArrayList<>();
        X402Client client = X402Client.builder()
                .register(BASE, exact)
                .policy(candidates -> {
                    seen.add(candidates);
                    return List.of(candidates.get(1), candidates.get(0));
                })
                .policy(candidates -> {
                    seen.add(candidates);
                    return candidates;
                })
                .build();

        PaymentRequirements selected = client.selectPaymentRequirements(offer(overCap, small, smaller));

        assertSame(smaller, selected);
        assertEquals(List.of(List.of(small, smaller), List.of(smaller, small)), seen);
    }

    @Test
    void policyThatRemovesEveryOptionFailsSelection() {
        X402Client client = X402Client.builder().register(BASE, exact).policy(candidates -> List.of()).build();

        PaymentException e = paymentFailure(
                () -> client.selectPaymentRequirements(offer(option(BASE, BASE_USDC, "1000"))));

        assertEquals(PaymentException.UNSUPPORTED_SCHEME, e.reason());
        assertEquals("all payment requirements were filtered out by policies", e.getMessage());
    }

    @Test
    void policyCannotAddOrForgeOptions() {
        PaymentRequirements offered = option(BASE, BASE_USDC, "1000");
        PaymentRequirements forged = option(BASE, BASE_USDC, "999999999");
        List<PaymentPolicy> broken = List.of(
                candidates -> List.of(forged),
                candidates -> null,
                candidates -> Arrays.asList(offered, null));

        for (PaymentPolicy policy : broken) {
            X402Client client = X402Client.builder().register(BASE, exact).policy(policy).build();
            assertThrows(IllegalStateException.class, () -> client.selectPaymentRequirements(offer(offered)));
        }
    }

    // ---------------------------------------------------------------- spend controls

    @Test
    void allowsAPaymentAtTheDefaultOneDollarCap() {
        PaymentRequirements oneDollar = option(BASE, BASE_USDC, "1000000");

        assertSame(oneDollar, clientFor(BASE).selectPaymentRequirements(offer(oneDollar)));
    }

    @Test
    void rejectsAPaymentAboveTheDefaultOneDollarCap() {
        PaymentRequired offer = offer(option(BASE, BASE_USDC, "1000001"));

        PaymentException e = paymentFailure(() -> clientFor(BASE).selectPaymentRequirements(offer));

        assertEquals(PaymentException.SPEND_CONTROLS_MAX_AMOUNT_EXCEEDED, e.reason());
        assertTrue(e.getMessage().contains("maxAmountPerPayment ($1, including asset " + BASE_USDC + ")"),
                e.getMessage());
    }

    @Test
    void picksTheAffordableOptionWhenAnOfferMixesAmounts() {
        PaymentRequirements fiftyDollars = option(BASE, BASE_USDC, "50000000");
        PaymentRequirements fiftyCents = option(BASE, BASE_USDC, "500000");

        assertSame(fiftyCents, clientFor(BASE).selectPaymentRequirements(offer(fiftyDollars, fiftyCents)));
    }

    @Test
    void rejectsAssetsTheSchemeDoesNotRecognizeByDefault() {
        PaymentRequired offer = offer(option(BASE, CUSTOM_TOKEN, "1"));

        PaymentException e = paymentFailure(() -> clientFor(BASE).selectPaymentRequirements(offer));

        assertEquals(PaymentException.SPEND_CONTROLS_ASSET_NOT_ALLOWED, e.reason());
        assertTrue(e.getMessage().contains("allowAsset"), e.getMessage());
    }

    @Test
    void schemeWithoutDefaultAssetsOnlyPaysAllowedAssets() {
        X402Client bare = X402Client.builder().register(BASE, new FakeSchemeNetworkClient("exact")).build();

        PaymentException e = paymentFailure(
                () -> bare.selectPaymentRequirements(offer(option(BASE, BASE_USDC, "1"))));

        assertEquals(PaymentException.SPEND_CONTROLS_ASSET_NOT_ALLOWED, e.reason());
    }

    @Test
    void disabledSpendControlsAllowAnyAssetAndAmount() {
        X402Client client = clientFor(BASE, SpendControls.disabled());
        PaymentRequirements custom = option(BASE, CUSTOM_TOKEN, "999999999999");
        PaymentRequirements fiveDollars = option(BASE, BASE_USDC, "5000000");

        assertSame(custom, client.selectPaymentRequirements(offer(custom)));
        assertSame(fiveDollars, client.selectPaymentRequirements(offer(fiveDollars)));
    }

    @Test
    void allowAnyAssetStillCapsDefaultAssets() {
        X402Client client = clientFor(BASE, SpendControls.builder().allowAnyAsset().build());
        PaymentRequirements custom = option(BASE, CUSTOM_TOKEN, "999999999999");

        assertSame(custom, client.selectPaymentRequirements(offer(custom)));
        PaymentException e = paymentFailure(
                () -> client.selectPaymentRequirements(offer(option(BASE, BASE_USDC, "1000001"))));
        assertEquals(PaymentException.SPEND_CONTROLS_MAX_AMOUNT_EXCEEDED, e.reason());
    }

    @Test
    void scalesTheUsdCapForAnEighteenDecimalDefaultAsset() {
        FakeSchemeNetworkClient mezo = new FakeSchemeNetworkClient("exact").withDefaultAsset(MEZO_TESTNET_MUSD, 18);
        X402Client client = X402Client.builder().register(MEZO_TESTNET, mezo).build();
        PaymentRequirements oneDollar = option(MEZO_TESTNET, MEZO_TESTNET_MUSD, "1000000000000000000");

        assertSame(oneDollar, client.selectPaymentRequirements(offer(oneDollar)));
        PaymentException e = paymentFailure(() -> client.selectPaymentRequirements(
                offer(option(MEZO_TESTNET, MEZO_TESTNET_MUSD, "1000000000000000001"))));
        assertEquals(PaymentException.SPEND_CONTROLS_MAX_AMOUNT_EXCEEDED, e.reason());
    }

    @Test
    void honoursACustomUsdCapAndTurningTheCapOff() {
        PaymentRequirements fiveDollars = option(BASE, BASE_USDC, "5000000");
        X402Client fiveDollarCap = clientFor(BASE, SpendControls.builder().maxAmountPerPayment("$5").build());
        X402Client uncapped = clientFor(BASE, SpendControls.builder().noMaxAmountPerPayment().build());
        X402Client tenCentCap = clientFor(BASE, SpendControls.builder().maxAmountPerPayment("0.10").build());

        assertSame(fiveDollars, fiveDollarCap.selectPaymentRequirements(offer(fiveDollars)));
        assertSame(fiveDollars, uncapped.selectPaymentRequirements(offer(fiveDollars)));
        PaymentException e = paymentFailure(
                () -> tenCentCap.selectPaymentRequirements(offer(option(BASE, BASE_USDC, "100001"))));
        assertTrue(e.getMessage().contains("($0.10, "), e.getMessage());
    }

    @Test
    void allowsOptInAssetsUncappedOrWithAnAtomicCap() {
        X402Client capped = clientFor(BASE,
                SpendControls.builder().allowAsset(BASE, CUSTOM_TOKEN, BigInteger.valueOf(10_000)).build());
        X402Client uncapped = clientFor(BASE,
                SpendControls.builder().allowAsset("eip155:*", CUSTOM_TOKEN.toLowerCase()).build());
        PaymentRequirements atCap = option(BASE, CUSTOM_TOKEN, "10000");
        PaymentRequirements huge = option(BASE, CUSTOM_TOKEN, "999999999999");

        assertSame(atCap, capped.selectPaymentRequirements(offer(atCap)));
        PaymentException e = paymentFailure(
                () -> capped.selectPaymentRequirements(offer(option(BASE, CUSTOM_TOKEN, "10001"))));
        assertEquals(PaymentException.SPEND_CONTROLS_MAX_AMOUNT_EXCEEDED, e.reason());
        assertTrue(e.getMessage().contains("per-asset maxAmountPerPayment"), e.getMessage());
        assertSame(huge, uncapped.selectPaymentRequirements(offer(huge)));
    }

    @Test
    void allowedAssetOnAnotherNetworkDoesNotApply() {
        X402Client client = clientFor("eip155:*",
                SpendControls.builder().allowAsset("eip155:1", CUSTOM_TOKEN).build());

        PaymentException e = paymentFailure(
                () -> client.selectPaymentRequirements(offer(option(BASE, CUSTOM_TOKEN, "1"))));

        assertEquals(PaymentException.SPEND_CONTROLS_ASSET_NOT_ALLOWED, e.reason());
    }

    @Test
    void rejectsANonIntegerAmountUnderAPerAssetCapButKeepsAnAtomicSibling() {
        X402Client client = clientFor(BASE,
                SpendControls.builder().allowAsset(BASE, CUSTOM_TOKEN, BigInteger.valueOf(10_000)).build());
        PaymentRequirements decimal = option(BASE, CUSTOM_TOKEN, "1.5");
        PaymentRequirements atomic = option(BASE, CUSTOM_TOKEN, "100");

        PaymentException e = paymentFailure(() -> client.selectPaymentRequirements(offer(decimal)));
        assertTrue(e.getMessage().contains("per-asset maxAmountPerPayment"), e.getMessage());
        assertSame(atomic, client.selectPaymentRequirements(offer(decimal, atomic)));
    }

    @Test
    void perAssetCapReplacesTheUsdCapForADefaultAsset() {
        X402Client client = clientFor(BASE,
                SpendControls.builder().allowAsset(BASE, BASE_USDC, BigInteger.valueOf(500_000)).build());
        PaymentRequirements fortyCents = option(BASE, BASE_USDC, "400000");

        assertSame(fortyCents, client.selectPaymentRequirements(offer(fortyCents)));
        PaymentException e = paymentFailure(
                () -> client.selectPaymentRequirements(offer(option(BASE, BASE_USDC, "600000"))));
        assertTrue(e.getMessage().contains("per-asset maxAmountPerPayment"), e.getMessage());
    }

    @Test
    void keepsTheUsdCapForADefaultAssetListedWithoutACap() {
        X402Client client = clientFor(BASE, SpendControls.builder().allowAsset(BASE, BASE_USDC).build());

        PaymentException e = paymentFailure(
                () -> client.selectPaymentRequirements(offer(option(BASE, BASE_USDC, "1000001"))));

        assertEquals(PaymentException.SPEND_CONTROLS_MAX_AMOUNT_EXCEEDED, e.reason());
        assertTrue(e.getMessage().contains("($1, "), e.getMessage());
    }

    @Test
    void reportsTheUsdCapWhenOptionsFailDifferentCaps() {
        X402Client client = clientFor(BASE,
                SpendControls.builder().allowAsset(BASE, CUSTOM_TOKEN, BigInteger.TEN).build());

        PaymentException e = paymentFailure(() -> client.selectPaymentRequirements(
                offer(option(BASE, CUSTOM_TOKEN, "11"), option(BASE, BASE_USDC, "1000001"))));

        assertTrue(e.getMessage().contains("($1, including asset " + BASE_USDC + ")"), e.getMessage());
    }

    @Test
    void comparesDecimalAmountsOneToOneWithTheUsdCap() {
        PaymentRequirements fiftyCents = option(BASE, BASE_USDC, "0.50");
        X402Client client = clientFor(BASE);

        assertSame(fiftyCents, client.selectPaymentRequirements(offer(fiftyCents)));
        for (String amount : List.of("1.01", "-1", "1e3", "abc", "")) {
            PaymentException e = paymentFailure(
                    () -> client.selectPaymentRequirements(offer(option(BASE, BASE_USDC, amount))));
            assertEquals(PaymentException.SPEND_CONTROLS_MAX_AMOUNT_EXCEEDED, e.reason(), amount);
        }
    }

    @Test
    void negativeDecimalsFromASchemeAreAProgrammingError() {
        FakeSchemeNetworkClient broken = new FakeSchemeNetworkClient("exact").withDefaultAsset(BASE_USDC, -1);
        X402Client client = X402Client.builder().register(BASE, broken).build();

        assertThrows(IllegalStateException.class,
                () -> client.selectPaymentRequirements(offer(option(BASE, BASE_USDC, "1"))));
    }

    @Test
    void schemeReturningNullDecimalsIsTreatedAsUnknownAsset() {
        SchemeNetworkClient nullDecimals = new FakeSchemeNetworkClient("exact") {
            @Override
            public OptionalInt defaultAssetDecimals(String asset, String network) {
                return null;
            }
        };
        X402Client client = X402Client.builder().register(BASE, nullDecimals).build();

        PaymentException e = paymentFailure(
                () -> client.selectPaymentRequirements(offer(option(BASE, BASE_USDC, "1"))));

        assertEquals(PaymentException.SPEND_CONTROLS_ASSET_NOT_ALLOWED, e.reason());
    }

    // ---------------------------------------------------------------- payload creation

    @Test
    void createsAPayloadWithTheSelectedOptionVerbatimAndServerDataEchoed() {
        PaymentRequirements selected = option(BASE, BASE_USDC, "10000");
        Map<String, Object> extensions = Map.of("bazaar", Map.of("info", Map.of("input", List.of(1, "two"))));
        PaymentRequired paymentRequired =
                new PaymentRequired(2, "PAYMENT-SIGNATURE header is required", RESOURCE, List.of(selected), extensions);

        PaymentPayload payload = clientFor(BASE).createPaymentPayload(paymentRequired, selected);

        assertEquals(X402.PROTOCOL_VERSION, payload.x402Version());
        assertEquals(selected, payload.accepted());
        assertEquals(RESOURCE, payload.resource());
        assertEquals(extensions, payload.extensions());
        assertEquals(Map.of("signature", "0xsigned", "authorization", Map.of("value", "10000")), payload.payload());
        assertEquals(List.of(selected), exact.paid());
        JsonNode json = Json.toTree(payload);
        assertEquals(2, json.get("x402Version").intValue());
        assertEquals(Json.toTree(selected), json.get("accepted"));
        assertEquals("https://api.example.com/premium-data", json.get("resource").get("url").textValue());
    }

    @Test
    void createPaymentPayloadOmitsAbsentResourceAndExtensions() {
        PaymentRequirements selected = option(BASE, BASE_USDC, "10000");
        PaymentRequired bare = new PaymentRequired(2, null, null, List.of(selected), null);

        JsonNode json = Json.toTree(clientFor(BASE).createPaymentPayload(bare, selected));

        assertTrue(json.get("resource") == null && json.get("extensions") == null, json.toString());
    }

    @Test
    void createPaymentPayloadRejectsAnOptionThatWasNotOffered() {
        PaymentRequired offer = offer(option(BASE, BASE_USDC, "1000"));
        X402Client client = clientFor(BASE);

        assertThrows(IllegalArgumentException.class,
                () -> client.createPaymentPayload(offer, option(BASE, BASE_USDC, "999")));
    }

    @Test
    void createPaymentPayloadValidatesThePaymentRequired() {
        PaymentRequirements selected = option(BASE, BASE_USDC, "1000");
        PaymentRequired v1 = new PaymentRequired(1, null, null, List.of(selected), null);

        PaymentException e = paymentFailure(() -> clientFor(BASE).createPaymentPayload(v1, selected));

        assertEquals(PaymentException.INVALID_PAYMENT_REQUIRED, e.reason());
    }

    @Test
    void createPaymentPayloadNamesTheMissingNetworkOrScheme() {
        PaymentRequirements ethereum = option("eip155:1", BASE_USDC, "1000");
        PaymentRequirements upto = new PaymentRequirements("upto", BASE, BASE_USDC, "1000", PAY_TO, 60, null);
        X402Client client = clientFor(BASE);

        PaymentException network = paymentFailure(() -> client.createPaymentPayload(offer(ethereum), ethereum));
        PaymentException scheme = paymentFailure(() -> client.createPaymentPayload(offer(upto), upto));

        assertEquals(PaymentException.UNSUPPORTED_SCHEME, network.reason());
        assertEquals("no client registered for network eip155:1", network.getMessage());
        assertEquals(PaymentException.UNSUPPORTED_SCHEME, scheme.reason());
        assertEquals("no client registered for scheme upto on network eip155:8453", scheme.getMessage());
    }

    @Test
    void createPaymentPayloadEnforcesSpendControls() {
        PaymentRequirements overCap = option(BASE, BASE_USDC, "1000001");

        PaymentException e = paymentFailure(() -> clientFor(BASE).createPaymentPayload(offer(overCap), overCap));

        assertEquals(PaymentException.SPEND_CONTROLS_MAX_AMOUNT_EXCEEDED, e.reason());
        assertTrue(exact.paid().isEmpty());
    }

    @Test
    void schemeFailuresPropagateUnchanged() {
        PaymentException failure = new PaymentException("invalid_exact_evm_client_amount", "amount is not an integer");
        SchemeNetworkClient failing = new FakeSchemeNetworkClient("exact") {
            @Override
            public Map<String, Object> createPaymentPayload(PaymentRequirements requirements) {
                throw failure;
            }
        }.withDefaultAsset(BASE_USDC, 6);
        PaymentRequirements selected = option(BASE, BASE_USDC, "1000");
        X402Client client = X402Client.builder().register(BASE, failing).build();

        assertSame(failure, paymentFailure(() -> client.createPaymentPayload(offer(selected), selected)));
    }

    @Test
    void schemeReturningNoPayloadIsRejected() {
        SchemeNetworkClient empty = new FakeSchemeNetworkClient("exact") {
            @Override
            public Map<String, Object> createPaymentPayload(PaymentRequirements requirements) {
                return null;
            }
        }.withDefaultAsset(BASE_USDC, 6);
        PaymentRequirements selected = option(BASE, BASE_USDC, "1000");
        X402Client client = X402Client.builder().register(BASE, empty).build();

        assertThrows(IllegalStateException.class, () -> client.createPaymentPayload(offer(selected), selected));
    }

    // ---------------------------------------------------------------- helpers

    private X402Client clientFor(String network) {
        return clientFor(network, SpendControls.defaults());
    }

    private X402Client clientFor(String network, SpendControls controls) {
        return X402Client.builder().register(network, exact).spendControls(controls).build();
    }

    private static PaymentRequirements option(String network, String asset, String amount) {
        return new PaymentRequirements("exact", network, asset, amount, PAY_TO, 60,
                Map.of("name", "USD Coin", "version", "2"));
    }

    private static PaymentRequirements withFlow(PaymentRequirements requirements, Object flow) {
        Map<String, Object> extra = new LinkedHashMap<>(requirements.extra());
        extra.put("paymentFlow", flow);
        return requirements.withExtra(extra);
    }

    private static PaymentRequired offer(PaymentRequirements... accepts) {
        return new PaymentRequired(2, null, RESOURCE, List.of(accepts), null);
    }

    private static PaymentException paymentFailure(Executable executable) {
        return assertThrows(PaymentException.class, executable);
    }
}
