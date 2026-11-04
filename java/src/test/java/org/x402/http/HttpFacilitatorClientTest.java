package org.x402.http;

import org.x402.SettleException;
import org.x402.VerifyException;
import org.x402.http.AuthHeadersProvider.Endpoint;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequirements;
import org.x402.types.ResourceInfo;
import org.x402.types.SettleResponse;
import org.x402.types.SupportedKind;
import org.x402.types.SupportedResponse;
import org.x402.types.VerifyResponse;
import org.x402.util.Json;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.client.ResponseDefinitionBuilder;
import com.github.tomakehurst.wiremock.stubbing.Scenario;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.mockito.ArgumentMatchers;

import java.io.IOException;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandler;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.equalToJson;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.matchingJsonPath;
import static com.github.tomakehurst.wiremock.client.WireMock.okJson;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.status;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.options;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class HttpFacilitatorClientTest {

    private static final WireMockServer WIREMOCK = new WireMockServer(options().dynamicPort());

    // Fixtures from the facilitator API examples in specs/x402-specification-v2.md section 7.
    private static final String NETWORK = "eip155:84532";
    private static final String PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
    private static final String PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
    private static final String TRANSACTION = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

    private static final PaymentRequirements REQUIREMENTS = new PaymentRequirements("exact", NETWORK,
            "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "10000", PAY_TO, 60,
            Map.of("name", "USDC", "version", "2"));

    private static final PaymentPayload PAYLOAD = new PaymentPayload(2,
            Map.of("signature", "0x...", "authorization", Map.of(
                    "from", "0x...",
                    "to", "0x...",
                    "value", "10000",
                    "validAfter", "1740672089",
                    "validBefore", "1740672154",
                    "nonce", "0x...")),
            REQUIREMENTS,
            ResourceInfo.of("https://api.example.com/premium-data", "Access to premium market data",
                    "application/json"),
            null);

    /** Section 7.1 "Example with actual data", which is also the {@code /settle} request body. */
    private static final String SPEC_REQUEST = """
            {
              "x402Version": 2,
              "paymentPayload": {
                "x402Version": 2,
                "resource": {
                  "url": "https://api.example.com/premium-data",
                  "description": "Access to premium market data",
                  "mimeType": "application/json"
                },
                "accepted": {
                  "scheme": "exact",
                  "network": "eip155:84532",
                  "amount": "10000",
                  "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                  "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
                  "maxTimeoutSeconds": 60,
                  "extra": {
                    "name": "USDC",
                    "version": "2"
                  }
                },
                "payload": {
                  "signature": "0x...",
                  "authorization": {
                    "from": "0x...",
                    "to": "0x...",
                    "value": "10000",
                    "validAfter": "1740672089",
                    "validBefore": "1740672154",
                    "nonce": "0x..."
                  }
                }
              },
              "paymentRequirements": {
                "scheme": "exact",
                "network": "eip155:84532",
                "amount": "10000",
                "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
                "maxTimeoutSeconds": 60,
                "extra": {
                  "name": "USDC",
                  "version": "2"
                }
              }
            }
            """;

    /** Section 7.3 response. */
    private static final String SPEC_SUPPORTED = """
            {
              "kinds": [
                {"x402Version": 2, "scheme": "exact", "network": "eip155:84532"},
                {"x402Version": 2, "scheme": "exact", "network": "eip155:8453"},
                {"x402Version": 2, "scheme": "exact", "network": "eip155:43113"},
                {"x402Version": 2, "scheme": "exact", "network": "eip155:43114"}
              ],
              "extensions": [],
              "signers": {
                "eip155:*": ["0x1234567890abcdef1234567890abcdef12345678"],
                "solana:*": ["CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"]
              }
            }
            """;

    private final List<Duration> sleeps = new CopyOnWriteArrayList<>();

    @BeforeAll
    static void startWireMock() {
        WIREMOCK.start();
    }

    @AfterAll
    static void stopWireMock() {
        WIREMOCK.stop();
    }

    @BeforeEach
    void resetWireMock() {
        WIREMOCK.resetAll();
    }

    // ---------------------------------------------------------------- verify

    @Test
    void verifyPostsTheSpecifiedRequestBody() throws Exception {
        WIREMOCK.stubFor(post("/verify").willReturn(okJson("{\"isValid\":true,\"payer\":\"" + PAYER + "\"}")));

        client().build().verify(PAYLOAD, REQUIREMENTS);

        WIREMOCK.verify(1, postRequestedFor(urlEqualTo("/verify"))
                .withHeader("Content-Type", equalTo("application/json"))
                .withRequestBody(equalToJson(SPEC_REQUEST))
                .withRequestBody(matchingJsonPath("$.x402Version", equalTo("2")))
                .withRequestBody(matchingJsonPath("$.paymentPayload.accepted.scheme", equalTo("exact")))
                .withRequestBody(matchingJsonPath("$.paymentRequirements.payTo", equalTo(PAY_TO))));
    }

    @Test
    void defaultHttpClientPostsHttp11WithoutAnH2cUpgrade() throws Exception {
        WIREMOCK.stubFor(post("/verify").willReturn(okJson("{\"isValid\":true,\"payer\":\"" + PAYER + "\"}")));

        client().build().verify(PAYLOAD, REQUIREMENTS);

        // HTTP/1.1-only servers such as uvicorn drop the body of a request that asks for an h2c upgrade.
        WIREMOCK.verify(1, postRequestedFor(urlEqualTo("/verify"))
                .withHeader("Upgrade", absent())
                .withHeader("HTTP2-Settings", absent())
                .withRequestBody(equalToJson(SPEC_REQUEST)));
    }

    @Test
    void verifyReturnsAValidVerdict() throws Exception {
        WIREMOCK.stubFor(post("/verify").willReturn(okJson("{\"isValid\":true,\"payer\":\"" + PAYER + "\"}")));

        VerifyResponse response = client().build().verify(PAYLOAD, REQUIREMENTS);

        assertEquals(VerifyResponse.valid(PAYER), response);
    }

    @Test
    void verifyReturnsAnInvalidVerdictReportedWithStatus200() throws Exception {
        WIREMOCK.stubFor(post("/verify").willReturn(okJson(
                "{\"isValid\":false,\"invalidReason\":\"insufficient_funds\",\"payer\":\"" + PAYER + "\"}")));

        VerifyResponse response = client().build().verify(PAYLOAD, REQUIREMENTS);

        assertEquals(VerifyResponse.invalid("insufficient_funds", null, PAYER), response);
    }

    @Test
    void verifyMapsAnErrorStatusWithInvalidReasonToVerifyException() {
        // Body from Go TestHTTPFacilitatorClient400WithValidResponse.
        WIREMOCK.stubFor(post("/verify").willReturn(aResponse().withStatus(400)
                .withBody("{\"isValid\":false,\"invalidReason\":\"invalid_signature\",\"payer\":\"0xpayer\","
                        + "\"invalidMessage\":\"signature does not recover to from\"}")));

        VerifyException e = assertThrows(VerifyException.class, () -> client().build().verify(PAYLOAD, REQUIREMENTS));

        assertEquals("invalid_signature", e.reason());
        assertEquals("0xpayer", e.payer());
        assertEquals("signature does not recover to from", e.invalidMessage());
    }

    @ParameterizedTest
    @ValueSource(strings = {"Bad request", "{\"isValid\":false}", "{\"invalidReason\":\"\"}", "[\"invalid\"]"})
    void verifyMapsAnErrorStatusWithoutInvalidReasonToIOException(String body) {
        WIREMOCK.stubFor(post("/verify").willReturn(aResponse().withStatus(400).withBody(body)));

        IOException e = assertThrows(IOException.class, () -> client().build().verify(PAYLOAD, REQUIREMENTS));

        assertEquals("Facilitator verify failed (HTTP 400): " + body, e.getMessage());
    }

    @ParameterizedTest
    @ValueSource(strings = {"{\"isValid\":", "not json", ""})
    void verifyRejectsMalformedJson(String body) {
        WIREMOCK.stubFor(post("/verify").willReturn(okJson(body)));

        IOException e = assertThrows(IOException.class, () -> client().build().verify(PAYLOAD, REQUIREMENTS));

        assertTrue(e.getMessage().startsWith("Facilitator verify returned invalid JSON: "), e.getMessage());
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "{\"payer\":\"0x857b06519E91e3A54538791bDbb0E22373e36b66\"}",
        "{\"isValid\":\"true\"}",
        "{\"isValid\":null}",
        "{\"isValid\":true,\"payer\":{}}",
        "[{\"isValid\":true}]",
        "\"isValid\"",
        "null"
    })
    void verifyRejectsSuccessBodiesWithoutAValidVerdict(String body) {
        WIREMOCK.stubFor(post("/verify").willReturn(okJson(body)));

        IOException e = assertThrows(IOException.class, () -> client().build().verify(PAYLOAD, REQUIREMENTS));

        assertTrue(e.getMessage().startsWith("Facilitator verify returned invalid data"), e.getMessage());
    }

    // ---------------------------------------------------------------- settle

    @Test
    void settlePostsTheSpecifiedRequestBodyAndParsesTheResult() throws Exception {
        WIREMOCK.stubFor(post("/settle").willReturn(okJson("{\"success\":true,\"payer\":\"" + PAYER
                + "\",\"transaction\":\"" + TRANSACTION + "\",\"network\":\"" + NETWORK + "\"}")));

        SettleResponse response = client().build().settle(PAYLOAD, REQUIREMENTS);

        assertEquals(SettleResponse.success(PAYER, TRANSACTION, NETWORK), response);
        WIREMOCK.verify(1, postRequestedFor(urlEqualTo("/settle"))
                .withHeader("Content-Type", equalTo("application/json"))
                .withRequestBody(equalToJson(SPEC_REQUEST)));
    }

    @Test
    void settleReturnsAFailureReportedWithStatus200() throws Exception {
        WIREMOCK.stubFor(post("/settle").willReturn(okJson("{\"success\":false,\"errorReason\":\"insufficient_funds\","
                + "\"payer\":\"" + PAYER + "\",\"transaction\":\"\",\"network\":\"" + NETWORK + "\"}")));

        SettleResponse response = client().build().settle(PAYLOAD, REQUIREMENTS);

        assertEquals(SettleResponse.failure("insufficient_funds", null, PAYER, "", NETWORK), response);
    }

    @Test
    void settleMapsAnErrorStatusWithErrorReasonToSettleException() {
        // Body from Go TestHTTPFacilitatorClient400WithValidResponse; transaction is absent.
        WIREMOCK.stubFor(post("/settle").willReturn(aResponse().withStatus(400).withBody(
                "{\"success\":false,\"errorReason\":\"insufficient_allowance\",\"network\":\"eip155:1\","
                        + "\"payer\":\"0xpayer\"}")));

        SettleException e = assertThrows(SettleException.class, () -> client().build().settle(PAYLOAD, REQUIREMENTS));

        assertEquals("insufficient_allowance", e.reason());
        assertEquals("0xpayer", e.payer());
        assertEquals("eip155:1", e.network());
        assertEquals("", e.transaction());
        assertEquals("facilitator returned 400", e.errorMessage());
    }

    @Test
    void settleExceptionKeepsTheFacilitatorErrorMessageAndTransaction() {
        WIREMOCK.stubFor(post("/settle").willReturn(aResponse().withStatus(500).withBody(
                "{\"success\":false,\"errorReason\":\"settlement_pending\",\"errorMessage\":\"receipt timeout\","
                        + "\"transaction\":\"" + TRANSACTION + "\",\"network\":\"" + NETWORK + "\"}")));

        SettleException e = assertThrows(SettleException.class, () -> client().build().settle(PAYLOAD, REQUIREMENTS));

        assertEquals("settlement_pending", e.reason());
        assertNull(e.payer());
        assertEquals(TRANSACTION, e.transaction());
        assertEquals(NETWORK, e.network());
        assertEquals("facilitator returned 500: receipt timeout", e.errorMessage());
    }

    @Test
    void settleMapsAnErrorStatusWithoutErrorReasonToIOException() {
        WIREMOCK.stubFor(post("/settle").willReturn(aResponse().withStatus(502)
                .withBody("<html>\n  <body>Bad Gateway</body>\n</html>")));

        IOException e = assertThrows(IOException.class, () -> client().build().settle(PAYLOAD, REQUIREMENTS));

        assertEquals("Facilitator settle failed (HTTP 502): <html> <body>Bad Gateway</body> </html>", e.getMessage());
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "{\"success\": true}",
        "{\"success\":true,\"transaction\":\"0x1\"}",
        "{\"success\":true,\"network\":\"eip155:84532\"}",
        "{\"success\":true,\"transaction\":null,\"network\":\"eip155:84532\"}",
        "{\"success\":\"true\",\"transaction\":\"0x1\",\"network\":\"eip155:84532\"}",
        "{\"success\":true,\"transaction\":\"0x1\",\"network\":84532}",
        "{\"success\":true,\"transaction\":\"0x1\",\"network\":\"eip155:84532\",\"extra\":\"x\"}"
    })
    void settleRejectsSuccessBodiesWithoutRequiredFields(String body) {
        WIREMOCK.stubFor(post("/settle").willReturn(okJson(body)));

        IOException e = assertThrows(IOException.class, () -> client().build().settle(PAYLOAD, REQUIREMENTS));

        assertTrue(e.getMessage().startsWith("Facilitator settle returned invalid data"), e.getMessage());
    }

    @Test
    void settleRejectsMalformedJson() {
        WIREMOCK.stubFor(post("/settle").willReturn(okJson("{\"success\":true,")));

        IOException e = assertThrows(IOException.class, () -> client().build().settle(PAYLOAD, REQUIREMENTS));

        assertTrue(e.getMessage().startsWith("Facilitator settle returned invalid JSON"), e.getMessage());
    }

    // ---------------------------------------------------------------- supported

    @Test
    void supportedGetsAndParsesTheSpecifiedResponse() throws Exception {
        WIREMOCK.stubFor(get("/supported").willReturn(okJson(SPEC_SUPPORTED)));

        SupportedResponse response = client().build().supported();

        assertEquals(new SupportedResponse(
                List.of(
                        new SupportedKind(2, "exact", "eip155:84532", null),
                        new SupportedKind(2, "exact", "eip155:8453", null),
                        new SupportedKind(2, "exact", "eip155:43113", null),
                        new SupportedKind(2, "exact", "eip155:43114", null)),
                List.of(),
                Map.of(
                        "eip155:*", List.of("0x1234567890abcdef1234567890abcdef12345678"),
                        "solana:*", List.of("CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"))),
                response);
        WIREMOCK.verify(1, getRequestedFor(urlEqualTo("/supported"))
                .withHeader("Content-Type", equalTo("application/json")));
        assertTrue(sleeps.isEmpty());
    }

    @Test
    void supportedDefaultsAbsentCollectionsToEmpty() throws Exception {
        WIREMOCK.stubFor(get("/supported").willReturn(okJson(
                "{\"kinds\":[{\"x402Version\":2,\"scheme\":\"exact\",\"network\":\"eip155:84532\","
                        + "\"extra\":{\"assetTransferMethod\":\"eip3009\"}}]}")));

        SupportedResponse response = client().build().supported();

        assertEquals(List.of(new SupportedKind(2, "exact", NETWORK, Map.of("assetTransferMethod", "eip3009"))),
                response.kinds());
        assertEquals(List.of(), response.extensions());
        assertEquals(Map.of(), response.signers());
    }

    @ParameterizedTest
    @ValueSource(strings = {"{}", "{\"kinds\":null,\"extensions\":null,\"signers\":null}"})
    void supportedTreatsAbsentKindsAsNone(String body) throws Exception {
        WIREMOCK.stubFor(get("/supported").willReturn(okJson(body)));

        assertEquals(new SupportedResponse(List.of(), List.of(), Map.of()), client().build().supported());
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "{\"kinds\":[{\"scheme\":\"exact\"}]}",
        "{\"kinds\":{\"x402Version\":2,\"scheme\":\"exact\",\"network\":\"eip155:84532\"}}",
        "{\"kinds\":[\"exact\"]}",
        "{\"kinds\":[{\"x402Version\":\"2\",\"scheme\":\"exact\",\"network\":\"eip155:84532\"}]}",
        "{\"kinds\":[{\"x402Version\":2.5,\"scheme\":\"exact\",\"network\":\"eip155:84532\"}]}",
        "{\"kinds\":[{\"x402Version\":4294967298,\"scheme\":\"exact\",\"network\":\"eip155:84532\"}]}",
        "{\"kinds\":[{\"x402Version\":2,\"scheme\":\"\",\"network\":\"eip155:84532\"}]}",
        "{\"kinds\":[{\"x402Version\":2,\"scheme\":\"exact\"}]}",
        "{\"kinds\":[],\"signers\":{\"eip155:*\":\"0x1234567890abcdef1234567890abcdef12345678\"}}",
        "[]"
    })
    void supportedRejectsInvalidData(String body) {
        WIREMOCK.stubFor(get("/supported").willReturn(okJson(body)));

        IOException e = assertThrows(IOException.class, () -> client().build().supported());

        assertTrue(e.getMessage().startsWith("Facilitator supported returned invalid data"), e.getMessage());
    }

    @Test
    void supportedRetriesRateLimitedRequestsWithExponentialBackoff() throws Exception {
        stubSupportedSequence(status(429).withBody("slow down"), status(429), okJson(SPEC_SUPPORTED));

        SupportedResponse response = client().build().supported();

        assertEquals(4, response.kinds().size());
        assertEquals(List.of(Duration.ofSeconds(1), Duration.ofSeconds(2)), sleeps);
        WIREMOCK.verify(3, getRequestedFor(urlEqualTo("/supported")));
    }

    @Test
    void supportedGivesUpAfterThreeRateLimitedAttempts() {
        WIREMOCK.stubFor(get("/supported").willReturn(status(429).withBody("rate limit exceeded")));

        IOException e = assertThrows(IOException.class, () -> client().build().supported());

        assertEquals("Facilitator supported failed (HTTP 429): rate limit exceeded", e.getMessage());
        assertEquals(List.of(Duration.ofSeconds(1), Duration.ofSeconds(2)), sleeps);
        WIREMOCK.verify(3, getRequestedFor(urlEqualTo("/supported")));
    }

    @Test
    void supportedDoesNotRetryOtherErrors() {
        WIREMOCK.stubFor(get("/supported").willReturn(status(503).withBody("maintenance")));

        IOException e = assertThrows(IOException.class, () -> client().build().supported());

        assertEquals("Facilitator supported failed (HTTP 503): maintenance", e.getMessage());
        assertTrue(sleeps.isEmpty());
        WIREMOCK.verify(1, getRequestedFor(urlEqualTo("/supported")));
    }

    @Test
    void supportedStopsWhenInterruptedDuringBackoff() {
        WIREMOCK.stubFor(get("/supported").willReturn(status(429)));
        HttpFacilitatorClient client = client().sleeper(delay -> {
            throw new InterruptedException("shutdown");
        }).build();

        assertThrows(InterruptedException.class, client::supported);
        WIREMOCK.verify(1, getRequestedFor(urlEqualTo("/supported")));
    }

    // ---------------------------------------------------------------- auth headers

    @Test
    void authHeadersAreAppliedPerEndpoint() throws Exception {
        WIREMOCK.stubFor(post("/verify").willReturn(okJson("{\"isValid\":true}")));
        WIREMOCK.stubFor(post("/settle").willReturn(okJson("{\"success\":true,\"transaction\":\"" + TRANSACTION
                + "\",\"network\":\"" + NETWORK + "\"}")));
        WIREMOCK.stubFor(get("/supported").willReturn(okJson(SPEC_SUPPORTED)));
        AuthHeadersProvider auth = endpoint -> endpoint == Endpoint.SUPPORTED
                ? Map.of()
                : Map.of("Authorization", "Bearer " + endpoint.name().toLowerCase(Locale.ROOT),
                        "X-Request-Path", endpoint.path());
        HttpFacilitatorClient client = client().authHeadersProvider(auth).build();

        client.verify(PAYLOAD, REQUIREMENTS);
        client.settle(PAYLOAD, REQUIREMENTS);
        client.supported();

        WIREMOCK.verify(postRequestedFor(urlEqualTo("/verify"))
                .withHeader("Authorization", equalTo("Bearer verify"))
                .withHeader("X-Request-Path", equalTo("/verify")));
        WIREMOCK.verify(postRequestedFor(urlEqualTo("/settle"))
                .withHeader("Authorization", equalTo("Bearer settle"))
                .withHeader("X-Request-Path", equalTo("/settle")));
        WIREMOCK.verify(getRequestedFor(urlEqualTo("/supported"))
                .withHeader("Authorization", absent()));
    }

    @Test
    void authHeadersReplaceTheDefaultContentType() throws Exception {
        WIREMOCK.stubFor(post("/verify").willReturn(okJson("{\"isValid\":true}")));
        HttpFacilitatorClient client = client()
                .authHeadersProvider(endpoint -> Map.of("Content-Type", "application/vnd.example+json"))
                .build();

        client.verify(PAYLOAD, REQUIREMENTS);

        WIREMOCK.verify(postRequestedFor(urlEqualTo("/verify"))
                .withHeader("Content-Type", equalTo("application/vnd.example+json")));
    }

    @Test
    void authHeadersAreRequestedForEveryAttempt() throws Exception {
        stubSupportedSequence(status(429), status(429), okJson(SPEC_SUPPORTED));
        List<Endpoint> calls = new CopyOnWriteArrayList<>();
        HttpFacilitatorClient client = client().authHeadersProvider(endpoint -> {
            calls.add(endpoint);
            return Map.of("Authorization", "Bearer token-" + calls.size());
        }).build();

        client.supported();

        assertEquals(List.of(Endpoint.SUPPORTED, Endpoint.SUPPORTED, Endpoint.SUPPORTED), calls);
        WIREMOCK.verify(1, getRequestedFor(urlEqualTo("/supported"))
                .withHeader("Authorization", equalTo("Bearer token-3")));
    }

    @Test
    void authHeadersFailureAbortsTheRequest() {
        IOException failure = new IOException("token endpoint unreachable");
        HttpFacilitatorClient client = client().authHeadersProvider(endpoint -> {
            throw failure;
        }).build();

        assertSame(failure, assertThrows(IOException.class, () -> client.verify(PAYLOAD, REQUIREMENTS)));
        assertEquals(0, WIREMOCK.getAllServeEvents().size());
    }

    @Test
    void nullAuthHeadersAreRejected() {
        HttpFacilitatorClient client = client().authHeadersProvider(endpoint -> null).build();

        IllegalStateException e =
                assertThrows(IllegalStateException.class, () -> client.settle(PAYLOAD, REQUIREMENTS));

        assertEquals("AuthHeadersProvider returned null headers for SETTLE", e.getMessage());
        assertEquals(0, WIREMOCK.getAllServeEvents().size());
    }

    @Test
    void restrictedAuthHeadersAreRejected() {
        HttpFacilitatorClient client = client().authHeadersProvider(endpoint -> Map.of("Host", "evil.example"))
                .build();

        assertThrows(IllegalArgumentException.class, () -> client.verify(PAYLOAD, REQUIREMENTS));
        assertEquals(0, WIREMOCK.getAllServeEvents().size());
    }

    @Test
    void endpointsExposeTheirMethodAndPath() {
        assertEquals("POST", Endpoint.VERIFY.method());
        assertEquals("/verify", Endpoint.VERIFY.path());
        assertEquals("POST", Endpoint.SETTLE.method());
        assertEquals("/settle", Endpoint.SETTLE.path());
        assertEquals("GET", Endpoint.SUPPORTED.method());
        assertEquals("/supported", Endpoint.SUPPORTED.path());
    }

    // ---------------------------------------------------------------- transport

    @Test
    void slowResponsesTimeOut() {
        WIREMOCK.stubFor(post("/verify").willReturn(okJson("{\"isValid\":true}").withFixedDelay(2_000)));
        HttpFacilitatorClient client = client().timeout(Duration.ofMillis(200)).build();

        assertThrows(HttpTimeoutException.class, () -> client.verify(PAYLOAD, REQUIREMENTS));
    }

    @Test
    void interruptingAnInFlightRequestThrowsInterruptedException() throws Exception {
        WIREMOCK.stubFor(post("/verify").willReturn(okJson("{\"isValid\":true}").withFixedDelay(3_000)));
        HttpFacilitatorClient client = client().build();
        AtomicReference<Throwable> thrown = new AtomicReference<>();
        Thread caller = new Thread(() -> {
            try {
                client.verify(PAYLOAD, REQUIREMENTS);
            } catch (Exception e) {
                thrown.set(e);
            }
        });

        caller.start();
        awaitFirstRequest();
        caller.interrupt();
        caller.join(2_000);

        assertFalse(caller.isAlive(), "verify kept waiting after the interrupt");
        assertInstanceOf(InterruptedException.class, thrown.get());
    }

    @Test
    void interruptionCancelsTheExchangeAndIsPropagated() {
        HttpClient http = mock(HttpClient.class);
        List<CompletableFuture<HttpResponse<byte[]>>> exchanges = new CopyOnWriteArrayList<>();
        when(http.sendAsync(any(HttpRequest.class), ArgumentMatchers.<BodyHandler<byte[]>>any())).thenAnswer(call -> {
            CompletableFuture<HttpResponse<byte[]>> never = new CompletableFuture<>();
            exchanges.add(never);
            return never;
        });
        HttpFacilitatorClient client = HttpFacilitatorClient.builder().httpClient(http).build();

        try {
            Thread.currentThread().interrupt();
            assertThrows(InterruptedException.class, () -> client.verify(PAYLOAD, REQUIREMENTS));
            Thread.currentThread().interrupt();
            assertThrows(InterruptedException.class, () -> client.settle(PAYLOAD, REQUIREMENTS));
            Thread.currentThread().interrupt();
            assertThrows(InterruptedException.class, client::supported);
        } finally {
            Thread.interrupted();
        }

        assertEquals(3, exchanges.size());
        assertTrue(exchanges.stream().allMatch(CompletableFuture::isCancelled));
    }

    @Test
    void timeoutCoversAResponseBodyThatStalls() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            new Thread(() -> sendHeadersThenStall(server, release)).start();
            HttpFacilitatorClient client = HttpFacilitatorClient.builder()
                    .url("http://127.0.0.1:" + server.getLocalPort())
                    .timeout(Duration.ofMillis(300))
                    .build();
            long start = System.nanoTime();

            HttpTimeoutException e =
                    assertThrows(HttpTimeoutException.class, () -> client.verify(PAYLOAD, REQUIREMENTS));

            Duration elapsed = Duration.ofNanos(System.nanoTime() - start);
            assertTrue(elapsed.compareTo(Duration.ofSeconds(2)) < 0, elapsed.toString());
            assertEquals("Facilitator /verify: no complete response within PT0.3S", e.getMessage());
        } finally {
            release.countDown();
        }
    }

    @Test
    void unexpectedTransportFailuresBecomeIOExceptions() {
        HttpClient http = mock(HttpClient.class);
        IllegalStateException failure = new IllegalStateException("selector closed");
        when(http.sendAsync(any(HttpRequest.class), ArgumentMatchers.<BodyHandler<byte[]>>any()))
                .thenReturn(CompletableFuture.failedFuture(failure));
        HttpFacilitatorClient client = HttpFacilitatorClient.builder().httpClient(http).build();

        IOException e = assertThrows(IOException.class, () -> client.settle(PAYLOAD, REQUIREMENTS));

        assertEquals("Facilitator /settle request failed", e.getMessage());
        assertSame(failure, e.getCause());
    }

    @Test
    void unreachableFacilitatorRaisesConnectException() throws Exception {
        int closedPort;
        try (ServerSocket socket = new ServerSocket(0)) {
            closedPort = socket.getLocalPort();
        }
        HttpFacilitatorClient client = HttpFacilitatorClient.builder().url("http://127.0.0.1:" + closedPort).build();

        assertThrows(ConnectException.class, () -> client.verify(PAYLOAD, REQUIREMENTS));
    }

    @Test
    void redirectsAreNotFollowedByDefault() {
        WIREMOCK.stubFor(post("/verify").willReturn(aResponse().withStatus(302)
                .withHeader("Location", "https://elsewhere.example/verify")));

        IOException e = assertThrows(IOException.class, () -> client().build().verify(PAYLOAD, REQUIREMENTS));

        assertEquals("Facilitator verify failed (HTTP 302): <empty response>", e.getMessage());
    }

    @Test
    void bodiesUpToTheLimitAreAccepted() throws Exception {
        String json = "{\"isValid\":true}";
        String padded = json + " ".repeat(HttpFacilitatorClient.MAX_RESPONSE_BYTES - json.length());
        WIREMOCK.stubFor(post("/verify").willReturn(okJson(padded)));

        assertTrue(client().build().verify(PAYLOAD, REQUIREMENTS).isValid());
    }

    @Test
    void oversizedBodiesAreRejectedWithoutRetry() {
        byte[] oversized = new byte[HttpFacilitatorClient.MAX_RESPONSE_BYTES + 1];
        WIREMOCK.stubFor(post("/verify").willReturn(aResponse().withStatus(200).withBody(oversized)));
        WIREMOCK.stubFor(post("/settle").willReturn(aResponse().withStatus(500).withBody(oversized)));
        WIREMOCK.stubFor(get("/supported").willReturn(aResponse().withStatus(429).withBody(oversized)));
        HttpFacilitatorClient client = client().build();

        IOException verify = assertThrows(IOException.class, () -> client.verify(PAYLOAD, REQUIREMENTS));
        assertThrows(IOException.class, () -> client.settle(PAYLOAD, REQUIREMENTS));
        assertThrows(IOException.class, client::supported);

        assertEquals("Facilitator /verify response body exceeds 1048576 bytes", verify.getMessage());
        assertTrue(sleeps.isEmpty());
        WIREMOCK.verify(1, getRequestedFor(urlEqualTo("/supported")));
    }

    // ---------------------------------------------------------------- configuration

    @Test
    void usesTheDefaultUrlAndTimeout() throws Exception {
        HttpClient http = mock(HttpClient.class);
        ArgumentCaptor<HttpRequest> request = ArgumentCaptor.forClass(HttpRequest.class);
        CompletableFuture<HttpResponse<byte[]>> response = response(200, "{\"isValid\":true}");
        when(http.sendAsync(request.capture(), ArgumentMatchers.<BodyHandler<byte[]>>any())).thenReturn(response);
        HttpFacilitatorClient client = HttpFacilitatorClient.builder().httpClient(http).build();

        client.verify(PAYLOAD, REQUIREMENTS);

        assertEquals("https://x402.org/facilitator", client.url());
        assertEquals(URI.create("https://x402.org/facilitator/verify"), request.getValue().uri());
        assertEquals("POST", request.getValue().method());
        assertEquals(Optional.of(Duration.ofSeconds(90)), request.getValue().timeout());
        assertEquals(List.of("application/json"), request.getValue().headers().allValues("Content-Type"));
    }

    @Test
    void timeoutIsAppliedToEveryRequest() throws Exception {
        HttpClient http = mock(HttpClient.class);
        ArgumentCaptor<HttpRequest> request = ArgumentCaptor.forClass(HttpRequest.class);
        CompletableFuture<HttpResponse<byte[]>> response = response(200, SPEC_SUPPORTED);
        when(http.sendAsync(request.capture(), ArgumentMatchers.<BodyHandler<byte[]>>any())).thenReturn(response);

        HttpFacilitatorClient.builder().httpClient(http).timeout(Duration.ofSeconds(5)).build().supported();

        assertEquals("GET", request.getValue().method());
        assertEquals(Optional.of(Duration.ofSeconds(5)), request.getValue().timeout());
    }

    @Test
    void trailingSlashesAreTrimmedAndTheBasePathIsKept() throws Exception {
        WIREMOCK.stubFor(post("/x402/verify").willReturn(okJson("{\"isValid\":true}")));
        HttpFacilitatorClient client = client().url(WIREMOCK.baseUrl() + "/x402//").build();

        client.verify(PAYLOAD, REQUIREMENTS);

        assertEquals(WIREMOCK.baseUrl() + "/x402", client.url());
        WIREMOCK.verify(1, postRequestedFor(urlEqualTo("/x402/verify")));
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "",
        "/",
        "facilitator.example",
        "ftp://facilitator.example",
        "https://",
        "https:///facilitator",
        "https://facilitator.example?apiKey=secret",
        "https://facilitator.example#fragment",
        "https://user:secret@facilitator.example",
        "https://user:secret@facilitator example",
        "ftp://user:secret@facilitator.example"
    })
    void invalidUrlsAreRejectedWithoutEchoingSecrets(String url) {
        HttpFacilitatorClient.Builder builder = HttpFacilitatorClient.builder();

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> builder.url(url));

        assertFalse(e.getMessage().contains("secret"), e.getMessage());
        assertNull(e.getCause());
    }

    @Test
    void invalidSettingsAreRejected() {
        HttpFacilitatorClient.Builder builder = HttpFacilitatorClient.builder();

        assertThrows(IllegalArgumentException.class, () -> builder.timeout(Duration.ZERO));
        assertThrows(IllegalArgumentException.class, () -> builder.timeout(Duration.ofSeconds(-1)));
    }

    @Test
    void toStringNamesOnlyTheUrl() {
        HttpFacilitatorClient client = client().authHeadersProvider(endpoint -> Map.of("Authorization", "secret"))
                .build();

        assertEquals("HttpFacilitatorClient[url=" + WIREMOCK.baseUrl() + "]", client.toString());
    }

    // ---------------------------------------------------------------- wire compatibility

    @Test
    void parsesWhatTheSdkSerializes() throws Exception {
        VerifyResponse verify = VerifyResponse.invalid("invalid_exact_evm_signature", "bad signature", PAYER);
        SettleResponse settle = SettleResponse.failure("insufficient_funds", null, PAYER, "", NETWORK);
        SupportedResponse supported = new SupportedResponse(
                List.of(new SupportedKind(2, "exact", NETWORK, Map.of("assetTransferMethod", "eip3009"))),
                List.of(),
                Map.of("eip155:*", List.of("0x1234567890abcdef1234567890abcdef12345678")));
        WIREMOCK.stubFor(post("/verify").willReturn(okJson(Json.write(verify))));
        WIREMOCK.stubFor(post("/settle").willReturn(okJson(Json.write(settle))));
        WIREMOCK.stubFor(get("/supported").willReturn(okJson(Json.write(supported))));
        HttpFacilitatorClient client = client().build();

        assertEquals(verify, client.verify(PAYLOAD, REQUIREMENTS));
        assertEquals(settle, client.settle(PAYLOAD, REQUIREMENTS));
        assertEquals(supported, client.supported());
    }

    private HttpFacilitatorClient.Builder client() {
        return HttpFacilitatorClient.builder().url(WIREMOCK.baseUrl()).sleeper(sleeps::add);
    }

    private static void stubSupportedSequence(ResponseDefinitionBuilder... responses) {
        String state = Scenario.STARTED;
        for (int i = 0; i < responses.length; i++) {
            String next = "attempt-" + (i + 2);
            WIREMOCK.stubFor(get("/supported").inScenario("supported")
                    .whenScenarioStateIs(state)
                    .willReturn(responses[i])
                    .willSetStateTo(next));
            state = next;
        }
    }

    private static void awaitFirstRequest() throws InterruptedException {
        long deadline = System.nanoTime() + Duration.ofSeconds(2).toNanos();
        while (WIREMOCK.getAllServeEvents().isEmpty() && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
    }

    /**
     * Answers one request with a 200 header block and the first bytes of a 100-byte body, then sends nothing more
     * until {@code release} or 5 seconds, whichever comes first.
     */
    private static void sendHeadersThenStall(ServerSocket server, CountDownLatch release) {
        try (Socket socket = server.accept()) {
            socket.getInputStream().read(new byte[8192]);
            OutputStream out = socket.getOutputStream();
            out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n"
                    + "{\"isValid\"").getBytes(StandardCharsets.US_ASCII));
            out.flush();
            release.await(5, TimeUnit.SECONDS);
        } catch (IOException e) {
            // Closed by the client or by the test; nothing left to do.
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @SuppressWarnings("unchecked")
    private static CompletableFuture<HttpResponse<byte[]>> response(int status, String body) {
        HttpResponse<byte[]> response = mock(HttpResponse.class);
        when(response.statusCode()).thenReturn(status);
        when(response.body()).thenReturn(body.getBytes(StandardCharsets.UTF_8));
        return CompletableFuture.completedFuture(response);
    }
}
