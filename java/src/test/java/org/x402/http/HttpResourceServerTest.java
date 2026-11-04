package org.x402.http;

import org.x402.AssetAmount;
import org.x402.FacilitatorClient;
import org.x402.Price;
import org.x402.SchemeNetworkServer;
import org.x402.SettleException;
import org.x402.VerifyException;
import org.x402.X402ResourceServer;
import org.x402.mechanisms.evm.exact.ExactEvmServerScheme;
import org.x402.testsupport.server.FakeFacilitator;
import org.x402.testsupport.server.FakeSchemeServer;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequired;
import org.x402.types.PaymentRequirements;
import org.x402.types.ResourceInfo;
import org.x402.types.SettleResponse;
import org.x402.types.SupportedKind;
import org.x402.types.VerifyResponse;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.MethodSource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class HttpResourceServerTest {

    private static final String NETWORK = "eip155:84532";
    private static final String PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
    private static final String URL = "http://localhost:4021/weather?city=Tallinn";

    private final FakeFacilitator facilitator = new FakeFacilitator(NETWORK);

    @AfterEach
    void clearInterruptFlag() {
        Thread.interrupted();
    }

    private static PaymentOption option(String price) {
        return PaymentOption.builder()
                .scheme("exact")
                .network(NETWORK)
                .payTo(PAY_TO)
                .price(Price.money(price))
                .build();
    }

    private static RouteConfig route(PaymentOption... options) {
        return RouteConfig.builder()
                .accepts(List.of(options))
                .description("Current weather")
                .mimeType("application/json")
                .build();
    }

    private static X402ResourceServer resourceServer(FakeFacilitator facilitator) {
        return X402ResourceServer.builder()
                .register(NETWORK, new FakeSchemeServer("exact"))
                .facilitator(facilitator)
                .build();
    }

    private HttpResourceServer server(Map<String, RouteConfig> routes) throws Exception {
        HttpResourceServer server = new HttpResourceServer(resourceServer(facilitator), routes);
        server.initialize();
        return server;
    }

    private HttpResourceServer weatherServer() throws Exception {
        return server(Map.of("GET /weather", route(option("$0.001"))));
    }

    private HttpResourceServer server(SchemeNetworkServer scheme) throws Exception {
        X402ResourceServer resourceServer =
                X402ResourceServer.builder().register(NETWORK, scheme).facilitator(facilitator).build();
        HttpResourceServer server =
                new HttpResourceServer(resourceServer, Map.of("GET /weather", route(option("$0.001"))));
        server.initialize();
        return server;
    }

    private static PaymentRequirements weatherRequirements() {
        return new PaymentRequirements("exact", NETWORK, FakeSchemeServer.ASSET, "1000", PAY_TO, 300,
                Map.of("name", "USDC", "version", "2"));
    }

    private static String signature(PaymentRequirements accepted) {
        return PaymentHeaders.encode(new PaymentPayload(2,
                Map.of("signature", "0x01", "authorization", Map.of("from", FakeFacilitator.PAYER)),
                accepted, null, null));
    }

    private static TestRequest get(String path) {
        return new TestRequest("GET", path, null, URL, Map.of());
    }

    private static TestRequest paid(String header) {
        return new TestRequest("GET", "/weather", null, URL, Map.of("payment-signature", header));
    }

    private static HttpResponseInstructions errorOf(ProcessResult result) {
        return assertInstanceOf(ProcessResult.PaymentError.class, result).response();
    }

    private static PaymentRequired paymentRequiredOf(HttpResponseInstructions response) {
        return PaymentHeaders.decode(response.headers().get("PAYMENT-REQUIRED"), PaymentRequired.class);
    }

    private static void assert402(HttpResponseInstructions response, String error) {
        assertEquals(402, response.status());
        assertEquals("application/json", response.headers().get("Content-Type"));
        assertEquals("no-store", response.headers().get("Cache-Control"));
        assertEquals("{\"error\":\"" + error + "\"}", response.body());
        assertEquals(error, paymentRequiredOf(response).error());
    }

    @Nested
    class ProcessRequest {

        @Test
        void passesThroughRequestsThatMatchNoRoute() throws Exception {
            HttpResourceServer server = weatherServer();

            assertInstanceOf(ProcessResult.NoPaymentRequired.class, server.processRequest(get("/health")));
            assertInstanceOf(ProcessResult.NoPaymentRequired.class,
                    server.processRequest(new TestRequest("POST", "/weather", null, URL, Map.of())));
            assertEquals(0, facilitator.verifyCalls());
        }

        @Test
        void passesThroughRoutesWithoutOptionsOrExtensions() throws Exception {
            HttpResourceServer server = server(Map.of("GET /free", RouteConfig.builder().build()));

            assertInstanceOf(ProcessResult.NoPaymentRequired.class, server.processRequest(get("/free")));
        }

        @Test
        void rejectsAPathWhoseFormsMatchDifferentRoutes() throws Exception {
            Map<String, RouteConfig> routes = new LinkedHashMap<>();
            routes.put("/public/*", RouteConfig.builder().build());
            routes.put("GET /cheap/*", route(option("$0.001")));
            routes.put("GET /premium", route(option("$10")));
            HttpResourceServer server = server(routes);
            String cheapPayment = signature(weatherRequirements());

            for (String path : List.of("/public/../premium", "/public/x/../../premium", "/cheap/../premium",
                    "/cheap/%2e%2e/premium", "/cheap/..;/premium")) {
                HttpResponseInstructions response = errorOf(server.processRequest(
                        new TestRequest("GET", path, null, URL, Map.of("payment-signature", cheapPayment))));

                assertEquals(400, response.status(), path);
                assertEquals("{\"error\":\"invalid_path\"}", response.body());
                assertEquals(Map.of("Content-Type", "application/json"), response.headers());
                assertTrue(server.requiresPayment(get(path)), path);
            }
            assertEquals(0, facilitator.verifyCalls());
            assertInstanceOf(ProcessResult.NoPaymentRequired.class, server.processRequest(get("/public/x")));
            assertEquals("10000000",
                    paymentRequiredOf(errorOf(server.processRequest(get("/premium")))).accepts().get(0).amount());
        }

        @Test
        void answersAnUnpaidRequestWithTheGo402() throws Exception {
            HttpResponseInstructions response = errorOf(weatherServer().processRequest(get("/weather")));

            assert402(response, "Payment required");
            assertEquals(List.of("Content-Type", "PAYMENT-REQUIRED", "Cache-Control"),
                    List.copyOf(response.headers().keySet()));
            PaymentRequired message = paymentRequiredOf(response);
            assertEquals(2, message.x402Version());
            assertEquals(ResourceInfo.of(URL, "Current weather", "application/json"), message.resource());
            assertEquals(List.of(weatherRequirements()), message.accepts());
            assertNull(message.extensions());
        }

        @Test
        void advertisesTheConfiguredResourceAndExtensions() throws Exception {
            Map<String, Object> extensions = Map.of("bazaar", Map.of("info", Map.of("method", "GET")));
            HttpResourceServer server = server(Map.of("GET /weather", RouteConfig.builder()
                    .accept(option("$0.001"))
                    .resource("https://api.example.com/weather")
                    .extensions(extensions)
                    .build()));

            PaymentRequired message = paymentRequiredOf(errorOf(server.processRequest(get("/weather"))));

            assertEquals(ResourceInfo.of("https://api.example.com/weather", null, null), message.resource());
            assertEquals(extensions, message.extensions());
        }

        @Test
        void treatsAnEmptyPaymentHeaderAsAbsent() throws Exception {
            assert402(errorOf(weatherServer().processRequest(paid(""))), "Payment required");
        }

        static Stream<String> malformedHeaders() {
            return Stream.of(
                    "garbage-value",
                    base64("not-json"),
                    base64("[]"),
                    base64("{\"x402Version\":1}"),
                    base64("{\"x402Version\":2}"),
                    base64("{\"x402Version\":2,\"accepted\":{\"network\":\"base-sepolia\"}}"),
                    base64("{\"x402Version\":2,\"payload\":\"string\"}"));
        }

        private static String base64(String json) {
            return Base64.getEncoder().encodeToString(json.getBytes(StandardCharsets.UTF_8));
        }

        @ParameterizedTest
        @MethodSource("malformedHeaders")
        void rejectsAMalformedPaymentHeaderWith400(String header) throws Exception {
            HttpResourceServer server = weatherServer();

            HttpResponseInstructions response = errorOf(server.processRequest(paid(header)));

            assertEquals(400, response.status());
            assertEquals("{\"error\":\"invalid_payload\"}", response.body());
            assertEquals(Map.of("Content-Type", "application/json"), response.headers());
            assertEquals(0, facilitator.verifyCalls());
        }

        @Test
        void validatesThePaymentHeaderBeforeBuildingRequirements() throws Exception {
            SwitchableSchemeServer scheme = new SwitchableSchemeServer();
            HttpResourceServer server = server(scheme);
            scheme.failing = true;

            assertEquals(400, errorOf(server.processRequest(paid("garbage-value"))).status());
        }

        @Test
        void answers500WhenRequirementsCannotBeBuilt() throws Exception {
            SwitchableSchemeServer scheme = new SwitchableSchemeServer();
            HttpResourceServer server = server(scheme);
            scheme.failing = true;

            HttpResponseInstructions response = errorOf(server.processRequest(get("/weather")));

            assertEquals(500, response.status());
            assertEquals("{\"error\":\"Internal Server Error\"}", response.body());
            assertEquals("application/json", response.headers().get("Content-Type"));
        }

        @Test
        void answers402WhenThePaymentMatchesNoRequirement() throws Exception {
            PaymentRequirements cheaper = new PaymentRequirements(
                    "exact", NETWORK, FakeSchemeServer.ASSET, "1", PAY_TO, 300, Map.of("name", "USDC", "version", "2"));

            HttpResponseInstructions response = errorOf(weatherServer().processRequest(paid(signature(cheaper))));

            assert402(response, "No matching payment requirements");
            assertEquals(0, facilitator.verifyCalls());
        }

        @Test
        void verifiesAMatchingPayment() throws Exception {
            String header = signature(weatherRequirements());

            ProcessResult result = weatherServer().processRequest(paid(header));

            ProcessResult.PaymentVerified verified = assertInstanceOf(ProcessResult.PaymentVerified.class, result);
            assertEquals(weatherRequirements(), verified.requirements());
            assertEquals(PaymentHeaders.decode(header, PaymentPayload.class), verified.payload());
            assertEquals(1, facilitator.verifyCalls());
        }

        @Test
        void matchesTheOptionThePaymentChose() throws Exception {
            PaymentOption fixed = PaymentOption.builder()
                    .scheme("exact").network(NETWORK).payTo(PAY_TO)
                    .price(AssetAmount.of("42", FakeSchemeServer.ASSET))
                    .maxTimeoutSeconds(60)
                    .build();
            HttpResourceServer server = server(Map.of("GET /weather", route(option("$0.001"), fixed)));
            PaymentRequirements second =
                    new PaymentRequirements("exact", NETWORK, FakeSchemeServer.ASSET, "42", PAY_TO, 60, null);

            ProcessResult result = server.processRequest(paid(signature(second)));

            assertEquals(second, assertInstanceOf(ProcessResult.PaymentVerified.class, result).requirements());
        }

        @Test
        void reportsTheVerifyFailureReason() throws Exception {
            facilitator.onVerify((payload, requirements) ->
                    VerifyResponse.invalid("invalid_exact_evm_signature", "bad", FakeFacilitator.PAYER));

            HttpResponseInstructions response =
                    errorOf(weatherServer().processRequest(paid(signature(weatherRequirements()))));

            assert402(response, "invalid_exact_evm_signature");
            assertEquals(List.of(weatherRequirements()), paymentRequiredOf(response).accepts());
        }

        @Test
        void reportsAThrownVerifyException() throws Exception {
            facilitator.onVerify((payload, requirements) -> {
                throw new VerifyException("insufficient_funds", FakeFacilitator.PAYER, null);
            });

            assert402(errorOf(weatherServer().processRequest(paid(signature(weatherRequirements())))),
                    "insufficient_funds");
        }

        @Test
        void reportsAnExtensionEchoMismatch() throws Exception {
            HttpResourceServer server = server(Map.of("GET /weather", RouteConfig.builder()
                    .accept(option("$0.001"))
                    .extensions(Map.of("bazaar", Map.of("info", Map.of("method", "GET"))))
                    .build()));
            String header = PaymentHeaders.encode(new PaymentPayload(2, Map.of(), weatherRequirements(), null,
                    Map.of("bazaar", Map.of("info", Map.of("method", "POST")))));

            assert402(errorOf(server.processRequest(paid(header))), "extension_echo_mismatch");
        }

        @Test
        void reportsAFacilitatorTransportFailureWithItsMessage() throws Exception {
            facilitator.onVerify((payload, requirements) -> {
                throw new IOException("facilitator verify failed (503): unavailable");
            });

            assert402(errorOf(weatherServer().processRequest(paid(signature(weatherRequirements())))),
                    "facilitator verify failed (503): unavailable");
        }

        @Test
        void restoresTheInterruptFlagWhenVerificationIsInterrupted() throws Exception {
            facilitator.onVerify((payload, requirements) -> {
                throw new InterruptedException();
            });

            HttpResponseInstructions response =
                    errorOf(weatherServer().processRequest(paid(signature(weatherRequirements()))));

            assertTrue(Thread.currentThread().isInterrupted());
            assert402(response, "InterruptedException");
        }

        @Test
        void answers500WhenThePaymentRequiredHeaderCannotBeEncoded() throws Exception {
            HttpResourceServer server = server(Map.of("GET /weather", RouteConfig.builder()
                    .accept(option("$0.001"))
                    .extensions(Map.of("broken", new Object()))
                    .build()));

            assertEquals(500, errorOf(server.processRequest(get("/weather"))).status());
        }

        @Test
        void tellsWhetherARequestRequiresPayment() throws Exception {
            HttpResourceServer server = weatherServer();

            assertTrue(server.requiresPayment(get("/weather/")));
            assertTrue(server.requiresPayment(new TestRequest("GET", "/x/../weather", null, URL, Map.of())));
            assertFalse(server.requiresPayment(get("/health")));
            assertFalse(server.requiresPayment(new TestRequest("OPTIONS", "/weather", null, URL, Map.of())));
        }

        @Test
        void matchesTheFrameworkDecodedPath() throws Exception {
            HttpResourceServer server = weatherServer();

            ProcessResult result = server.processRequest(
                    new TestRequest("GET", "/weath%65r%2F", "/weather", URL, Map.of()));

            assertEquals(402, errorOf(result).status());
        }
    }

    @Nested
    class ProcessSettlement {

        private ProcessResult.PaymentVerified verified(HttpResourceServer server) {
            return assertInstanceOf(ProcessResult.PaymentVerified.class,
                    server.processRequest(paid(signature(weatherRequirements()))));
        }

        private SettleResponse paymentResponseOf(HttpResponseInstructions response) {
            return PaymentHeaders.decode(response.headers().get("PAYMENT-RESPONSE"), SettleResponse.class);
        }

        private SettlementResult.Failed failed(SettlementResult result) {
            SettlementResult.Failed failed = assertInstanceOf(SettlementResult.Failed.class, result);
            HttpResponseInstructions response = failed.response();
            assertEquals(402, response.status());
            assertEquals("{\"error\":\"settlement_failed\"}", response.body());
            assertEquals("application/json", response.headers().get("Content-Type"));
            assertEquals("no-store", response.headers().get("Cache-Control"));
            return failed;
        }

        @Test
        void returnsThePaymentResponseHeaderOnSuccess() throws Exception {
            HttpResourceServer server = weatherServer();

            SettlementResult result = server.processSettlement(verified(server));

            SettlementResult.Settled settled = assertInstanceOf(SettlementResult.Settled.class, result);
            assertEquals(SettleResponse.success(FakeFacilitator.PAYER, FakeFacilitator.TRANSACTION, NETWORK),
                    settled.settleResponse());
            assertEquals(Map.of("PAYMENT-RESPONSE", PaymentHeaders.encode(settled.settleResponse())),
                    settled.headers());
        }

        @Test
        void forwardsAReturnedFailureWithItsReceipt() throws Exception {
            facilitator.onSettle((payload, requirements) -> new SettleResponse(false, "insufficient_funds", "low",
                    FakeFacilitator.PAYER, "0xdeposit", NETWORK, "1000", Map.of("e", 1), Map.of("channelId", "0xc")));
            HttpResourceServer server = weatherServer();

            SettlementResult.Failed failed = failed(server.processSettlement(verified(server)));

            SettleResponse expected = new SettleResponse(false, "insufficient_funds", "low", FakeFacilitator.PAYER,
                    "0xdeposit", NETWORK, "1000", null, Map.of("channelId", "0xc"));
            assertEquals(expected, failed.settleResponse());
            assertEquals(expected, paymentResponseOf(failed.response()));
        }

        @Test
        void fillsTheNetworkAndTransactionOfAnIncompleteReturnedFailure() throws Exception {
            facilitator.onSettle((payload, requirements) ->
                    new SettleResponse(false, null, null, null, null, null, null, null, null));
            HttpResourceServer server = weatherServer();

            SettleResponse receipt = failed(server.processSettlement(verified(server))).settleResponse();

            assertEquals("", receipt.transaction());
            assertEquals(NETWORK, receipt.network());
            assertFalse(receipt.success());
        }

        @Test
        void keepsTheTransactionOfAPendingSettleException() throws Exception {
            String pendingTx = "0x" + "ab".repeat(32);
            facilitator.onSettle((payload, requirements) -> {
                throw new SettleException("settlement_pending", FakeFacilitator.PAYER, NETWORK, pendingTx,
                        "rpc: timeout waiting for receipt");
            });
            HttpResourceServer server = weatherServer();

            SettlementResult.Failed failed = failed(server.processSettlement(verified(server)));

            SettleResponse receipt = paymentResponseOf(failed.response());
            assertEquals("settlement_pending", receipt.errorReason());
            assertEquals("rpc: timeout waiting for receipt", receipt.errorMessage());
            assertEquals(pendingTx, receipt.transaction());
            assertEquals(FakeFacilitator.PAYER, receipt.payer());
            assertEquals(2, facilitator.settleCalls());
        }

        @Test
        void discardsTheTransactionOfATerminalSettleException() throws Exception {
            facilitator.onSettle((payload, requirements) -> {
                throw new SettleException("invalid_payment", FakeFacilitator.PAYER, "", FakeFacilitator.PAYER, null);
            });
            HttpResourceServer server = weatherServer();

            SettleResponse receipt = failed(server.processSettlement(verified(server))).settleResponse();

            assertEquals("invalid_payment", receipt.errorReason());
            assertEquals("", receipt.transaction());
            assertEquals(NETWORK, receipt.network());
        }

        @Test
        void reportsOtherProtocolFailuresByReason() throws Exception {
            facilitator.onSettle((payload, requirements) -> {
                throw new VerifyException("invalid_exact_evm_nonce_used", null, null);
            });
            HttpResourceServer server = weatherServer();

            SettleResponse receipt = failed(server.processSettlement(verified(server))).settleResponse();

            assertEquals(SettleResponse.failure("invalid_exact_evm_nonce_used", null, null, "", NETWORK), receipt);
        }

        @Test
        void reportsATransportFailureWithItsMessage() throws Exception {
            facilitator.onSettle((payload, requirements) -> {
                throw new IOException("facilitator settle failed (502): bad gateway");
            });
            HttpResourceServer server = weatherServer();

            SettleResponse receipt = failed(server.processSettlement(verified(server))).settleResponse();

            assertEquals("facilitator settle failed (502): bad gateway", receipt.errorReason());
            assertEquals("", receipt.transaction());
            assertEquals(NETWORK, receipt.network());
        }

        @Test
        void reportsAnUncheckedFacilitatorFailureWithItsMessage() throws Exception {
            facilitator.onSettle((payload, requirements) -> {
                throw new IllegalStateException("AuthHeadersProvider returned null for settle");
            });
            HttpResourceServer server = weatherServer();

            SettleResponse receipt = failed(server.processSettlement(verified(server))).settleResponse();

            assertEquals(SettleResponse.failure("AuthHeadersProvider returned null for settle", null, null, "",
                    NETWORK), receipt);
        }

        @Test
        void restoresTheInterruptFlagWhenSettlementIsInterrupted() throws Exception {
            facilitator.onSettle((payload, requirements) -> {
                throw new InterruptedException("shutting down");
            });
            HttpResourceServer server = weatherServer();

            SettleResponse receipt = failed(server.processSettlement(verified(server))).settleResponse();

            assertTrue(Thread.currentThread().isInterrupted());
            assertEquals("shutting down", receipt.errorReason());
        }

        @Test
        void failsWhenTheSuccessHeaderCannotBeEncoded() throws Exception {
            facilitator.onSettle((payload, requirements) -> new SettleResponse(true, null, null,
                    FakeFacilitator.PAYER, FakeFacilitator.TRANSACTION, NETWORK, null, null,
                    Map.of("broken", new Object())));
            HttpResourceServer server = weatherServer();

            SettlementResult.Failed failed = failed(server.processSettlement(verified(server)));

            assertTrue(failed.settleResponse().errorReason().startsWith("failed to create settlement headers"));
            assertEquals(FakeFacilitator.PAYER, paymentResponseOf(failed.response()).payer());
        }

        @Test
        void stillAnswers402WhenTheFailureHeaderCannotBeEncoded() throws Exception {
            facilitator.onSettle((payload, requirements) -> new SettleResponse(false, "boom", null, null, "",
                    NETWORK, null, null, Map.of("broken", new Object())));
            HttpResourceServer server = weatherServer();

            SettlementResult.Failed failed = failed(server.processSettlement(verified(server)));

            assertFalse(failed.response().headers().containsKey("PAYMENT-RESPONSE"));
        }
    }

    @Nested
    class Initialization {

        @Test
        void reportsEveryRouteProblem() {
            PaymentOption unregistered = PaymentOption.builder()
                    .scheme("exact").network("eip155:1").payTo(PAY_TO).price(Price.money("$1")).build();
            PaymentOption upfront = PaymentOption.builder()
                    .scheme("exact").network("eip155:8453").payTo(PAY_TO).price(Price.money("$1"))
                    .extra(Map.of("paymentFlow", "upfront")).build();
            X402ResourceServer resourceServer = X402ResourceServer.builder()
                    .register(NETWORK, new FakeSchemeServer("exact"))
                    .register("eip155:8453", new FakeSchemeServer("exact"))
                    .facilitator(facilitator)
                    .build();
            Map<String, RouteConfig> routes = new LinkedHashMap<>();
            routes.put("GET /ok", route(option("$1")));
            routes.put("GET /bad", route(unregistered, upfront));
            HttpResourceServer server = new HttpResourceServer(resourceServer, routes);

            RouteConfigurationException error = assertThrows(RouteConfigurationException.class, server::initialize);

            assertEquals(List.of(
                    RouteConfigurationException.MISSING_SCHEME,
                    RouteConfigurationException.UNSUPPORTED_PAYMENT_FLOW,
                    RouteConfigurationException.MISSING_FACILITATOR),
                    error.problems().stream().map(RouteConfigurationException.Problem::reason).toList());
            assertEquals("GET /bad", error.problems().get(0).route());
            assertEquals("eip155:1", error.problems().get(0).network());
            assertTrue(error.getMessage().contains("No scheme implementation registered for \"exact\" on network"
                    + " \"eip155:1\""));
            assertTrue(error.getMessage().contains("Facilitator does not support scheme \"exact\" on network"
                    + " \"eip155:8453\""));
            assertFalse(server.isInitialized());
        }

        @Test
        void acceptsAnExplicitAuthorizationFlow() throws Exception {
            PaymentOption authorization = PaymentOption.builder()
                    .scheme("exact").network(NETWORK).payTo(PAY_TO).price(Price.money("$1"))
                    .extra(Map.of("paymentFlow", "authorization")).build();

            assertTrue(server(Map.of("GET /a", route(authorization))).isInitialized());
        }

        @Test
        void buildsEveryOptionSoTheSchemeRejectsBadConfigurationAtStartup() {
            PaymentOption unknownAsset = PaymentOption.builder()
                    .scheme("exact").network(NETWORK).payTo(PAY_TO).price(Price.money("1 DAI")).build();
            PaymentOption permit2 = PaymentOption.builder()
                    .scheme("exact").network(NETWORK).payTo(PAY_TO).price(Price.money("$0.001"))
                    .extra(Map.of("assetTransferMethod", "permit2")).build();
            X402ResourceServer resourceServer = X402ResourceServer.builder()
                    .register(NETWORK, new ExactEvmServerScheme())
                    .facilitator(facilitator)
                    .build();
            Map<String, RouteConfig> routes = new LinkedHashMap<>();
            routes.put("GET /dai", route(unknownAsset));
            routes.put("GET /permit2", route(permit2));
            routes.put("GET /ok", route(option("$0.001")));
            HttpResourceServer server = new HttpResourceServer(resourceServer, routes);

            RouteConfigurationException error = assertThrows(RouteConfigurationException.class, server::initialize);

            assertEquals(List.of("GET /dai", "GET /permit2"),
                    error.problems().stream().map(RouteConfigurationException.Problem::route).toList());
            for (RouteConfigurationException.Problem problem : error.problems()) {
                assertEquals(RouteConfigurationException.INVALID_PAYMENT_OPTION, problem.reason());
                assertTrue(problem.message().startsWith(
                        "Route \"" + problem.route() + "\": Cannot build payment requirements: "), problem.message());
            }
            assertTrue(error.problems().get(1).message().contains("permit2"));
            assertFalse(server.isInitialized());
        }

        @Test
        void initializesOnTheFirstPaidRequestAfterAFailedStartup() throws Exception {
            FacilitatorClient flaky = mock(FacilitatorClient.class);
            when(flaky.supported()).thenThrow(new IOException("unreachable")).thenReturn(facilitator.supported());
            HttpResourceServer server = lazyServer(flaky, new AtomicLong());
            assertThrows(IOException.class, server::initialize);

            assertInstanceOf(ProcessResult.NoPaymentRequired.class, server.processRequest(get("/health")));
            assertInstanceOf(ProcessResult.NoPaymentRequired.class, server.processRequest(get("/free")));
            verify(flaky, times(1)).supported();

            assert402(errorOf(server.processRequest(get("/weather"))), "Payment required");
            assertTrue(server.isInitialized());
            server.processRequest(get("/weather"));
            verify(flaky, times(2)).supported();
        }

        @Test
        void retriesInitializationFiveSecondsAfterTheFailedAttemptEnds() throws Exception {
            AtomicLong clock = new AtomicLong();
            FacilitatorClient down = mock(FacilitatorClient.class);
            when(down.supported()).thenAnswer(invocation -> {
                clock.addAndGet(TimeUnit.SECONDS.toNanos(90));
                throw new IOException("unreachable");
            });
            HttpResourceServer server = lazyServer(down, clock);

            assert503(server.processRequest(get("/weather")));
            clock.addAndGet(TimeUnit.SECONDS.toNanos(5) - 1);
            assert503(server.processRequest(get("/weather")));
            verify(down, times(1)).supported();

            clock.addAndGet(1);
            assert503(server.processRequest(get("/weather")));
            verify(down, times(2)).supported();
            assertFalse(server.isInitialized());
        }

        @Test
        void answers503WithoutWaitingWhileAnotherRequestInitializes() throws Exception {
            CountDownLatch entered = new CountDownLatch(1);
            CountDownLatch release = new CountDownLatch(1);
            FacilitatorClient slow = mock(FacilitatorClient.class);
            when(slow.supported()).thenAnswer(invocation -> {
                entered.countDown();
                release.await();
                return facilitator.supported();
            });
            HttpResourceServer server = lazyServer(slow, new AtomicLong());
            CompletableFuture<ProcessResult> first = CompletableFuture.supplyAsync(
                    () -> server.processRequest(get("/weather")));
            assertTrue(entered.await(10, TimeUnit.SECONDS));

            assert503(server.processRequest(get("/weather")));
            release.countDown();

            assert402(errorOf(first.get(10, TimeUnit.SECONDS)), "Payment required");
            verify(slow, times(1)).supported();
        }

        @Test
        void answers500WhenRequestTimeInitializationFindsARouteProblem() throws Exception {
            FacilitatorClient other = mock(FacilitatorClient.class);
            when(other.supported()).thenReturn(new FakeFacilitator("eip155:8453").supported());
            HttpResourceServer server = lazyServer(other, new AtomicLong());

            HttpResponseInstructions response = errorOf(server.processRequest(get("/weather")));

            assertEquals(500, response.status());
            assertEquals("{\"error\":\"Internal Server Error\"}", response.body());
            assertEquals(response, errorOf(server.processRequest(get("/weather"))));
            verify(other, times(1)).supported();
            assertFalse(server.isInitialized());
        }

        @Test
        void restoresTheInterruptFlagWhenRequestTimeInitializationIsInterrupted() throws Exception {
            FacilitatorClient interrupted = mock(FacilitatorClient.class);
            when(interrupted.supported()).thenThrow(new InterruptedException());
            HttpResourceServer server = lazyServer(interrupted, new AtomicLong());

            assert503(server.processRequest(get("/weather")));

            assertTrue(Thread.currentThread().isInterrupted());
        }

        private HttpResourceServer lazyServer(FacilitatorClient client, AtomicLong clock) {
            X402ResourceServer resourceServer = X402ResourceServer.builder()
                    .register(NETWORK, new FakeSchemeServer("exact"))
                    .facilitator(client)
                    .build();
            Map<String, RouteConfig> routes = new LinkedHashMap<>();
            routes.put("GET /free", RouteConfig.builder().build());
            routes.put("GET /weather", route(option("$0.001")));
            return new HttpResourceServer(resourceServer, routes, clock::get);
        }

        private void assert503(ProcessResult result) {
            HttpResponseInstructions response = errorOf(result);
            assertEquals(503, response.status());
            assertEquals("{\"error\":\"facilitator_unavailable\"}", response.body());
            assertEquals(Map.of("Content-Type", "application/json", "Cache-Control", "no-store"),
                    response.headers());
        }

        @Test
        void propagatesFacilitatorFailures() throws Exception {
            FacilitatorClient unreachable = mock(FacilitatorClient.class);
            when(unreachable.supported()).thenThrow(new IOException("unreachable"));
            X402ResourceServer resourceServer = X402ResourceServer.builder().facilitator(unreachable).build();
            HttpResourceServer server = new HttpResourceServer(resourceServer, Map.of());

            assertThrows(IOException.class, server::initialize);
            assertFalse(server.isInitialized());
            assertSame(resourceServer, server.resourceServer());
        }

        @Test
        void rejectsMalformedRoutePatternsAtConstruction() {
            X402ResourceServer resourceServer = resourceServer(facilitator);

            assertThrows(IllegalArgumentException.class,
                    () -> new HttpResourceServer(resourceServer, Map.of("GET /a /b", route())));
        }
    }

    /** Vectors from {@code TestWithPrivateCacheControl} in {@code go/http/server_test.go}. */
    @ParameterizedTest(name = "\"{0}\" -> \"{1}\"")
    @CsvSource(delimiter = '|', value = {
        "''|private",
        "max-age=60|max-age=60, private",
        "max-age=60, private|max-age=60, private",
        "max-age=60, Private|max-age=60, Private",
    })
    void mergesPrivateIntoCacheControl(String input, String expected) {
        assertEquals(expected, HttpResourceServer.withPrivateCacheControl(input));
    }

    @Test
    void treatsAMissingCacheControlAsEmpty() {
        assertEquals("private", HttpResourceServer.withPrivateCacheControl(null));
    }

    /** Scheme server that prices like {@link FakeSchemeServer} until a test sets {@link #failing}. */
    private static final class SwitchableSchemeServer implements SchemeNetworkServer {

        private final FakeSchemeServer delegate = new FakeSchemeServer("exact");
        private volatile boolean failing;

        @Override
        public String scheme() {
            return delegate.scheme();
        }

        @Override
        public AssetAmount parsePrice(Price price, String network) {
            if (failing) {
                throw new IllegalArgumentException("price feed unavailable");
            }
            return delegate.parsePrice(price, network);
        }

        @Override
        public PaymentRequirements enhancePaymentRequirements(
                PaymentRequirements requirements, SupportedKind supportedKind) {
            return delegate.enhancePaymentRequirements(requirements, supportedKind);
        }
    }

    /** Request adapter backed by plain values; header names are matched case-insensitively. */
    private record TestRequest(String method, String path, String decoded, String url, Map<String, String> headers)
            implements HttpRequestAdapter {

        @Override
        public Optional<String> decodedPath() {
            return Optional.ofNullable(decoded);
        }

        @Override
        public Optional<String> header(String name) {
            return headers.entrySet().stream()
                    .filter(entry -> entry.getKey().toLowerCase(Locale.ROOT).equals(name.toLowerCase(Locale.ROOT)))
                    .map(Map.Entry::getValue)
                    .findFirst();
        }
    }
}
