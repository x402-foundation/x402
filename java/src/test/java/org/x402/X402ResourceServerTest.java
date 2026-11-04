package org.x402;

import org.x402.testsupport.server.FakeFacilitator;
import org.x402.testsupport.server.FakeSchemeServer;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequired;
import org.x402.types.PaymentRequirements;
import org.x402.types.ResourceInfo;
import org.x402.types.SettleResponse;
import org.x402.types.SupportedKind;
import org.x402.types.SupportedResponse;
import org.x402.types.VerifyResponse;

import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class X402ResourceServerTest {

    private static final String NETWORK = "eip155:84532";
    private static final String PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
    private static final String PENDING_TX = "0x" + "cd".repeat(32);

    private static PaymentRequirements requirements() {
        return new PaymentRequirements("exact", NETWORK, FakeSchemeServer.ASSET, "1000", PAY_TO, 300,
                Map.of("name", "USDC", "version", "2"));
    }

    private static PaymentPayload payloadAccepting(PaymentRequirements accepted) {
        return new PaymentPayload(2, Map.of("signature", "0x01"), accepted, null, null);
    }

    private static X402ResourceServer initializedServer(FacilitatorClient facilitator) throws Exception {
        X402ResourceServer server = X402ResourceServer.builder()
                .register(NETWORK, new FakeSchemeServer("exact"))
                .facilitator(facilitator)
                .build();
        server.initialize();
        return server;
    }

    @Nested
    class Initialization {

        @Test
        void rejectsWildcardRegistrationBecauseServerLookupIsExact() {
            X402ResourceServer.Builder builder = X402ResourceServer.builder();
            FakeSchemeServer scheme = new FakeSchemeServer("exact");

            assertThrows(IllegalArgumentException.class, () -> builder.register("eip155:*", scheme));
        }

        @Test
        void routesEachNetworkAndSchemeToTheFirstFacilitatorSupportingIt() throws Exception {
            FakeFacilitator first = new FakeFacilitator(NETWORK);
            FakeFacilitator second = new FakeFacilitator(NETWORK, "eip155:8453");
            X402ResourceServer server = X402ResourceServer.builder()
                    .register(NETWORK, new FakeSchemeServer("exact"))
                    .register("eip155:8453", new FakeSchemeServer("exact"))
                    .facilitators(List.of(first, second))
                    .build();
            assertFalse(server.isInitialized());

            server.initialize();

            assertTrue(server.isInitialized());
            assertTrue(server.hasFacilitatorSupport(NETWORK, "exact"));
            assertFalse(server.hasFacilitatorSupport("eip155:1", "exact"));
            server.verify(payloadAccepting(requirements()), requirements());
            PaymentRequirements base = new PaymentRequirements(
                    "exact", "eip155:8453", FakeSchemeServer.ASSET, "1000", PAY_TO, 300, null);
            server.verify(payloadAccepting(base), base);
            assertEquals(1, first.verifyCalls());
            assertEquals(1, second.verifyCalls());
        }

        @Test
        void keepsPreviousStateWhenRefreshFails() throws Exception {
            FacilitatorClient facilitator = mock(FacilitatorClient.class);
            when(facilitator.supported())
                    .thenReturn(new FakeFacilitator(NETWORK).supported())
                    .thenThrow(new IOException("facilitator down"));
            X402ResourceServer server = initializedServer(facilitator);

            assertThrows(IOException.class, server::initialize);

            assertTrue(server.hasFacilitatorSupport(NETWORK, "exact"));
        }

        @Test
        void rejectsAMissingSupportedResponse() throws Exception {
            FacilitatorClient facilitator = mock(FacilitatorClient.class);
            X402ResourceServer server = X402ResourceServer.builder().facilitator(facilitator).build();

            assertThrows(IOException.class, server::initialize);
            assertFalse(server.isInitialized());
        }

        @Test
        void ignoresIncompleteSupportedKinds() throws Exception {
            FacilitatorClient facilitator = mock(FacilitatorClient.class);
            when(facilitator.supported()).thenReturn(new SupportedResponse(
                    java.util.Arrays.asList(null, new SupportedKind(2, null, NETWORK, null),
                            new SupportedKind(2, "exact", NETWORK, null)),
                    null, null));

            X402ResourceServer server = initializedServer(facilitator);

            assertTrue(server.hasFacilitatorSupport(NETWORK, "exact"));
        }

        @Test
        void exposesRegisteredSchemeServersByExactNetwork() {
            FakeSchemeServer scheme = new FakeSchemeServer("exact");
            X402ResourceServer server = X402ResourceServer.builder().register(NETWORK, scheme).build();

            assertSame(scheme, server.schemeServer(NETWORK, "exact").orElseThrow());
            assertTrue(server.schemeServer("eip155:8453", "exact").isEmpty());
            assertTrue(server.schemeServer(NETWORK, "upto").isEmpty());
        }
    }

    @Nested
    class BuildPaymentRequirements {

        @Test
        void buildsTheRequirementsForAMoneyPrice() throws Exception {
            X402ResourceServer server = initializedServer(new FakeFacilitator(NETWORK));

            PaymentRequirements built = server.buildPaymentRequirements(
                    ResourceConfig.of("exact", PAY_TO, Price.money("$0.001"), NETWORK));

            // go.md section 5.2: "$0.001" on eip155:84532 with default timeout and the USDC domain.
            assertEquals(new PaymentRequirements("exact", NETWORK, FakeSchemeServer.ASSET, "1000", PAY_TO, 300,
                    Map.of("name", "USDC", "version", "2")), built);
        }

        @Test
        void keepsAnExplicitTimeout() throws Exception {
            X402ResourceServer server = initializedServer(new FakeFacilitator(NETWORK));

            PaymentRequirements built = server.buildPaymentRequirements(
                    new ResourceConfig("exact", PAY_TO, Price.money("$1"), NETWORK, 60, null));

            assertEquals(60, built.maxTimeoutSeconds());
            assertEquals("1000000", built.amount());
        }

        @Test
        void mergesConfiguredExtraOverParsedExtra() throws Exception {
            X402ResourceServer server = initializedServer(new FakeFacilitator(NETWORK));

            PaymentRequirements built = server.buildPaymentRequirements(new ResourceConfig(
                    "exact", PAY_TO, Price.money("$0.01"), NETWORK, 0, Map.of("name", "USD Coin", "memo", "x")));

            assertEquals(Map.of("name", "USD Coin", "version", "2", "memo", "x"), built.extra());
        }

        @Test
        void leavesExtraNullWhenNothingIsDeclared() throws Exception {
            X402ResourceServer server = initializedServer(new FakeFacilitator(NETWORK));

            PaymentRequirements built = server.buildPaymentRequirements(
                    ResourceConfig.of("exact", PAY_TO, AssetAmount.of("5", FakeSchemeServer.ASSET), NETWORK));

            assertNull(built.extra());
        }

        @Test
        void stripsDefaultAssetTransferMethodsFromTheWire() throws Exception {
            X402ResourceServer server = initializedServer(new FakeFacilitator(NETWORK));

            AssetAmount price = AssetAmount.of("5", FakeSchemeServer.ASSET);
            for (String method : List.of("eip3009", "default")) {
                PaymentRequirements built = server.buildPaymentRequirements(new ResourceConfig(
                        "exact", PAY_TO, price, NETWORK, 0, Map.of("assetTransferMethod", method)));
                assertNull(built.extra(), method);
            }
            PaymentRequirements permit2 = server.buildPaymentRequirements(new ResourceConfig(
                    "exact", PAY_TO, price, NETWORK, 0, Map.of("assetTransferMethod", "permit2")));
            assertEquals(Map.of("assetTransferMethod", "permit2"), permit2.extra());
        }

        @Test
        void acceptsAnExplicitAuthorizationFlowAndRejectsOthers() throws Exception {
            X402ResourceServer server = initializedServer(new FakeFacilitator(NETWORK));
            AssetAmount price = AssetAmount.of("5", FakeSchemeServer.ASSET);

            PaymentRequirements authorization = server.buildPaymentRequirements(new ResourceConfig(
                    "exact", PAY_TO, price, NETWORK, 0, Map.of("paymentFlow", "authorization")));
            assertEquals(Map.of("paymentFlow", "authorization"), authorization.extra());

            ResourceConfig upfront = new ResourceConfig(
                    "exact", PAY_TO, price, NETWORK, 0, Map.of("paymentFlow", "upfront"));
            assertThrows(IllegalArgumentException.class, () -> server.buildPaymentRequirements(upfront));
        }

        @Test
        void passesTheFacilitatorKindToTheSchemeOrAnEmptyFallback() throws Exception {
            FakeSchemeServer scheme = new FakeSchemeServer("exact");
            FacilitatorClient facilitator = mock(FacilitatorClient.class);
            SupportedKind v1Kind = new SupportedKind(1, "exact", NETWORK, Map.of("v", 1));
            SupportedKind v2Kind = new SupportedKind(2, "exact", NETWORK, Map.of("feePayer", "0xF"));
            when(facilitator.supported()).thenReturn(new SupportedResponse(List.of(v1Kind, v2Kind), null, null));
            X402ResourceServer server = X402ResourceServer.builder()
                    .register(NETWORK, scheme)
                    .register("eip155:8453", scheme)
                    .facilitator(facilitator)
                    .build();
            server.initialize();

            server.buildPaymentRequirements(ResourceConfig.of("exact", PAY_TO, Price.money("$1"), NETWORK));
            server.buildPaymentRequirements(ResourceConfig.of("exact", PAY_TO, Price.money("$1"), "eip155:8453"));

            assertEquals(v2Kind, scheme.seenKinds().get(0));
            assertEquals(new SupportedKind(2, "exact", "eip155:8453", Map.of()), scheme.seenKinds().get(1));
        }

        @Test
        void rejectsConfigsWithoutARegisteredScheme() throws Exception {
            X402ResourceServer server = initializedServer(new FakeFacilitator(NETWORK));

            IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                    () -> server.buildPaymentRequirements(
                            ResourceConfig.of("upto", PAY_TO, Price.money("$1"), NETWORK)));
            assertTrue(error.getMessage().contains("upto"));
        }

        @Test
        void propagatesSchemePricingErrors() {
            SchemeNetworkServer failing = mock(SchemeNetworkServer.class);
            when(failing.scheme()).thenReturn("exact");
            when(failing.parsePrice(any(), any())).thenThrow(new IllegalArgumentException("permit2 only"));
            X402ResourceServer server = X402ResourceServer.builder().register(NETWORK, failing).build();

            assertThrows(IllegalArgumentException.class, () -> server.buildPaymentRequirements(
                    ResourceConfig.of("exact", PAY_TO, Price.money("$1"), NETWORK)));
        }
    }

    @Nested
    class FindMatchingRequirements {

        private final X402ResourceServer server = X402ResourceServer.builder().build();

        @Test
        void matchesAVerbatimEcho() {
            PaymentRequirements required = requirements();

            Optional<PaymentRequirements> match = server.findMatchingRequirements(
                    List.of(required), payloadAccepting(required));

            assertSame(required, match.orElseThrow());
        }

        @Test
        void returnsTheFirstMatchingRequirementInOrder() {
            PaymentRequirements other = new PaymentRequirements(
                    "exact", "eip155:8453", FakeSchemeServer.ASSET, "1000", PAY_TO, 300, null);
            PaymentRequirements required = requirements();

            Optional<PaymentRequirements> match = server.findMatchingRequirements(
                    java.util.Arrays.asList(other, null, required), payloadAccepting(required));

            assertSame(required, match.orElseThrow());
        }

        @Test
        void rejectsAnyChangeToTheCoreTerms() {
            PaymentRequirements required = requirements();
            Map<String, Object> extra = required.extra();
            List<PaymentRequirements> tampered = List.of(
                    new PaymentRequirements("upto", NETWORK, FakeSchemeServer.ASSET, "1000", PAY_TO, 300, extra),
                    new PaymentRequirements("exact", "eip155:8453", FakeSchemeServer.ASSET, "1000", PAY_TO, 300,
                            extra),
                    new PaymentRequirements("exact", NETWORK, FakeSchemeServer.ASSET.toLowerCase(), "1000", PAY_TO,
                            300, extra),
                    new PaymentRequirements("exact", NETWORK, FakeSchemeServer.ASSET, "999", PAY_TO, 300, extra),
                    new PaymentRequirements("exact", NETWORK, FakeSchemeServer.ASSET, "1000", PAY_TO.toLowerCase(),
                            300, extra),
                    new PaymentRequirements("exact", NETWORK, FakeSchemeServer.ASSET, "1000", PAY_TO, 3600, extra));

            for (PaymentRequirements accepted : tampered) {
                assertTrue(server.findMatchingRequirements(List.of(required), payloadAccepting(accepted)).isEmpty(),
                        accepted.toString());
            }
        }

        @Test
        void treatsAbsentAndEmptyStringsAlike() {
            PaymentRequirements required = new PaymentRequirements("exact", NETWORK, "", "1000", PAY_TO, 300, null);
            PaymentRequirements accepted = new PaymentRequirements("exact", NETWORK, null, "1000", PAY_TO, 300, null);

            assertTrue(server.findMatchingRequirements(List.of(required), payloadAccepting(accepted)).isPresent());
        }

        @Test
        void requiresServerExtraAsASubsetOfTheEcho() {
            PaymentRequirements required = requirements();
            PaymentRequirements withMore = required.withExtra(Map.of("name", "USDC", "version", "2", "x", true));
            PaymentRequirements missingVersion = required.withExtra(Map.of("name", "USDC"));
            PaymentRequirements noExtra = required.withExtra(null);

            assertTrue(server.findMatchingRequirements(List.of(required), payloadAccepting(withMore)).isPresent());
            assertTrue(server.findMatchingRequirements(List.of(required), payloadAccepting(missingVersion))
                    .isEmpty());
            assertTrue(server.findMatchingRequirements(List.of(required), payloadAccepting(noExtra)).isEmpty());
        }

        @Test
        void acceptsAnyEchoedExtraWhenTheServerDeclaresNoneOrAnEmptyMap() {
            PaymentRequirements accepted = requirements().withExtra(Map.of("anything", 1));

            for (Map<String, Object> declared : java.util.Arrays.<Map<String, Object>>asList(null, Map.of())) {
                PaymentRequirements required = requirements().withExtra(declared);
                assertTrue(server.findMatchingRequirements(List.of(required), payloadAccepting(accepted))
                        .isPresent());
                assertTrue(server.findMatchingRequirements(List.of(required),
                        payloadAccepting(requirements().withExtra(null))).isPresent());
            }
        }

        @Test
        void letsNullServerExtraValuesBeAbsentFromTheEcho() {
            Map<String, Object> declared = new HashMap<>();
            declared.put("name", "USDC");
            declared.put("feePayer", null);
            PaymentRequirements required = requirements().withExtra(declared);

            assertTrue(server.findMatchingRequirements(List.of(required),
                    payloadAccepting(requirements().withExtra(Map.of("name", "USDC")))).isPresent());
        }

        @Test
        void returnsEmptyWithoutAnAcceptedEntry() {
            PaymentPayload payload = new PaymentPayload(2, Map.of(), null, null, null);

            assertTrue(server.findMatchingRequirements(List.of(requirements()), payload).isEmpty());
        }
    }

    @Nested
    class Verify {

        @Test
        void returnsTheFacilitatorResponseForAValidPayment() throws Exception {
            FakeFacilitator facilitator = new FakeFacilitator(NETWORK);
            X402ResourceServer server = initializedServer(facilitator);

            VerifyResponse response = server.verify(payloadAccepting(requirements()), requirements());

            assertTrue(response.isValid());
            assertEquals(FakeFacilitator.PAYER, response.payer());
        }

        @Test
        void turnsAnInvalidResponseIntoAVerifyExceptionWithTheFacilitatorReason() throws Exception {
            FakeFacilitator facilitator = new FakeFacilitator(NETWORK).onVerify((payload, requirements) ->
                    VerifyResponse.invalid("invalid_exact_evm_signature", "bad sig", FakeFacilitator.PAYER));
            X402ResourceServer server = initializedServer(facilitator);

            VerifyException error = assertThrows(VerifyException.class,
                    () -> server.verify(payloadAccepting(requirements()), requirements()));

            assertEquals("invalid_exact_evm_signature", error.reason());
            assertEquals(FakeFacilitator.PAYER, error.payer());
            assertEquals("bad sig", error.invalidMessage());
        }

        @Test
        void usesInvalidPaymentWhenTheFacilitatorGivesNoReasonOrNoResponse() throws Exception {
            FakeFacilitator facilitator = new FakeFacilitator(NETWORK)
                    .onVerify((payload, requirements) -> VerifyResponse.invalid(null, null, null));
            X402ResourceServer server = initializedServer(facilitator);

            assertEquals(X402ResourceServer.INVALID_PAYMENT, assertThrows(VerifyException.class,
                    () -> server.verify(payloadAccepting(requirements()), requirements())).reason());

            facilitator.onVerify((payload, requirements) -> null);
            assertEquals(X402ResourceServer.INVALID_PAYMENT, assertThrows(VerifyException.class,
                    () -> server.verify(payloadAccepting(requirements()), requirements())).reason());
        }

        @Test
        void failsWithoutAFacilitatorForTheNetwork() throws Exception {
            X402ResourceServer server = X402ResourceServer.builder()
                    .register(NETWORK, new FakeSchemeServer("exact"))
                    .facilitator(new FakeFacilitator("eip155:8453"))
                    .build();
            server.initialize();

            VerifyException error = assertThrows(VerifyException.class,
                    () -> server.verify(payloadAccepting(requirements()), requirements()));

            assertEquals(X402ResourceServer.NO_FACILITATOR_FOR_NETWORK, error.reason());
        }

        @Test
        void failsWhenNoSchemeIsRegisteredForTheRequirements() throws Exception {
            FakeFacilitator facilitator = new FakeFacilitator(NETWORK);
            X402ResourceServer server = X402ResourceServer.builder().facilitator(facilitator).build();
            server.initialize();

            VerifyException error = assertThrows(VerifyException.class,
                    () -> server.verify(payloadAccepting(requirements()), requirements()));

            assertEquals(X402ResourceServer.INVALID_PAYMENT, error.reason());
            assertEquals(0, facilitator.verifyCalls());
        }

        @Test
        void refusesToVerifyAnUnsupportedPaymentFlow() throws Exception {
            FakeFacilitator facilitator = new FakeFacilitator(NETWORK);
            X402ResourceServer server = initializedServer(facilitator);
            PaymentRequirements upfront = requirements().withExtra(Map.of("paymentFlow", "upfront"));

            VerifyException error = assertThrows(VerifyException.class,
                    () -> server.verify(payloadAccepting(upfront), upfront));

            assertEquals(X402ResourceServer.INVALID_PAYMENT, error.reason());
            assertEquals(0, facilitator.verifyCalls());
        }

        @Test
        void propagatesTransportFailures() throws Exception {
            FakeFacilitator facilitator = new FakeFacilitator(NETWORK).onVerify((payload, requirements) -> {
                throw new IOException("connection refused");
            });
            X402ResourceServer server = initializedServer(facilitator);

            assertThrows(IOException.class, () -> server.verify(payloadAccepting(requirements()), requirements()));
        }

        @Test
        void acceptsOmittedOrPreservedExtensionEchoes() throws Exception {
            X402ResourceServer server = initializedServer(new FakeFacilitator(NETWORK));
            Map<String, Object> declared = Map.of("bazaar", Map.of(
                    "info", Map.of("input", Map.of("method", "GET")), "schema", Map.of("type", "object")));

            server.verify(payloadAccepting(requirements()), requirements(), declared);
            server.verify(withExtensions(declared), requirements(), declared);
            server.verify(withExtensions(Map.of("bazaar", Map.of("info",
                    Map.of("input", Map.of("method", "GET", "extra", 1))))), requirements(), declared);
            server.verify(withExtensions(Map.of("undeclared", "anything")), requirements(), declared);
        }

        @Test
        void rejectsAnEchoThatChangesADeclaredValue() throws Exception {
            FakeFacilitator facilitator = new FakeFacilitator(NETWORK);
            X402ResourceServer server = initializedServer(facilitator);
            Map<String, Object> declared = Map.of("bazaar", Map.of("info", Map.of("method", "GET")));

            VerifyException error = assertThrows(VerifyException.class, () -> server.verify(
                    withExtensions(Map.of("bazaar", Map.of("info", Map.of("method", "POST")))),
                    requirements(), declared));

            assertEquals(X402ResourceServer.EXTENSION_ECHO_MISMATCH, error.reason());
            assertTrue(error.invalidMessage().contains("bazaar"));
            assertEquals(0, facilitator.verifyCalls());
        }

        @Test
        void comparesExtensionsWithoutAnInfoEnvelopeAsWholeValues() throws Exception {
            X402ResourceServer server = initializedServer(new FakeFacilitator(NETWORK));
            Map<String, Object> declared = Map.of("flag", "on");

            server.verify(withExtensions(Map.of("flag", "on")), requirements(), declared);
            assertThrows(VerifyException.class,
                    () -> server.verify(withExtensions(Map.of("flag", "off")), requirements(), declared));
        }

        private PaymentPayload withExtensions(Map<String, Object> extensions) {
            return new PaymentPayload(2, Map.of("signature", "0x01"), requirements(), null, extensions);
        }
    }

    @Nested
    class Settle {

        @Test
        void returnsASuccessfulSettlement() throws Exception {
            X402ResourceServer server = initializedServer(new FakeFacilitator(NETWORK));

            SettleResponse response = server.settle(payloadAccepting(requirements()), requirements());

            assertTrue(response.success());
            assertEquals(FakeFacilitator.TRANSACTION, response.transaction());
        }

        @Test
        void returnsAFailedSettlementWithItsReceipt() throws Exception {
            SettleResponse failure = new SettleResponse(false, "insufficient_funds", null, FakeFacilitator.PAYER,
                    "0xdeposit", NETWORK, "1000", null, Map.of("channelId", "0xchannel"));
            FakeFacilitator facilitator = new FakeFacilitator(NETWORK).onSettle((p, r) -> failure);
            X402ResourceServer server = initializedServer(facilitator);

            assertSame(failure, server.settle(payloadAccepting(requirements()), requirements()));
            assertEquals(1, facilitator.settleCalls());
        }

        @Test
        void retriesOnceWhenAReturnedFailureIsPendingWithATransaction() throws Exception {
            FacilitatorClient facilitator = mock(FacilitatorClient.class);
            when(facilitator.supported()).thenReturn(new FakeFacilitator(NETWORK).supported());
            SettleResponse pending = SettleResponse.failure("settlement_pending", null, null, PENDING_TX, NETWORK);
            SettleResponse settled = SettleResponse.success(FakeFacilitator.PAYER, PENDING_TX, NETWORK);
            when(facilitator.settle(any(), any())).thenReturn(pending, settled);
            X402ResourceServer server = initializedServer(facilitator);

            assertSame(settled, server.settle(payloadAccepting(requirements()), requirements()));
            verify(facilitator, times(2)).settle(any(), any());
        }

        @Test
        void retriesOnceWhenAThrownFailureIsPendingWithATransaction() throws Exception {
            FacilitatorClient facilitator = mock(FacilitatorClient.class);
            when(facilitator.supported()).thenReturn(new FakeFacilitator(NETWORK).supported());
            SettleException pending = new SettleException("settlement_pending", null, NETWORK, PENDING_TX, "timeout");
            when(facilitator.settle(any(), any())).thenThrow(pending).thenThrow(pending);
            X402ResourceServer server = initializedServer(facilitator);

            assertSame(pending, assertThrows(SettleException.class,
                    () -> server.settle(payloadAccepting(requirements()), requirements())));
            verify(facilitator, times(2)).settle(any(), any());
        }

        @Test
        void doesNotRetryWithoutATransactionOrForOtherReasons() throws Exception {
            FacilitatorClient facilitator = mock(FacilitatorClient.class);
            when(facilitator.supported()).thenReturn(new FakeFacilitator(NETWORK).supported());
            X402ResourceServer server = initializedServer(facilitator);

            when(facilitator.settle(any(), any()))
                    .thenReturn(SettleResponse.failure("settlement_pending", null, null, "", NETWORK));
            assertFalse(server.settle(payloadAccepting(requirements()), requirements()).success());
            when(facilitator.settle(any(), any())).thenThrow(
                    new SettleException("invalid_payment", null, NETWORK, PENDING_TX, null));
            assertThrows(SettleException.class,
                    () -> server.settle(payloadAccepting(requirements()), requirements()));

            verify(facilitator, times(2)).settle(any(), any());
        }

        @Test
        void failsWithoutAFacilitator() throws Exception {
            X402ResourceServer server = X402ResourceServer.builder().build();
            server.initialize();

            SettleException error = assertThrows(SettleException.class,
                    () -> server.settle(payloadAccepting(requirements()), requirements()));

            assertEquals(X402ResourceServer.NO_FACILITATOR, error.reason());
            assertEquals(NETWORK, error.network());
            assertEquals("", error.transaction());
        }

        @Test
        void failsWithoutAFacilitatorForIncompleteRequirements() throws Exception {
            X402ResourceServer server = initializedServer(new FakeFacilitator(NETWORK));
            PaymentRequirements noNetwork =
                    new PaymentRequirements("exact", null, FakeSchemeServer.ASSET, "1000", PAY_TO, 300, null);

            SettleException error = assertThrows(SettleException.class,
                    () -> server.settle(payloadAccepting(noNetwork), noNetwork));

            assertEquals(X402ResourceServer.NO_FACILITATOR, error.reason());
        }

        @Test
        void rejectsAMissingSettleResponse() throws Exception {
            FakeFacilitator facilitator = new FakeFacilitator(NETWORK).onSettle((p, r) -> null);
            X402ResourceServer server = initializedServer(facilitator);

            SettleException error = assertThrows(SettleException.class,
                    () -> server.settle(payloadAccepting(requirements()), requirements()));

            assertEquals(X402ResourceServer.INVALID_RESPONSE, error.reason());
        }

        @Test
        void propagatesTransportFailuresWithoutRetrying() throws Exception {
            FacilitatorClient facilitator = mock(FacilitatorClient.class);
            when(facilitator.supported()).thenReturn(new FakeFacilitator(NETWORK).supported());
            when(facilitator.settle(any(), any())).thenThrow(new IOException("timeout"));
            X402ResourceServer server = initializedServer(facilitator);

            assertThrows(IOException.class, () -> server.settle(payloadAccepting(requirements()), requirements()));
            verify(facilitator, times(1)).settle(any(), any());
            verify(facilitator, never()).verify(any(), any());
        }
    }

    @Test
    void createsAVersion2PaymentRequiredMessage() {
        X402ResourceServer server = X402ResourceServer.builder().build();
        ResourceInfo resource = ResourceInfo.of("https://api.example.com/weather", "Weather", "application/json");
        Map<String, Object> extensions = new LinkedHashMap<>(Map.of("bazaar", Map.of()));

        PaymentRequired message = server.createPaymentRequired(
                List.of(requirements()), resource, "Payment required", extensions);

        assertEquals(new PaymentRequired(2, "Payment required", resource, List.of(requirements()), extensions),
                message);
    }
}
