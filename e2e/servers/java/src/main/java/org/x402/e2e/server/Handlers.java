package org.x402.e2e.server;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.UncheckedIOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Response bodies and startup output shared by the Java e2e servers, mirroring {@code e2e/servers/go/handlers.go}.
 * Everything is derived from the catalog, so no server entrypoint names a network, a route or a price.
 */
public final class Handlers {

    /** Path of the unpaid health check the harness polls. */
    public static final String HEALTH_PATH = "/health";

    /** Path the harness posts to when it is done with the server. */
    public static final String CLOSE_PATH = "/close";

    /** The fixed message every paid route returns. */
    public static final String PROTECTED_ROUTE_MESSAGE = "Protected endpoint accessed successfully";

    private static final ObjectMapper JSON = new ObjectMapper();

    private Handlers() {
    }

    /**
     * Returns the body of a paid route.
     *
     * @return {@code {"message":"Protected endpoint accessed successfully","timestamp":"<ISO-8601>"}}
     */
    public static Map<String, Object> routeBody() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("message", PROTECTED_ROUTE_MESSAGE);
        body.put("timestamp", Instant.now().toString());
        return body;
    }

    /**
     * Returns the {@code /health} body, listing the networks the routes are served on and their payees.
     *
     * @param routes the resolved routes
     * @return the body
     */
    public static Map<String, Object> healthBody(List<ResolvedRoute> routes) {
        Map<String, Object> networks = new LinkedHashMap<>();
        for (ResolvedRoute route : routes) {
            networks.putIfAbsent(route.networkId(), Map.of("network", route.network(), "payee", route.payTo()));
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "ok");
        body.put("version", "2.0.0");
        body.put("networks", networks);
        return body;
    }

    /**
     * Returns the {@code /close} body.
     *
     * @return the body
     */
    public static Map<String, Object> closeBody() {
        return Map.of("message", "Server shutting down gracefully");
    }

    /**
     * Returns the 501 body of a catalog route whose network has no payee configured.
     *
     * @param route the route
     * @return the body
     */
    public static Map<String, Object> unconfiguredBody(CatalogRoute route) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", route.networkId().toUpperCase(Locale.ROOT) + " payments not configured");
        body.put("message", Catalog.serverAddressEnvKey(route.networkId()) + " environment variable is not set");
        return body;
    }

    /**
     * Renders the startup output. Its last line is the {@code Server listening} line the harness waits for.
     *
     * @param title the server name
     * @param address the base URL the server listens on
     * @param config the server configuration
     * @param routes the resolved routes
     * @return the lines to print
     */
    public static String startupBanner(String title, String address, ServerConfig config, List<ResolvedRoute> routes) {
        List<String> lines = new ArrayList<>();
        lines.add(title);
        lines.add("  Facilitator: " + config.facilitatorUrl());
        config.payees().forEach((networkId, payee) -> lines.add("  " + networkId + " payee: " + payee));
        for (ResolvedRoute route : routes) {
            lines.add("  GET  " + route.path() + "  (" + route.network() + " " + route.scheme() + ")");
        }
        lines.add("  GET  " + HEALTH_PATH + "  (no payment required)");
        lines.add("  POST " + CLOSE_PATH + "  (shutdown server)");
        lines.add("Server listening on " + address);
        return String.join(System.lineSeparator(), lines);
    }

    /**
     * Serializes a response body.
     *
     * @param body the body
     * @return the JSON bytes
     */
    public static byte[] json(Object body) {
        try {
            return JSON.writeValueAsBytes(body);
        } catch (JsonProcessingException e) {
            throw new UncheckedIOException(e);
        }
    }
}
