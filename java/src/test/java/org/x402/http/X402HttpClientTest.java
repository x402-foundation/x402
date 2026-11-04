package org.x402.http;

import org.x402.PaymentException;
import org.x402.SchemeNetworkClient;
import org.x402.SpendControls;
import org.x402.X402Client;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequired;
import org.x402.types.PaymentRequirements;
import org.x402.types.SettleResponse;
import org.x402.util.Json;

import com.fasterxml.jackson.databind.JsonNode;
import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import com.github.tomakehurst.wiremock.verification.LoggedRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;

import java.io.IOException;
import java.io.InputStream;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandler;
import java.net.http.HttpResponse.BodyHandlers;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalInt;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.anyRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.anyUrl;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.matching;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class X402HttpClientTest {

    @RegisterExtension
    static final WireMockExtension SERVER = WireMockExtension.newInstance()
            .options(wireMockConfig().dynamicPort())
            .build();

    // Example headers from specs/transports-v2/http.md, copied verbatim.
    private static final String SPEC_PAYMENT_REQUIRED =
            "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQQVlNRU5ULVNJR05BVFVSRSBoZWFkZXIgaXMgcmVxdWlyZWQiLCJyZXNvdXJj"
            + "ZSI6eyJ1cmwiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbS9wcmVtaXVtLWRhdGEiLCJkZXNjcmlwdGlvbiI6IkFjY2VzcyB0"
            + "byBwcmVtaXVtIG1hcmtldCBkYXRhIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVt"
            + "ZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzMiIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDAzNkNiRDUz"
            + "ODQyYzU0MjY2MzRlNzkyOTU0MWVDMjMxOGYzZENGN2UiLCJwYXlUbyI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAz"
            + "QzUxNEVGMzEyMjg3QyIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoi"
            + "MiJ9fV19";
    private static final String SPEC_PAYMENT_SIGNATURE =
            "eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vcHJlbWl1bS1kYXRh"
            + "IiwiZGVzY3JpcHRpb24iOiJBY2Nlc3MgdG8gcHJlbWl1bSBtYXJrZXQgZGF0YSIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24v"
            + "anNvbiJ9LCJhY2NlcHRlZCI6eyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJhbW91bnQiOiIx"
            + "MDAwMCIsImFzc2V0IjoiMHgwMzZDYkQ1Mzg0MmM1NDI2NjM0ZTc5Mjk1NDFlQzIzMThmM2RDRjdlIiwicGF5VG8iOiIweDIw"
            + "OTY5M0JjNmFmYzBDNTMyOGJBMzZGYUYwM0M1MTRFRjMxMjI4N0MiLCJtYXhUaW1lb3V0U2Vjb25kcyI6NjAsImV4dHJhIjp7"
            + "Im5hbWUiOiJVU0RDIiwidmVyc2lvbiI6IjIifX0sInBheWxvYWQiOnsic2lnbmF0dXJlIjoiMHgyZDZhNzU4OGQ2YWNjYTUw"
            + "NWNiZjBkOWE0YTIyN2UwYzUyYzZjMzQwMDhjOGU4OTg2YTEyODMyNTk3NjQxNzM2MDhhMmNlNjQ5NjY0MmUzNzdkNmRhOGRi"
            + "YmY1ODM2ZTliZDE1MDkyZjllY2FiMDVkZWQzZDYyOTNhZjE0OGI1NzFjIiwiYXV0aG9yaXphdGlvbiI6eyJmcm9tIjoiMHg4"
            + "NTdiMDY1MTlFOTFlM0E1NDUzODc5MWJEYmIwRTIyMzczZTM2YjY2IiwidG8iOiIweDIwOTY5M0JjNmFmYzBDNTMyOGJBMzZG"
            + "YUYwM0M1MTRFRjMxMjI4N0MiLCJ2YWx1ZSI6IjEwMDAwIiwidmFsaWRBZnRlciI6IjE3NDA2NzIwODkiLCJ2YWxpZEJlZm9y"
            + "ZSI6IjE3NDA2NzIxNTQiLCJub25jZSI6IjB4ZjM3NDY2MTNjMmQ5MjBiNWZkYWJjMDg1NmYyYWViMmQ0Zjg4ZWU2MDM3Yjhj"
            + "YzVkMDRhNzFhNDQ2MmYxMzQ4MCJ9fX0=";
    private static final String SPEC_SETTLE_SUCCESS =
            "eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWYxMjM0NTY3"
            + "ODkwYWJjZGVmMTIzNDU2Nzg5MGFiY2RlZiIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJwYXllciI6IjB4ODU3YjA2NTE5"
            + "RTkxZTNBNTQ1Mzg3OTFiRGJiMEUyMjM3M2UzNmI2NiJ9";
    private static final String SPEC_SETTLE_FAILURE =
            "eyJzdWNjZXNzIjpmYWxzZSwiZXJyb3JSZWFzb24iOiJpbnN1ZmZpY2llbnRfZnVuZHMiLCJ0cmFuc2FjdGlvbiI6IiIsIm5l"
            + "dHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJwYXllciI6IjB4ODU3YjA2NTE5RTkxZTNBNTQ1Mzg3OTFiRGJiMEUyMjM3M2UzNmI2"
            + "NiJ9";

    // Base Sepolia USDC, from go/mechanisms/evm/default_assets.go.
    private static final String BASE_SEPOLIA = "eip155:84532";
    private static final String BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

    private static final HttpClient HTTP = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();

    private final SpecScheme scheme = new SpecScheme();
    private final X402HttpClient client = new X402HttpClient(X402Client.builder().register("eip155:*", scheme).build(),
            HTTP);

    // ---------------------------------------------------------------- pass-through

    @Test
    void passesNonPaymentResponsesThroughUntouched() throws Exception {
        SERVER.stubFor(get(urlEqualTo("/free"))
                .willReturn(aResponse().withStatus(200).withHeader("X-Test", "yes").withBody("hello")));

        HttpResponse<String> response = client.send(request("/free").build(), BodyHandlers.ofString());

        assertEquals(200, response.statusCode());
        assertEquals("hello", response.body());
        assertEquals(Optional.of("yes"), response.headers().firstValue("X-Test"));
        assertEquals(URI.create(SERVER.url("/free")), response.uri());
        assertEquals(URI.create(SERVER.url("/free")), response.request().uri());
        assertEquals(HttpClient.Version.HTTP_1_1, response.version());
        assertTrue(response.sslSession().isEmpty());
        assertTrue(response.previousResponse().isEmpty());
        assertTrue(response.toString().contains("200"), response.toString());
        SERVER.verify(1, anyRequestedFor(anyUrl()));
        assertFalse(onlyRequest().containsHeader(PaymentHeaders.PAYMENT_SIGNATURE));
        assertTrue(scheme.paid.isEmpty());
    }

    @Test
    void passesErrorStatusesThroughWithoutPaying() throws Exception {
        SERVER.stubFor(get(urlEqualTo("/missing")).willReturn(aResponse().withStatus(404).withBody("nope")));

        HttpResponse<String> response = client.send(request("/missing").build(), BodyHandlers.ofString());

        assertEquals(404, response.statusCode());
        assertEquals("nope", response.body());
        assertTrue(scheme.paid.isEmpty());
    }

    @Test
    void streamingHandlersReceivePassThroughBodies() throws Exception {
        SERVER.stubFor(get(urlEqualTo("/free")).willReturn(aResponse().withStatus(200).withBody("streamed")));

        HttpResponse<InputStream> response = client.send(request("/free").build(), BodyHandlers.ofInputStream());

        try (InputStream body = response.body()) {
            assertEquals("streamed", new String(body.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    @Test
    void reportsRedirectsAsPreviousResponsesWithoutBodies() throws Exception {
        SERVER.stubFor(get(urlEqualTo("/old"))
                .willReturn(aResponse().withStatus(302).withHeader("Location", SERVER.url("/new"))));
        SERVER.stubFor(get(urlEqualTo("/new")).willReturn(aResponse().withStatus(200).withBody("moved")));

        HttpResponse<String> response = followingRedirects().send(request("/old").build(), BodyHandlers.ofString());

        assertEquals("moved", response.body());
        HttpResponse<String> previous = response.previousResponse().orElseThrow();
        assertEquals(302, previous.statusCode());
        assertNull(previous.body());
    }

    // ---------------------------------------------------------------- paying

    @Test
    void paysA402AndResendsTheRequestWithThePaymentSignature() throws Exception {
        stubPaywall("/premium-data", aResponse().withStatus(402)
                .withHeader(PaymentHeaders.PAYMENT_REQUIRED, SPEC_PAYMENT_REQUIRED)
                .withHeader("Content-Type", "application/json")
                .withBody("{}"));

        HttpResponse<String> response = client.send(request("/premium-data").build(), BodyHandlers.ofString());

        assertEquals(200, response.statusCode());
        assertEquals("paid", response.body());
        SERVER.verify(2, anyRequestedFor(anyUrl()));
        LoggedRequest paid = paidRequest();
        assertEquals(json(SPEC_PAYMENT_SIGNATURE), json(paid.getHeader(PaymentHeaders.PAYMENT_SIGNATURE)));
        PaymentRequired offered = PaymentHeaders.decode(SPEC_PAYMENT_REQUIRED, PaymentRequired.class);
        assertEquals(offered.accepts(), scheme.paid);
    }

    @Test
    void sendsThePaymentSignatureHeaderWithItsExactName() throws Exception {
        stubPaywall("/premium-data", aResponse().withStatus(402)
                .withHeader(PaymentHeaders.PAYMENT_REQUIRED, SPEC_PAYMENT_REQUIRED));

        client.send(request("/premium-data").build(), BodyHandlers.discarding());

        assertTrue(paidRequest().getAllHeaderKeys().contains("PAYMENT-SIGNATURE"), paidRequest().getAllHeaderKeys()
                .toString());
    }

    @Test
    void addsNoRequestHeaderOtherThanThePaymentSignature() throws Exception {
        // specs/transports-v2/http.md: any extra header makes a CORS preflight that allows only the protocol
        // headers refuse the paid request.
        stubPaywall("/premium-data", aResponse().withStatus(402)
                .withHeader(PaymentHeaders.PAYMENT_REQUIRED, SPEC_PAYMENT_REQUIRED)
                .withHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE"));

        client.send(request("/premium-data").header("X-Request-Id", "abc-123").build(), BodyHandlers.discarding());

        Set<String> added = new HashSet<>(paidRequest().getAllHeaderKeys());
        added.removeAll(unpaidRequest().getAllHeaderKeys());
        assertEquals(Set.of(PaymentHeaders.PAYMENT_SIGNATURE), added);
    }

    @Test
    void paysTheUriThatAnswered402AfterARedirect() throws Exception {
        SERVER.stubFor(get(urlEqualTo("/short"))
                .willReturn(aResponse().withStatus(302).withHeader("Location", SERVER.url("/premium-data"))));
        stubPaywall("/premium-data", aResponse().withStatus(402)
                .withHeader(PaymentHeaders.PAYMENT_REQUIRED, SPEC_PAYMENT_REQUIRED));

        HttpResponse<String> response = followingRedirects().send(request("/short").build(), BodyHandlers.ofString());

        assertEquals(200, response.statusCode());
        assertEquals("paid", response.body());
        SERVER.verify(1, anyRequestedFor(urlEqualTo("/short")));
        assertEquals("/premium-data", paidRequest().getUrl());
    }

    @Test
    void paysWithTheMethodAndBodyARedirectLeft() throws Exception {
        SERVER.stubFor(post(urlEqualTo("/order"))
                .willReturn(aResponse().withStatus(303).withHeader("Location", SERVER.url("/premium-data"))));
        stubPaywall("/premium-data", aResponse().withStatus(402)
                .withHeader(PaymentHeaders.PAYMENT_REQUIRED, SPEC_PAYMENT_REQUIRED));

        HttpResponse<String> response = followingRedirects().send(request("/order")
                .header("X-Request-Id", "abc-123")
                .POST(HttpRequest.BodyPublishers.ofString("{\"item\":1}"))
                .build(), BodyHandlers.ofString());

        assertEquals(200, response.statusCode());
        SERVER.verify(1, anyRequestedFor(urlEqualTo("/order")));
        LoggedRequest paid = paidRequest();
        assertEquals("GET", paid.getMethod().value());
        assertEquals("", paid.getBodyAsString());
        assertEquals("abc-123", paid.getHeader("X-Request-Id"));
    }

    @Test
    void decodesTheSettlementFromThePaidResponse() throws Exception {
        stubPaywall("/premium-data", aResponse().withStatus(402)
                .withHeader(PaymentHeaders.PAYMENT_REQUIRED, SPEC_PAYMENT_REQUIRED));

        HttpResponse<String> response = client.send(request("/premium-data").build(), BodyHandlers.ofString());

        SettleResponse settlement = X402HttpClient.settleResponse(response).orElseThrow();
        assertTrue(settlement.success());
        assertEquals("0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", settlement.transaction());
        assertEquals(BASE_SEPOLIA, settlement.network());
        assertEquals("0x857b06519E91e3A54538791bDbb0E22373e36b66", settlement.payer());
    }

    @Test
    void replaysTheMethodHeadersAndBodyOnThePaidRequest() throws Exception {
        String body = "{\"query\":\"latest market data\"}";
        SERVER.stubFor(post(urlEqualTo("/premium-data"))
                .withHeader(PaymentHeaders.PAYMENT_SIGNATURE, absent())
                .willReturn(aResponse().withStatus(402)
                        .withHeader(PaymentHeaders.PAYMENT_REQUIRED, SPEC_PAYMENT_REQUIRED)));
        SERVER.stubFor(post(urlEqualTo("/premium-data"))
                .withHeader(PaymentHeaders.PAYMENT_SIGNATURE, matching(".+"))
                .willReturn(aResponse().withStatus(201).withBody("created")));

        HttpResponse<String> response = client.send(request("/premium-data")
                .header("Content-Type", "application/json")
                .header("X-Request-Id", "abc-123")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build(), BodyHandlers.ofString());

        assertEquals(201, response.statusCode());
        List<LoggedRequest> requests = SERVER.findAll(anyRequestedFor(anyUrl()));
        assertEquals(2, requests.size());
        for (LoggedRequest sent : requests) {
            assertEquals("POST", sent.getMethod().value());
            assertEquals(body, sent.getBodyAsString());
            assertEquals("abc-123", sent.getHeader("X-Request-Id"));
            assertEquals("application/json", sent.getHeader("Content-Type"));
        }
    }

    @Test
    void replacesAPaymentSignatureTheCallerAlreadySet() throws Exception {
        SERVER.stubFor(get(urlEqualTo("/premium-data"))
                .withHeader(PaymentHeaders.PAYMENT_SIGNATURE, equalTo("stale"))
                .willReturn(aResponse().withStatus(402)
                        .withHeader(PaymentHeaders.PAYMENT_REQUIRED, SPEC_PAYMENT_REQUIRED)));
        SERVER.stubFor(get(urlEqualTo("/premium-data"))
                .withHeader(PaymentHeaders.PAYMENT_SIGNATURE, matching("ey.+"))
                .willReturn(aResponse().withStatus(200)));

        HttpResponse<Void> response = client.send(
                request("/premium-data").header(PaymentHeaders.PAYMENT_SIGNATURE, "stale").build(),
                BodyHandlers.discarding());

        assertEquals(200, response.statusCode());
        List<String> sent = paidRequest().getHeaders().getHeader(PaymentHeaders.PAYMENT_SIGNATURE).values();
        assertEquals(1, sent.size());
        assertNotEquals("stale", sent.get(0));
    }

    @Test
    void returnsASecond402WithoutPayingAgain() throws Exception {
        SERVER.stubFor(get(urlEqualTo("/premium-data"))
                .willReturn(aResponse().withStatus(402)
                        .withHeader(PaymentHeaders.PAYMENT_REQUIRED, SPEC_PAYMENT_REQUIRED)
                        .withBody("{\"error\":\"insufficient_funds\"}")));

        HttpResponse<String> response = client.send(request("/premium-data").build(), BodyHandlers.ofString());

        assertEquals(402, response.statusCode());
        assertEquals("{\"error\":\"insufficient_funds\"}", response.body());
        SERVER.verify(2, anyRequestedFor(anyUrl()));
        assertEquals(1, scheme.paid.size());
    }

    @Test
    void usesTheCallersBodyHandlerOnlyForTheReturnedResponse() throws Exception {
        stubPaywall("/premium-data", aResponse().withStatus(402)
                .withHeader(PaymentHeaders.PAYMENT_REQUIRED, SPEC_PAYMENT_REQUIRED)
                .withBody("{}"));
        List<Integer> handled = new CopyOnWriteArrayList<>();
        BodyHandler<String> recording = info -> {
            handled.add(info.statusCode());
            return BodyHandlers.ofString().apply(info);
        };

        client.send(request("/premium-data").build(), recording);

        assertEquals(List.of(200), handled);
    }

    @Test
    void fallsBackToAnX402V2JsonBodyWithoutTheHeader() throws Exception {
        String paymentRequiredJson = new String(Base64.getDecoder().decode(SPEC_PAYMENT_REQUIRED),
                StandardCharsets.UTF_8);
        stubPaywall("/premium-data", aResponse().withStatus(402)
                .withHeader("Content-Type", "application/json")
                .withBody(paymentRequiredJson));

        HttpResponse<String> response = client.send(request("/premium-data").build(), BodyHandlers.ofString());

        assertEquals(200, response.statusCode());
        assertEquals(json(SPEC_PAYMENT_SIGNATURE), json(paidRequest().getHeader(PaymentHeaders.PAYMENT_SIGNATURE)));
    }

    @Test
    void ignoresAnOversized402BodyWhenTheHeaderIsPresent() throws Exception {
        stubPaywall("/premium-data", aResponse().withStatus(402)
                .withHeader(PaymentHeaders.PAYMENT_REQUIRED, SPEC_PAYMENT_REQUIRED)
                .withBody("x".repeat(2 * X402HttpClient.MAX_PAYMENT_REQUIRED_BODY_BYTES)));

        HttpResponse<String> response = client.send(request("/premium-data").build(), BodyHandlers.ofString());

        assertEquals(200, response.statusCode());
    }

    @Test
    void logsThePaymentAtDebugLevelWithoutTheSignature() throws Exception {
        stubPaywall("/premium-data", aResponse().withStatus(402)
                .withHeader(PaymentHeaders.PAYMENT_REQUIRED, SPEC_PAYMENT_REQUIRED));
        Logger logger = Logger.getLogger(X402HttpClient.class.getName());
        List<String> messages = new CopyOnWriteArrayList<>();
        Handler handler = new Handler() {
            @Override
            public void publish(LogRecord record) {
                messages.add(record.getMessage());
            }

            @Override
            public void flush() {
            }

            @Override
            public void close() {
            }
        };
        Level previous = logger.getLevel();
        logger.setLevel(Level.FINE);
        logger.addHandler(handler);
        try {
            client.send(request("/premium-data?api_key=secret").build(), BodyHandlers.discarding());
        } finally {
            logger.removeHandler(handler);
            logger.setLevel(previous);
        }

        assertEquals(1, messages.size());
        assertTrue(messages.get(0).endsWith("with exact on eip155:84532: 10000 of " + BASE_SEPOLIA_USDC),
                messages.get(0));
        assertTrue(messages.get(0).startsWith("Paying for GET localhost/premium-data with"), messages.get(0));
        assertFalse(messages.get(0).contains("secret"), "query strings must not be logged");
        assertFalse(messages.get(0).contains("0x2d6a7588d6acca505cbf0d9a4a227e0c"), "signature must not be logged");
    }

    @Test
    void defaultConstructorSendsHttp11WithoutAnH2cUpgrade() throws Exception {
        SERVER.stubFor(get(urlEqualTo("/free")).willReturn(aResponse().withStatus(200).withBody("hello")));
        X402HttpClient defaults = new X402HttpClient(X402Client.builder().register("eip155:*", scheme).build());

        HttpResponse<String> response = defaults.send(request("/free").build(), BodyHandlers.ofString());

        assertEquals("hello", response.body());
        assertEquals(HttpClient.Version.HTTP_1_1, response.version());
        SERVER.verify(getRequestedFor(urlEqualTo("/free")).withoutHeader("Upgrade").withoutHeader("HTTP2-Settings"));
    }

    // ---------------------------------------------------------------- failures

    @Test
    void rejectsAMalformedPaymentRequiredHeaderWithoutRetrying() {
        for (String header : List.of("not base64!", base64("not json"), base64("[1,2]"), base64("{\"accepts\":7}"))) {
            SERVER.resetAll();
            SERVER.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(402)
                    .withHeader(PaymentHeaders.PAYMENT_REQUIRED, header)));

            PaymentException e = assertThrows(PaymentException.class,
                    () -> client.send(request("/premium-data").build(), BodyHandlers.ofString()), header);

            assertEquals(PaymentException.INVALID_PAYMENT_REQUIRED, e.reason());
            assertTrue(e.getMessage().startsWith("PAYMENT-REQUIRED header is malformed"), e.getMessage());
            SERVER.verify(1, anyRequestedFor(anyUrl()));
        }
    }

    @Test
    void doesNotFallBackToTheBodyWhenTheHeaderIsMalformed() {
        String paymentRequiredJson = new String(Base64.getDecoder().decode(SPEC_PAYMENT_REQUIRED),
                StandardCharsets.UTF_8);
        SERVER.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(402)
                .withHeader(PaymentHeaders.PAYMENT_REQUIRED, "%%%")
                .withBody(paymentRequiredJson)));

        PaymentException e = assertThrows(PaymentException.class,
                () -> client.send(request("/premium-data").build(), BodyHandlers.ofString()));

        assertEquals(PaymentException.INVALID_PAYMENT_REQUIRED, e.reason());
    }

    @Test
    void rejectsA402WhoseBodyIsNotAnX402V2PaymentRequired() {
        Map<String, String> bodies = Map.of(
                "", "is not a JSON object",
                "Payment Required", "is not JSON",
                "[1]", "is not a JSON object",
                "{\"x402Version\":1,\"accepts\":[]}", "(x402Version: 1)",
                "{\"accepts\":[]}", "(x402Version: missing)",
                "{\"x402Version\":\"2\",\"accepts\":[]}", "(x402Version: \"2\")",
                "{\"x402Version\":2,\"accepts\":\"none\"}", "is not a valid PaymentRequired");
        bodies.forEach((body, expected) -> {
            SERVER.resetAll();
            SERVER.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(402).withBody(body)));

            PaymentException e = assertThrows(PaymentException.class,
                    () -> client.send(request("/premium-data").build(), BodyHandlers.ofString()), body);

            assertEquals(PaymentException.INVALID_PAYMENT_REQUIRED, e.reason(), body);
            assertTrue(e.getMessage().contains(expected), e.getMessage());
            SERVER.verify(1, anyRequestedFor(anyUrl()));
        });
    }

    @Test
    void rejectsAnOversized402BodyWithoutTheHeader() {
        SERVER.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(402)
                .withBody("x".repeat(X402HttpClient.MAX_PAYMENT_REQUIRED_BODY_BYTES + 1))));

        PaymentException e = assertThrows(PaymentException.class,
                () -> client.send(request("/premium-data").build(), BodyHandlers.ofString()));

        assertEquals(PaymentException.INVALID_PAYMENT_REQUIRED, e.reason());
        assertTrue(e.getMessage().contains("exceeds 1048576 bytes"), e.getMessage());
    }

    @Test
    void acceptsA402BodyOfExactlyTheLimitWithoutTheHeader() throws Exception {
        String paymentRequiredJson = new String(Base64.getDecoder().decode(SPEC_PAYMENT_REQUIRED),
                StandardCharsets.UTF_8);
        stubPaywall("/premium-data", aResponse().withStatus(402).withBody(paymentRequiredJson
                + " ".repeat(X402HttpClient.MAX_PAYMENT_REQUIRED_BODY_BYTES - paymentRequiredJson.length())));

        HttpResponse<String> response = client.send(request("/premium-data").build(), BodyHandlers.ofString());

        assertEquals(200, response.statusCode());
    }

    @Test
    void propagatesSelectionFailuresWithoutRetrying() {
        X402HttpClient ethereumOnly = new X402HttpClient(
                X402Client.builder().register("eip155:1", scheme).build(), HTTP);
        SERVER.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(402)
                .withHeader(PaymentHeaders.PAYMENT_REQUIRED, SPEC_PAYMENT_REQUIRED)));

        PaymentException e = assertThrows(PaymentException.class,
                () -> ethereumOnly.send(request("/premium-data").build(), BodyHandlers.ofString()));

        assertEquals(PaymentException.UNSUPPORTED_SCHEME, e.reason());
        SERVER.verify(1, anyRequestedFor(anyUrl()));
    }

    @Test
    void spendControlsStopAnExpensivePaymentBeforeSigning() {
        PaymentRequired offered = PaymentHeaders.decode(SPEC_PAYMENT_REQUIRED, PaymentRequired.class);
        PaymentRequirements twoDollars = new PaymentRequirements("exact", BASE_SEPOLIA, BASE_SEPOLIA_USDC, "2000000",
                offered.accepts().get(0).payTo(), 60, offered.accepts().get(0).extra());
        PaymentRequired expensive = new PaymentRequired(2, null, offered.resource(), List.of(twoDollars), null);
        SERVER.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(402)
                .withHeader(PaymentHeaders.PAYMENT_REQUIRED, PaymentHeaders.encode(expensive))));

        PaymentException e = assertThrows(PaymentException.class,
                () -> client.send(request("/premium-data").build(), BodyHandlers.ofString()));

        assertEquals(PaymentException.SPEND_CONTROLS_MAX_AMOUNT_EXCEEDED, e.reason());
        assertTrue(scheme.paid.isEmpty());
        SERVER.verify(1, anyRequestedFor(anyUrl()));
    }

    @Test
    void paysAboveTheDefaultCapWhenSpendControlsAllowIt() throws Exception {
        PaymentRequired offered = PaymentHeaders.decode(SPEC_PAYMENT_REQUIRED, PaymentRequired.class);
        PaymentRequirements twoDollars = new PaymentRequirements("exact", BASE_SEPOLIA, BASE_SEPOLIA_USDC, "2000000",
                offered.accepts().get(0).payTo(), 60, offered.accepts().get(0).extra());
        PaymentRequired expensive = new PaymentRequired(2, null, offered.resource(), List.of(twoDollars), null);
        stubPaywall("/premium-data", aResponse().withStatus(402)
                .withHeader(PaymentHeaders.PAYMENT_REQUIRED, PaymentHeaders.encode(expensive)));
        X402HttpClient generous = new X402HttpClient(X402Client.builder()
                .register("eip155:*", scheme)
                .spendControls(SpendControls.builder().maxAmountPerPayment("$2").build())
                .build(), HTTP);

        assertEquals(200, generous.send(request("/premium-data").build(), BodyHandlers.ofString()).statusCode());
    }

    @Test
    void propagatesTransportFailures() throws IOException {
        int closedPort;
        try (ServerSocket socket = new ServerSocket(0)) {
            closedPort = socket.getLocalPort();
        }
        HttpRequest unreachable = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + closedPort + "/")).build();

        assertThrows(IOException.class, () -> client.send(unreachable, BodyHandlers.ofString()));
    }

    @Test
    void propagatesInterruptionWithoutSwallowingIt() {
        SERVER.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(200)));
        Thread.currentThread().interrupt();
        try {
            assertThrows(InterruptedException.class,
                    () -> client.send(request("/free").build(), BodyHandlers.ofString()));
        } finally {
            Thread.interrupted();
        }
    }

    // ---------------------------------------------------------------- settleResponse

    @Test
    void settleResponseReadsFailedSettlements() throws Exception {
        SERVER.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(402)
                .withHeader(PaymentHeaders.PAYMENT_RESPONSE, SPEC_SETTLE_FAILURE)));

        SettleResponse settlement = X402HttpClient.settleResponse(plainGet("/premium-data")).orElseThrow();

        assertFalse(settlement.success());
        assertEquals("insufficient_funds", settlement.errorReason());
        assertEquals("", settlement.transaction());
    }

    @Test
    void settleResponseFallsBackToTheV1HeaderName() throws Exception {
        SERVER.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(200)
                .withHeader("X-PAYMENT-RESPONSE", SPEC_SETTLE_SUCCESS)));

        SettleResponse settlement = X402HttpClient.settleResponse(plainGet("/legacy")).orElseThrow();

        assertTrue(settlement.success());
        assertEquals(BASE_SEPOLIA, settlement.network());
    }

    @Test
    void settleResponseIsEmptyWithoutTheHeader() throws Exception {
        SERVER.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(200)));

        assertTrue(X402HttpClient.settleResponse(plainGet("/free")).isEmpty());
    }

    @Test
    void settleResponseRejectsAMalformedHeader() throws Exception {
        SERVER.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(200)
                .withHeader(PaymentHeaders.PAYMENT_RESPONSE, base64("not json"))));
        HttpResponse<String> response = plainGet("/free");

        PaymentException e = assertThrows(PaymentException.class, () -> X402HttpClient.settleResponse(response));

        assertEquals(PaymentException.INVALID_PAYMENT_RESPONSE, e.reason());
    }

    // ---------------------------------------------------------------- helpers

    private static HttpRequest.Builder request(String path) {
        return HttpRequest.newBuilder(URI.create(SERVER.url(path)));
    }

    private X402HttpClient followingRedirects() {
        HttpClient following = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
        return new X402HttpClient(X402Client.builder().register("eip155:*", scheme).build(), following);
    }

    /** Stubs a resource that answers {@code unpaid} without a payment and 200 with the spec settlement once paid. */
    private static void stubPaywall(
            String path, com.github.tomakehurst.wiremock.client.ResponseDefinitionBuilder unpaid) {
        SERVER.stubFor(get(urlPathEqualTo(path))
                .withHeader(PaymentHeaders.PAYMENT_SIGNATURE, absent())
                .willReturn(unpaid));
        SERVER.stubFor(get(urlPathEqualTo(path))
                .withHeader(PaymentHeaders.PAYMENT_SIGNATURE, matching(".+"))
                .willReturn(aResponse().withStatus(200)
                        .withHeader(PaymentHeaders.PAYMENT_RESPONSE, SPEC_SETTLE_SUCCESS)
                        .withBody("paid")));
    }

    private static LoggedRequest onlyRequest() {
        List<LoggedRequest> requests = SERVER.findAll(anyRequestedFor(anyUrl()));
        assertEquals(1, requests.size());
        return requests.get(0);
    }

    private static LoggedRequest unpaidRequest() {
        List<LoggedRequest> unpaid = SERVER.findAll(anyRequestedFor(anyUrl())
                .withHeader(PaymentHeaders.PAYMENT_SIGNATURE, absent()));
        assertEquals(1, unpaid.size());
        return unpaid.get(0);
    }

    private static LoggedRequest paidRequest() {
        List<LoggedRequest> paid = SERVER.findAll(anyRequestedFor(anyUrl())
                .withHeader(PaymentHeaders.PAYMENT_SIGNATURE, matching("ey.+")));
        assertEquals(1, paid.size());
        return paid.get(0);
    }

    private static HttpResponse<String> plainGet(String path) throws IOException, InterruptedException {
        return HTTP.send(request(path).build(), BodyHandlers.ofString());
    }

    private static JsonNode json(String header) throws IOException {
        return Json.readTree(new String(Base64.getDecoder().decode(header), StandardCharsets.UTF_8));
    }

    private static String base64(String text) {
        return Base64.getEncoder().encodeToString(text.getBytes(StandardCharsets.UTF_8));
    }

    /** Returns the inner payload of the spec's {@code PAYMENT-SIGNATURE} example and records what it pays. */
    private static final class SpecScheme implements SchemeNetworkClient {

        private final List<PaymentRequirements> paid = new CopyOnWriteArrayList<>();

        @Override
        public String scheme() {
            return "exact";
        }

        @Override
        public Map<String, Object> createPaymentPayload(PaymentRequirements requirements) {
            paid.add(requirements);
            PaymentPayload example = PaymentHeaders.decode(SPEC_PAYMENT_SIGNATURE, PaymentPayload.class);
            return example.payload();
        }

        @Override
        public OptionalInt defaultAssetDecimals(String asset, String network) {
            return BASE_SEPOLIA.equals(network) && BASE_SEPOLIA_USDC.equalsIgnoreCase(asset)
                    ? OptionalInt.of(6)
                    : OptionalInt.empty();
        }
    }
}
