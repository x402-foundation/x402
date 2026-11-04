package org.x402.e2e.server;

import org.x402.SchemeNetworkServer;
import org.x402.X402ResourceServer;
import org.x402.http.HttpFacilitatorClient;
import org.x402.mechanisms.evm.EvmConstants;
import org.x402.mechanisms.evm.exact.ExactEvmServerScheme;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Environment shared by the Java e2e resource servers, mirroring {@code e2e/servers/go/config.go}.
 *
 * <p>{@code MOCK_FACILITATOR_URL} is ignored, as in the Python servers: every facilitator the harness runs supports
 * the routes Java serves, so there are no {@code /supported} gaps for the mock to fill.
 *
 * @param port the port to listen on, from {@code PORT}, 4021 by default
 * @param facilitatorUrl the facilitator base URL, from {@code FACILITATOR_URL}
 * @param payees the payee address per catalog network id, from {@code SERVER_<ID>_ADDRESS}
 */
public record ServerConfig(int port, String facilitatorUrl, Map<String, String> payees) {

    private static final String DEFAULT_PORT = "4021";
    private static final String EVM = "evm";

    /**
     * Reads the configuration.
     *
     * @param env the environment
     * @param catalog the catalog, which names the networks that may have a payee
     * @return the configuration
     * @throws IllegalStateException if {@code FACILITATOR_URL} or every payee is missing
     * @throws NumberFormatException if {@code PORT} is not a number
     */
    public static ServerConfig fromEnv(Map<String, String> env, Catalog catalog) {
        int port = Integer.parseInt(env.getOrDefault("PORT", DEFAULT_PORT));
        String facilitatorUrl = env.get("FACILITATOR_URL");
        if (facilitatorUrl == null || facilitatorUrl.isBlank()) {
            throw new IllegalStateException("FACILITATOR_URL environment variable is required");
        }
        Map<String, String> payees = new TreeMap<>();
        for (CatalogRoute route : catalog.routes()) {
            String payee = env.get(Catalog.serverAddressEnvKey(route.networkId()));
            if (payee != null && !payee.isBlank()) {
                payees.put(route.networkId(), payee);
            }
        }
        if (payees.isEmpty()) {
            throw new IllegalStateException("At least one SERVER_*_ADDRESS for a Java catalog network is required");
        }
        return new ServerConfig(port, facilitatorUrl, Map.copyOf(payees));
    }

    /**
     * Builds the resource server for the resolved routes: the facilitator at {@link #facilitatorUrl()}, and one
     * scheme server per route network and scheme. As in Go, schemes are registered for the concrete CAIP-2
     * network, which is how the resource server looks them up.
     *
     * @param routes the resolved routes
     * @return the resource server, not yet initialized
     * @throws IllegalStateException if a route uses a scheme the Java SDK does not implement
     */
    public X402ResourceServer resourceServer(List<ResolvedRoute> routes) {
        X402ResourceServer.Builder builder = X402ResourceServer.builder()
                .facilitator(HttpFacilitatorClient.builder().url(facilitatorUrl).build());
        Set<String> registered = new HashSet<>();
        for (ResolvedRoute route : routes) {
            if (registered.add(route.network() + "|" + route.scheme())) {
                builder.register(route.network(), schemeServer(route));
            }
        }
        return builder.build();
    }

    private static SchemeNetworkServer schemeServer(ResolvedRoute route) {
        if (EVM.equals(route.networkId()) && EvmConstants.SCHEME_EXACT.equals(route.scheme())) {
            return new ExactEvmServerScheme();
        }
        throw new IllegalStateException("No Java scheme server for " + route.scheme() + " on " + route.networkId());
    }
}
