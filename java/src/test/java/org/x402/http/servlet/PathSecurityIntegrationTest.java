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
import org.x402.types.PaymentRequirements;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.eclipse.jetty.http.UriCompliance;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Proves that no request path reaches a paid servlet without payment, for Jetty's default URI handling and for
 * the lenient modes some deployments enable. An unprotected control server shows which encodings the container
 * dispatches to the protected servlet; the protected server must answer every one of them with 402.
 */
class PathSecurityIntegrationTest {

    private static final String SECRET = "premium-secret";
    private static final String NETWORK = "eip155:84532";
    private static final String PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

    /** What {@link FakeSchemeServer} advertises for the {@code $0.001} route. */
    private static final PaymentRequirements CHEAP_REQUIREMENTS = new PaymentRequirements("exact", NETWORK,
            FakeSchemeServer.ASSET, "1000", PAY_TO, 300, Map.of("name", "USDC", "version", "2"));

    private static final List<String> TIERED_ATTACK_PATHS = List.of(
            "/premium",
            "/public/../premium",
            "/public/x/../../premium",
            "/cheap/../premium",
            "/cheap/x/../../premium",
            "/public/%2e%2e/premium",
            "/cheap/%2e%2e/premium",
            "/cheap/.%2e/premium",
            "/public/..;/premium",
            "/cheap/..;/premium",
            "/cheap/%2E%2E/premium");

    private static final List<String> ATTACK_PATHS = List.of(
            "/premium",
            "/public/../premium",
            "/public/%2e%2e/premium",
            "/public/%2E%2E/premium",
            "/public/.%2e/premium",
            "/public/..;/premium",
            "/premium;jsessionid=1",
            "/premium;a=b",
            "//premium",
            "/./premium",
            "/%2e/premium",
            "/%70remium",
            "/%70%72%65%6d%69%75%6d",
            "/premium/",
            "/premium/.",
            "/Premium",
            "/premium%2F",
            "/public%2F..%2Fpremium",
            "/public%2f..%2fpremium",
            "/public/%2e%2e%2fpremium",
            "/x/%2e%2e/premium",
            "/premium%3Bx",
            "/premium%00",
            "/premium?x=1",
            "/public/premium");

    static Stream<Arguments> containers() {
        return Stream.of(
                Arguments.of("DEFAULT", List.of("/premium", "/public/../premium", "/premium;jsessionid=1",
                        "/./premium", "/%70remium", "/public%2F..%2Fpremium", "/public/%2e%2e%2fpremium")),
                Arguments.of("LEGACY", List.of("/public/%2e%2e/premium", "/public/.%2e/premium", "/x/%2e%2e/premium",
                        "/%2e/premium")),
                Arguments.of("UNSAFE", List.of("/public/..;/premium", "/public/%2E%2E/premium")));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("containers")
    void neverServesThePaidResourceWithoutPayment(String compliance, List<String> knownDispatches) throws Exception {
        UriCompliance mode = UriCompliance.valueOf(compliance);
        List<String> reachedSecret = new ArrayList<>();
        try (JettyServer control = server(mode, false); JettyServer protectedServer = server(mode, true)) {
            for (String path : ATTACK_PATHS) {
                RawHttp.Response unprotected = RawHttp.send(control.port(), "GET", path);
                RawHttp.Response response = RawHttp.send(protectedServer.port(), "GET", path);

                assertFalse(response.text().contains(SECRET), path + " leaked the paid resource");
                if (unprotected.text().contains(SECRET)) {
                    reachedSecret.add(path);
                    assertEquals(402, response.status(), path + " reaches the paid servlet and must require payment");
                    assertTrue(response.text().contains("PAYMENT-REQUIRED: "), path);
                }
            }
        }
        assertTrue(reachedSecret.containsAll(knownDispatches),
                "control server should dispatch " + knownDispatches + " to the paid servlet, got " + reachedSecret);
    }

    /**
     * Next to the premium route, a free carve-out and a cheap wildcard route each match the raw form of a path
     * that the container dispatches to the premium servlet. Such a path must be neither free nor sold at the
     * cheap price.
     */
    @ParameterizedTest(name = "{0}")
    @ValueSource(strings = {"DEFAULT", "LEGACY", "UNSAFE"})
    void neverServesThePremiumResourceThroughAFreeOrCheaperRoute(String compliance) throws Exception {
        UriCompliance mode = UriCompliance.valueOf(compliance);
        String cheapPayment = "PAYMENT-SIGNATURE: " + PaymentHeaders.encode(new PaymentPayload(
                2, Map.of("signature", "0x01"), CHEAP_REQUIREMENTS, null, null));
        List<String> reachedSecret = new ArrayList<>();
        try (JettyServer control = tieredServer(mode, false); JettyServer protectedServer = tieredServer(mode, true)) {
            for (String path : TIERED_ATTACK_PATHS) {
                if (!RawHttp.send(control.port(), "GET", path).text().contains(SECRET)) {
                    continue;
                }
                reachedSecret.add(path);
                RawHttp.Response unpaid = RawHttp.send(protectedServer.port(), "GET", path);
                RawHttp.Response paidCheap = RawHttp.send(protectedServer.port(), "GET", path, cheapPayment);

                for (RawHttp.Response response : List.of(unpaid, paidCheap)) {
                    assertFalse(response.text().contains(SECRET), path + " leaked the premium resource");
                    assertTrue(response.status() == 400 || response.status() == 402, path + ": " + response.text());
                }
            }

            assertEquals(200, RawHttp.send(protectedServer.port(), "GET", "/public/page").status());
            assertTrue(RawHttp.send(protectedServer.port(), "GET", "/cheap/item", cheapPayment).text()
                    .endsWith("cheap"));
            assertEquals(402, RawHttp.send(protectedServer.port(), "GET", "/premium", cheapPayment).status());
        }
        assertTrue(reachedSecret.containsAll(List.of("/public/../premium", "/cheap/../premium")),
                "control server should dispatch the dot-segment paths to the premium servlet, got " + reachedSecret);
    }

    private static JettyServer tieredServer(UriCompliance compliance, boolean protect) throws Exception {
        JettyServer jetty = new JettyServer(compliance)
                .servlet("/premium", new Body(SECRET))
                .servlet("/cheap/*", new Body("cheap"))
                .servlet("/public/*", new Body("public"));
        if (protect) {
            Map<String, RouteConfig> routes = new LinkedHashMap<>();
            routes.put("/public/*", RouteConfig.builder().build());
            routes.put("GET /cheap/*", RouteConfig.builder().accept(option("$0.001")).build());
            routes.put("GET /premium", RouteConfig.builder().accept(option("$10")).build());
            jetty.filter(new PaymentFilter(new HttpResourceServer(resourceServer(), routes)));
        }
        return jetty.start();
    }

    private static PaymentOption option(String price) {
        return PaymentOption.builder()
                .scheme("exact")
                .network(NETWORK)
                .payTo(PAY_TO)
                .price(Price.money(price))
                .build();
    }

    private static X402ResourceServer resourceServer() {
        return X402ResourceServer.builder()
                .register(NETWORK, new FakeSchemeServer("exact"))
                .facilitator(new FakeFacilitator(NETWORK))
                .build();
    }

    private static JettyServer server(UriCompliance compliance, boolean protect) throws Exception {
        JettyServer jetty = new JettyServer(compliance)
                .servlet("/premium", new Body(SECRET))
                .servlet("/public/*", new Body("public"));
        if (protect) {
            HttpResourceServer payments = new HttpResourceServer(
                    resourceServer(), Map.of("GET /premium", RouteConfig.builder().accept(option("$0.001")).build()));
            jetty.filter(new PaymentFilter(payments));
        }
        return jetty.start();
    }

    /** Servlet that writes a fixed body. */
    private static final class Body extends HttpServlet {

        private static final long serialVersionUID = 1L;

        private final String body;

        Body(String body) {
            this.body = body;
        }

        @Override
        protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
            resp.getWriter().print(body);
        }
    }
}
