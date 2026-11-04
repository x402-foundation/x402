package org.x402.e2e.server;

import org.x402.http.PaymentOption;
import org.x402.http.RouteConfig;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Builds the payment routes from the catalog, mirroring {@code e2e/servers/go/routes.go}.
 *
 * <p>Declared route extensions are not attached: the Java SDK implements none of them, so its servers list no
 * extensions in their {@code test.config.json} and the harness does not expect any.
 */
public final class Routes {

    private Routes() {
    }

    /**
     * Returns one {@code GET <path>} route per resolved route, accepting that route's single payment option.
     *
     * @param routes the resolved routes
     * @return the route configurations, in catalog order
     */
    public static Map<String, RouteConfig> build(List<ResolvedRoute> routes) {
        Map<String, RouteConfig> configs = new LinkedHashMap<>();
        for (ResolvedRoute route : routes) {
            PaymentOption option = PaymentOption.builder()
                    .scheme(route.scheme())
                    .network(route.network())
                    .payTo(route.payTo())
                    .price(route.price())
                    .extra(route.extra())
                    .build();
            configs.put("GET " + route.path(), RouteConfig.builder().accept(option).build());
        }
        return configs;
    }
}
