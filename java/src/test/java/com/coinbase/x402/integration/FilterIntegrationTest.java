package com.coinbase.x402.integration;

import com.coinbase.x402.client.FacilitatorClient;
import com.coinbase.x402.client.VerificationResponse;
import com.coinbase.x402.model.PaymentPayload;
import com.coinbase.x402.server.PaymentFilter;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.servlet.FilterHolder;
import org.eclipse.jetty.servlet.ServletContextHandler;
import org.eclipse.jetty.servlet.ServletHolder;
import org.junit.jupiter.api.*;

import java.io.IOException;
import java.io.PrintWriter;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Embedded-Jetty integration: real PaymentFilter + stub FacilitatorClient
 * + simple business servlet.
 */
class FilterIntegrationTest {

    static Server jetty;
    static int    port;
    static HttpClient http = HttpClient.newHttpClient();

    @BeforeAll
    static void startJetty() throws Exception {
        // ----- stub facilitator -----------------------------------------
        FacilitatorClient stubFac = new FacilitatorClient() {
            @Override public VerificationResponse verify(PaymentPayload payload, com.coinbase.x402.model.PaymentRequirements r) {
                VerificationResponse vr = new VerificationResponse();
                vr.isValid = true;                       // always accept
                return vr;
            }
            @Override public com.coinbase.x402.client.SettlementResponse settle(PaymentPayload payload, com.coinbase.x402.model.PaymentRequirements r) {
                com.coinbase.x402.client.SettlementResponse sr = new com.coinbase.x402.client.SettlementResponse();
                sr.success = true;
                return sr;
            }
            @Override public java.util.Set<com.coinbase.x402.client.Kind> supported() { return java.util.Set.of(); }
        };

        // price-table: /private costs 1 (value irrelevant here)
        Map<String, java.math.BigInteger> priced = Map.of("/private", java.math.BigInteger.ONE);

        // ----- Jetty context --------------------------------------------
        jetty  = new Server(0); // auto-choose port
        ServletContextHandler ctx = new ServletContextHandler();
        ctx.setContextPath("/");

        // business servlet at /private – returns 200 + JSON
        ctx.addServlet(new ServletHolder(new HttpServlet() {
            @Override protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
                resp.setContentType("application/json");
                try (PrintWriter w = resp.getWriter()) {
                    w.write("{\"ok\":true}");
                }
            }
        }), "/private");

        // register PaymentFilter
        ctx.addFilter(
                new FilterHolder(new PaymentFilter("0xReceiver", priced, stubFac)),
                "/*",
                null
        );

        jetty.setHandler(ctx);
        jetty.start();
        port = jetty.getURI().getPort();
    }

    @AfterAll
    static void stopJetty() throws Exception { jetty.stop(); }

    /* ---------- test: missing header -> 402 --------------------------- */
    @Test
    void missingHeaderGets402() throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://localhost:" + port + "/private"))
                .GET()
                .build();

        HttpResponse<String> rsp = http.send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(402, rsp.statusCode());
        assertTrue(rsp.body().contains("\"x402Version\":"));
    }

    /* ---------- test: valid header -> 200 ----------------------------- */
    @Test
    void validHeaderGets200() throws Exception {
        // build minimal payment header with matching resource
        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme      = "exact";
        p.network     = "base-sepolia";
        p.payload     = Map.of("resource", "/private");
        String hdr = p.toHeader();

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://localhost:" + port + "/private"))
                .header("X-PAYMENT", hdr)
                .GET()
                .build();

        HttpResponse<String> rsp = http.send(req, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, rsp.statusCode());
        assertEquals("{\"ok\":true}", rsp.body());
    }
}
