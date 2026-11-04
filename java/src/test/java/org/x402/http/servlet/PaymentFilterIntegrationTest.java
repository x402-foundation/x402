package org.x402.http.servlet;

import org.x402.Price;
import org.x402.X402ResourceServer;
import org.x402.http.HttpResourceServer;
import org.x402.http.PaymentHeaders;
import org.x402.http.PaymentOption;
import org.x402.http.RouteConfig;
import org.x402.testsupport.server.FakeFacilitator;
import org.x402.testsupport.server.FakeSchemeServer;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequired;
import org.x402.types.PaymentRequirements;
import org.x402.types.SettleResponse;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.eclipse.jetty.http.UriCompliance;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.PrintWriter;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Runs {@link PaymentFilter} in embedded Jetty 11 against real servlets and a fake facilitator. */
class PaymentFilterIntegrationTest {

    private static final String NETWORK = "eip155:84532";
    private static final String PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
    private static final String SECRET = "premium content";
    private static final String ORIGIN = "https://app.example";

    private final HttpClient http = HttpClient.newHttpClient();
    private final AtomicReference<Throwable> asyncFailure = new AtomicReference<>();
    private FakeFacilitator facilitator;
    private JettyServer jetty;

    @BeforeEach
    void startServer() throws Exception {
        facilitator = new FakeFacilitator(NETWORK);
        X402ResourceServer resourceServer = X402ResourceServer.builder()
                .register(NETWORK, new FakeSchemeServer("exact"))
                .facilitator(facilitator)
                .build();
        PaymentOption option = PaymentOption.builder()
                .scheme("exact").network(NETWORK).payTo(PAY_TO).price(Price.money("$0.001")).build();
        HttpResourceServer payments = new HttpResourceServer(resourceServer, Map.of(
                "/paid/*", RouteConfig.builder().accept(option).description("Paid").build()));

        jetty = new JettyServer(UriCompliance.DEFAULT)
                .filter(upstreamCorsFilter())
                .filter(new PaymentFilter(payments), DispatcherType.REQUEST, DispatcherType.FORWARD)
                .servlet("/free", servlet((req, resp) -> resp.getWriter().print("free content")))
                .servlet("/paid/premium", new Premium())
                .servlet("/paid/not-found", servlet((req, resp) -> resp.sendError(404, "nothing here")))
                .servlet("/paid/fails", servlet((req, resp) -> {
                    resp.setStatus(503);
                    resp.getWriter().print("handler failed");
                }))
                .servlet("/paid/throws", servlet((req, resp) -> {
                    resp.setHeader("X-Handler", "yes");
                    resp.getWriter().print(SECRET);
                    throw new IllegalStateException("handler bug");
                }))
                .servlet("/paid/async", servlet((req, resp) -> {
                    try {
                        req.startAsync();
                    } catch (IllegalStateException e) {
                        asyncFailure.set(e);
                        throw e;
                    }
                }))
                .servlet("/paid/flush", servlet((req, resp) -> {
                    resp.getWriter().print(SECRET);
                    resp.flushBuffer();
                }))
                .servlet("/paid/redirect", servlet((req, resp) -> resp.sendRedirect("/free")))
                .servlet("/paid/binary", servlet((req, resp) -> {
                    byte[] bytes = new byte[256];
                    for (int i = 0; i < bytes.length; i++) {
                        bytes[i] = (byte) i;
                    }
                    resp.setContentType("application/octet-stream");
                    resp.setContentLength(bytes.length);
                    resp.getOutputStream().write(bytes);
                }))
                .servlet("/paid/forward", servlet((req, resp) ->
                        req.getRequestDispatcher("/paid/premium").forward(req, resp)))
                .servlet("/free-forward", servlet((req, resp) ->
                        req.getRequestDispatcher("/paid/premium").forward(req, resp)))
                .servlet("/paid/include/*", servlet((req, resp) -> {
                    resp.getOutputStream().print("SECRET-ARTICLE ");
                    req.getRequestDispatcher("/fragment" + req.getPathInfo()).include(req, resp);
                    resp.getOutputStream().print("END");
                }))
                .servlet("/fragment/status", servlet((req, resp) -> {
                    resp.setStatus(404);
                    resp.getOutputStream().print("[no related items] ");
                }))
                .servlet("/fragment/length", servlet((req, resp) -> {
                    resp.setContentLength(5);
                    resp.getOutputStream().print("HELLO ");
                }))
                .servlet("/fragment/error", servlet((req, resp) -> resp.sendError(404)))
                .servlet("/paid/charset", servlet((req, resp) -> {
                    PrintWriter writer = resp.getWriter();
                    resp.setContentType("text/plain;charset=UTF-8");
                    writer.print("café");
                }))
                .start();
    }

    @AfterEach
    void stopServer() throws Exception {
        jetty.close();
    }

    private static PaymentRequirements requirements() {
        return new PaymentRequirements("exact", NETWORK, FakeSchemeServer.ASSET, "1000", PAY_TO, 300,
                Map.of("name", "USDC", "version", "2"));
    }

    private static String signature() {
        return PaymentHeaders.encode(new PaymentPayload(2, Map.of("signature", "0x01"), requirements(), null, null));
    }

    private HttpResponse<String> send(String method, String path, String paymentSignature) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(jetty.url(path)))
                .method(method, HttpRequest.BodyPublishers.noBody());
        if (paymentSignature != null) {
            request.header("PAYMENT-SIGNATURE", paymentSignature);
        }
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> paidGet(String path) throws Exception {
        return send("GET", path, signature());
    }

    private static SettleResponse paymentResponse(HttpResponse<?> response) {
        return PaymentHeaders.decode(response.headers().firstValue("PAYMENT-RESPONSE").orElseThrow(),
                SettleResponse.class);
    }

    @Test
    void passesFreeRoutesThrough() throws Exception {
        HttpResponse<String> response = send("GET", "/free", null);

        assertEquals(200, response.statusCode());
        assertEquals("free content", response.body());
        assertEquals(0, facilitator.verifyCalls());
    }

    @Test
    void answersAnUnpaidRequestWith402AndPaymentRequired() throws Exception {
        HttpResponse<String> response = send("GET", "/paid/premium", null);

        assertEquals(402, response.statusCode());
        assertEquals("{\"error\":\"Payment required\"}", response.body());
        assertEquals("application/json", response.headers().firstValue("Content-Type").orElseThrow());
        assertEquals("no-store", response.headers().firstValue("Cache-Control").orElseThrow());
        assertEquals(ORIGIN, response.headers().firstValue("Access-Control-Allow-Origin").orElseThrow());
        PaymentRequired message = PaymentHeaders.decode(
                response.headers().firstValue("PAYMENT-REQUIRED").orElseThrow(), PaymentRequired.class);
        assertEquals(List.of(requirements()), message.accepts());
        assertEquals(jetty.url("/paid/premium"), message.resource().url());
        assertEquals("Paid", message.resource().description());
    }

    @Test
    void rejectsAMalformedPaymentSignatureWith400() throws Exception {
        HttpResponse<String> response = send("GET", "/paid/premium", "not base64!");

        assertEquals(400, response.statusCode());
        assertEquals("{\"error\":\"invalid_payload\"}", response.body());
        assertEquals(0, facilitator.verifyCalls());
    }

    @Test
    void deliversThePaidResponseAfterSettlement() throws Exception {
        HttpResponse<String> response = paidGet("/paid/premium");

        assertEquals(200, response.statusCode());
        assertEquals("{\"secret\":\"" + SECRET + "\",\"amount\":\"1000\"}", response.body());
        assertEquals("max-age=60, private", response.headers().firstValue("Cache-Control").orElseThrow());
        assertEquals("yes", response.headers().firstValue("X-Handler").orElseThrow());
        assertEquals(ORIGIN, response.headers().firstValue("Access-Control-Allow-Origin").orElseThrow());
        assertTrue(response.headers().firstValue("Set-Cookie").orElseThrow().startsWith("session=granted"));
        assertEquals(String.valueOf(response.body().length()),
                response.headers().firstValue("Content-Length").orElseThrow());
        assertEquals(SettleResponse.success(FakeFacilitator.PAYER, FakeFacilitator.TRANSACTION, NETWORK),
                paymentResponse(response));
        assertEquals(1, facilitator.verifyCalls());
        assertEquals(1, facilitator.settleCalls());
    }

    @Test
    void discardsEverythingTheHandlerProducedWhenSettlementFails() throws Exception {
        facilitator.onSettle((payload, requirements) -> SettleResponse.failure(
                "insufficient_funds", null, FakeFacilitator.PAYER, "", NETWORK));

        HttpResponse<String> response = paidGet("/paid/premium");

        assertEquals(402, response.statusCode());
        assertEquals("{\"error\":\"settlement_failed\"}", response.body());
        assertFalse(response.body().contains(SECRET));
        assertEquals("application/json", response.headers().firstValue("Content-Type").orElseThrow());
        assertEquals(List.of("no-store"), response.headers().allValues("Cache-Control"));
        assertTrue(response.headers().firstValue("X-Handler").isEmpty());
        assertTrue(response.headers().allValues("Set-Cookie").isEmpty());
        assertEquals(ORIGIN, response.headers().firstValue("Access-Control-Allow-Origin").orElseThrow());
        SettleResponse receipt = paymentResponse(response);
        assertFalse(receipt.success());
        assertEquals("insufficient_funds", receipt.errorReason());
    }

    @Test
    void discardsTheBodyWhenTheFacilitatorCannotBeReachedForSettlement() throws Exception {
        facilitator.onSettle((payload, requirements) -> {
            throw new IOException("connection reset");
        });

        HttpResponse<String> response = paidGet("/paid/premium");

        assertEquals(402, response.statusCode());
        assertEquals("connection reset", paymentResponse(response).errorReason());
        assertFalse(response.body().contains(SECRET));
    }

    @Test
    void discardsTheHandlersHeadersWhenTheFacilitatorThrowsAnUncheckedException() throws Exception {
        facilitator.onSettle((payload, requirements) -> {
            throw new IllegalStateException("AuthHeadersProvider returned null for settle");
        });

        HttpResponse<String> response = paidGet("/paid/premium");

        assertEquals(402, response.statusCode());
        assertEquals("{\"error\":\"settlement_failed\"}", response.body());
        assertTrue(response.headers().firstValue("X-Handler").isEmpty());
        assertTrue(response.headers().allValues("Set-Cookie").isEmpty());
        assertEquals(ORIGIN, response.headers().firstValue("Access-Control-Allow-Origin").orElseThrow());
        assertEquals("AuthHeadersProvider returned null for settle", paymentResponse(response).errorReason());
    }

    @Test
    void discardsTheHandlersHeadersWhenSettlementThrowsAnError() throws Exception {
        facilitator.onSettle((payload, requirements) -> {
            throw new StackOverflowError("facilitator bug");
        });

        HttpResponse<String> response = paidGet("/paid/premium");

        assertEquals(500, response.statusCode());
        assertFalse(response.body().contains(SECRET));
        assertTrue(response.headers().firstValue("X-Handler").isEmpty());
        assertTrue(response.headers().allValues("Set-Cookie").isEmpty());
    }

    @Test
    void ignoresStatusLengthAndErrorsFromAnIncludedResource() throws Exception {
        for (String fragment : List.of("status", "length", "error")) {
            HttpResponse<String> response = paidGet("/paid/include/" + fragment);

            assertEquals(200, response.statusCode(), fragment);
            assertTrue(response.body().startsWith("SECRET-ARTICLE "), fragment);
            assertTrue(response.body().endsWith("END"), fragment);
            assertEquals(String.valueOf(response.body().length()),
                    response.headers().firstValue("Content-Length").orElseThrow(), fragment);
            assertTrue(paymentResponse(response).success(), fragment);
        }
        assertEquals(3, facilitator.settleCalls());
    }

    @Test
    void chargesForAPaidPathReachedByForwardingFromAFreeOne() throws Exception {
        HttpResponse<String> unpaid = send("GET", "/free-forward", null);

        assertEquals(402, unpaid.statusCode());
        assertFalse(unpaid.body().contains(SECRET));

        HttpResponse<String> paid = paidGet("/free-forward");

        assertEquals(200, paid.statusCode());
        assertTrue(paid.body().contains(SECRET));
        assertEquals(1, facilitator.settleCalls());
    }

    @Test
    void keepsTheCharsetFixedByGetWriterInTheContentTypeHeader() throws Exception {
        HttpResponse<byte[]> response = http.send(HttpRequest.newBuilder(URI.create(jetty.url("/paid/charset")))
                .header("PAYMENT-SIGNATURE", signature()).build(), HttpResponse.BodyHandlers.ofByteArray());

        assertEquals(200, response.statusCode());
        assertArrayEquals(new byte[] {'c', 'a', 'f', (byte) 0xE9}, response.body());
        assertEquals("text/plain;charset=iso-8859-1",
                response.headers().firstValue("Content-Type").orElseThrow().toLowerCase(Locale.ROOT));
    }

    @Test
    void flushBufferDoesNotCommitBeforeSettlement() throws Exception {
        facilitator.onSettle((payload, requirements) -> SettleResponse.failure("boom", null, null, "", NETWORK));

        HttpResponse<String> response = paidGet("/paid/flush");

        assertEquals(402, response.statusCode());
        assertFalse(response.body().contains(SECRET));
    }

    @Test
    void skipsSettlementWhenTheHandlerSendsAnError() throws Exception {
        HttpResponse<String> response = paidGet("/paid/not-found");

        assertEquals(404, response.statusCode());
        assertTrue(response.headers().firstValue("PAYMENT-RESPONSE").isEmpty());
        assertEquals(1, facilitator.verifyCalls());
        assertEquals(0, facilitator.settleCalls());
    }

    @Test
    void skipsSettlementAndPassesThroughAFailedHandlerResponse() throws Exception {
        HttpResponse<String> response = paidGet("/paid/fails");

        assertEquals(503, response.statusCode());
        assertEquals("handler failed", response.body());
        assertEquals(0, facilitator.settleCalls());
    }

    @Test
    void skipsSettlementAndDiscardsTheResponseWhenTheHandlerThrows() throws Exception {
        HttpResponse<String> response = paidGet("/paid/throws");

        assertEquals(500, response.statusCode());
        assertFalse(response.body().contains(SECRET));
        assertTrue(response.headers().firstValue("X-Handler").isEmpty());
        assertEquals(0, facilitator.settleCalls());
    }

    @Test
    void refusesAsynchronousProcessingOnPaidRoutes() throws Exception {
        HttpResponse<String> response = paidGet("/paid/async");

        assertEquals(500, response.statusCode());
        assertInstanceOf(IllegalStateException.class, asyncFailure.get());
        assertEquals(0, facilitator.settleCalls());
    }

    @Test
    void settlesAndReplaysARedirect() throws Exception {
        HttpResponse<String> response = paidGet("/paid/redirect");

        assertEquals(302, response.statusCode());
        assertEquals(jetty.url("/free"), response.headers().firstValue("Location").orElseThrow());
        assertTrue(paymentResponse(response).success());
        assertEquals(1, facilitator.settleCalls());
    }

    @Test
    void deliversABinaryBodyWrittenToTheOutputStream() throws Exception {
        HttpResponse<byte[]> response = http.send(HttpRequest.newBuilder(URI.create(jetty.url("/paid/binary")))
                .header("PAYMENT-SIGNATURE", signature()).build(), HttpResponse.BodyHandlers.ofByteArray());

        assertEquals(200, response.statusCode());
        assertEquals(256, response.body().length);
        assertArrayEquals(new byte[] {0, 1, 2}, java.util.Arrays.copyOf(response.body(), 3));
        assertEquals("256", response.headers().firstValue("Content-Length").orElseThrow());
    }

    @Test
    void chargesOnceForAForwardWithinAPaidRequest() throws Exception {
        HttpResponse<String> response = paidGet("/paid/forward");

        assertEquals(200, response.statusCode());
        assertTrue(response.body().contains(SECRET));
        assertEquals(1, facilitator.verifyCalls());
        assertEquals(1, facilitator.settleCalls());
    }

    @Test
    void letsCorsPreflightThroughWithoutPayment() throws Exception {
        HttpResponse<String> response = send("OPTIONS", "/paid/premium", null);

        assertEquals(200, response.statusCode());
        assertTrue(response.headers().firstValue("Allow").orElseThrow().contains("GET"));
        assertEquals(0, facilitator.verifyCalls());
    }

    @Test
    void requiresPaymentForHeadRequests() throws Exception {
        HttpResponse<String> response = send("HEAD", "/paid/premium", null);

        assertEquals(402, response.statusCode());
        assertTrue(response.headers().firstValue("PAYMENT-REQUIRED").isPresent());
    }

    @Test
    void requiresPaymentForOtherMethodsOnAMethodlessRoute() throws Exception {
        assertEquals(402, send("POST", "/paid/premium", null).statusCode());
        assertEquals(402, send("DELETE", "/paid/premium", null).statusCode());
    }

    private static Filter upstreamCorsFilter() {
        return (request, response, chain) -> {
            ((HttpServletResponse) response).setHeader("Access-Control-Allow-Origin", ORIGIN);
            chain.doFilter(request, response);
        };
    }

    /** Paid servlet that sets the kinds of headers a real handler would and reads the request attributes. */
    private static final class Premium extends HttpServlet {

        private static final long serialVersionUID = 1L;

        @Override
        protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
            PaymentRequirements matched =
                    (PaymentRequirements) req.getAttribute(PaymentFilter.PAYMENT_REQUIREMENTS_ATTRIBUTE);
            PaymentPayload payload = (PaymentPayload) req.getAttribute(PaymentFilter.PAYMENT_PAYLOAD_ATTRIBUTE);
            resp.setContentType("application/json");
            resp.setHeader("Cache-Control", "max-age=60");
            resp.setHeader("X-Handler", "yes");
            resp.addCookie(new Cookie("session", "granted"));
            String body = "{\"secret\":\"" + SECRET + "\",\"amount\":\"" + matched.amount() + "\"}";
            resp.setContentLength(body.length());
            resp.getWriter().print(payload == null ? "missing payload" : body);
        }

        @Override
        protected void doPost(HttpServletRequest req, HttpServletResponse resp) throws IOException {
            doGet(req, resp);
        }

        @Override
        protected void doDelete(HttpServletRequest req, HttpServletResponse resp) throws IOException {
            doGet(req, resp);
        }
    }

    @FunctionalInterface
    private interface Handler {
        void handle(HttpServletRequest req, HttpServletResponse resp) throws IOException, ServletException;
    }

    private static HttpServlet servlet(Handler handler) {
        return new HttpServlet() {
            private static final long serialVersionUID = 1L;

            @Override
            protected void doGet(HttpServletRequest req, HttpServletResponse resp)
                    throws IOException, ServletException {
                handler.handle(req, resp);
            }
        };
    }
}
