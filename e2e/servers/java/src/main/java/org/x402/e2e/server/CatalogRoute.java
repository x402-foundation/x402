package org.x402.e2e.server;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.Map;

/**
 * One paid HTTP route as declared in a {@code mechanisms_<id>.json} file.
 *
 * @param path the route path, e.g. {@code /exact/evm/eip3009}
 * @param networkId the catalog network id, i.e. the file id, e.g. {@code evm}
 * @param scheme the payment scheme
 * @param assetTransferMethod the declared asset transfer method, or {@code null}
 * @param paymentFlow the declared payment flow, or {@code null} for {@code authorization}
 * @param price the raw price declaration
 * @param requirementsExtra extra requirements data declared by the route
 * @param schemeExtra scheme data merged over every other {@code extra}
 */
public record CatalogRoute(
        String path,
        String networkId,
        String scheme,
        String assetTransferMethod,
        String paymentFlow,
        JsonNode price,
        Map<String, Object> requirementsExtra,
        Map<String, Object> schemeExtra) {
}
