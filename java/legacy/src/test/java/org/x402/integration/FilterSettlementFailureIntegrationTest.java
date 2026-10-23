package org.x402.integration;

import org.x402.client.FacilitatorClient;
import org.x402.client.Kind;
import org.x402.client.SettlementResponse;
import org.x402.client.VerificationResponse;
import org.x402.model.PaymentPayload;
import org.x402.model.PaymentRequirements;
import org.x402.server.PaymentFilter;
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
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Embedded-Jetty regression test for issue #3068: PaymentFilter must not deliver the protected
 * response body to the client if settlement fails after the handler has already run. Before the
 * fix, {@code chain.doFilter()} wrote straight to the real response, committing it before
 * {@code settle()} was even called - a facilitator-side failure (network error, RPC timeout,
 * outage) meant the buyer already had the content with no payment settled.
 */
class FilterSettlementFailureIntegrationTest {

    static Server jetty;
    static int    port;
    static HttpClient http = HttpClient.newHttpClient();

    @BeforeAll
    static void startJetty() throws Exception {
        // Facilitator that always verifies the payment but always fails to settle it -
        // simulates a facilitator outage/RPC timeout discovered only after business logic ran.
        FacilitatorClient stubFac = new FacilitatorClient() {
            @Override public VerificationResponse verify(String hdr, PaymentRequirements r) {
                VerificationResponse vr = new VerificationResponse();
                vr.isValid = true;
                return vr;
            }
            @Override public SettlementResponse settle(String h, PaymentRequirements r) {
                SettlementResponse sr = new SettlementResponse();
                sr.success = false;
                sr.error = "simulated settlement failure";
                return sr;
            }
            @Override public Set<Kind> supported() { return Set.of(); }
        };

        Map<String, java.math.BigInteger> priced = Map.of("/premium", java.math.BigInteger.ONE);

        jetty = new Server(0);
        ServletContextHandler ctx = new ServletContextHandler();
        ctx.setContextPath("/");

        // business servlet that would deliver paywalled content if allowed to reach the client
        ctx.addServlet(new ServletHolder(new HttpServlet() {
            @Override protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
                resp.setContentType("application/json");
                try (PrintWriter w = resp.getWriter()) {
                    w.write("{\"secret\":\"premium content\"}");
                }
            }
        }), "/premium");

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

    @Test
    void settlementFailureDoesNotDeliverContent() throws Exception {
        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme      = "exact";
        p.network     = "base-sepolia";
        p.payload     = Map.of("resource", "/premium");
        String hdr = p.toHeader();

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create("http://localhost:" + port + "/premium"))
                .header("X-PAYMENT", hdr)
                .GET()
                .build();

        HttpResponse<String> rsp = http.send(req, HttpResponse.BodyHandlers.ofString());

        // Before the fix this returned 200 with the premium body already delivered, since
        // chain.doFilter() committed the response before settle() was ever consulted.
        assertEquals(402, rsp.statusCode());
        assertFalse(rsp.body().contains("premium content"),
                "premium content must never reach the client when settlement fails");
    }
}
