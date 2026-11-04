package org.x402.e2e.server;

import org.x402.Price;

import java.util.Map;

/**
 * A catalog route with its network, payee and price resolved against the process environment.
 *
 * @param path the route path
 * @param networkId the catalog network id, e.g. {@code evm}
 * @param scheme the payment scheme
 * @param network the concrete CAIP-2 network, e.g. {@code eip155:84532}
 * @param payTo the payee address
 * @param price the price
 * @param extra extra requirements data, or {@code null}
 */
public record ResolvedRoute(
        String path,
        String networkId,
        String scheme,
        String network,
        String payTo,
        Price price,
        Map<String, Object> extra) {
}
