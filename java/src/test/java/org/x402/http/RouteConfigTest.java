package org.x402.http;

import org.x402.Price;
import org.x402.ResourceConfig;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RouteConfigTest {

    private static final String PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

    private static PaymentOption.Builder option() {
        return PaymentOption.builder()
                .scheme("exact")
                .network("eip155:84532")
                .payTo(PAY_TO)
                .price(Price.money("$0.001"));
    }

    @Test
    void buildsAPaymentOptionAndConvertsItToAResourceConfig() {
        PaymentOption option = option().maxTimeoutSeconds(60).extra(Map.of("memo", "x")).build();

        assertEquals(new ResourceConfig("exact", PAY_TO, Price.money("$0.001"), "eip155:84532", 60,
                Map.of("memo", "x")), option.toResourceConfig());
    }

    @Test
    void validatesPaymentOptionsLikeResourceConfigs() {
        assertThrows(NullPointerException.class, () -> option().scheme(null).build());
        assertThrows(IllegalArgumentException.class, () -> option().network("eip155:*").build());
        assertThrows(IllegalArgumentException.class, () -> option().payTo(" ").build());
        assertThrows(IllegalArgumentException.class, () -> option().maxTimeoutSeconds(-5).build());
    }

    @Test
    void copiesPaymentOptionExtra() {
        Map<String, Object> extra = new HashMap<>(Map.of("memo", "x"));
        PaymentOption option = option().extra(extra).build();
        extra.put("other", 1);

        assertEquals(Map.of("memo", "x"), option.extra());
        assertThrows(UnsupportedOperationException.class, () -> option.extra().clear());
        assertNull(option().build().extra());
    }

    @Test
    void buildsARouteConfigInDeclarationOrder() {
        PaymentOption first = option().build();
        PaymentOption second = option().price(Price.money("$1")).build();

        RouteConfig route = RouteConfig.builder()
                .accept(first)
                .accepts(List.of(second))
                .resource("https://api.example.com/weather")
                .description("Weather")
                .mimeType("application/json")
                .extensions(Map.of("bazaar", Map.of()))
                .build();

        assertEquals(List.of(first, second), route.accepts());
        assertEquals("https://api.example.com/weather", route.resource());
        assertEquals("Weather", route.description());
        assertEquals("application/json", route.mimeType());
        assertEquals(Map.of("bazaar", Map.of()), route.extensions());
    }

    @Test
    void copiesRouteConfigCollections() {
        List<PaymentOption> accepts = new ArrayList<>(List.of(option().build()));
        Map<String, Object> extensions = new HashMap<>(Map.of("a", 1));
        RouteConfig route = new RouteConfig(accepts, null, null, null, extensions);
        accepts.clear();
        extensions.clear();

        assertEquals(1, route.accepts().size());
        assertEquals(Map.of("a", 1), route.extensions());
        assertThrows(UnsupportedOperationException.class, () -> route.accepts().clear());
        assertTrue(RouteConfig.builder().build().accepts().isEmpty());
    }

    @Test
    void validatesResponseInstructions() {
        HttpResponseInstructions instructions =
                new HttpResponseInstructions(402, Map.of("Content-Type", "application/json"), "{\"error\":\"é\"}");

        assertArrayEquals("{\"error\":\"é\"}".getBytes(StandardCharsets.UTF_8), instructions.bodyBytes());
        assertThrows(IllegalArgumentException.class, () -> new HttpResponseInstructions(99, Map.of(), ""));
        assertThrows(IllegalArgumentException.class, () -> new HttpResponseInstructions(600, Map.of(), ""));
    }

    @Test
    void requiresAtLeastOneRouteProblem() {
        assertThrows(IllegalArgumentException.class, () -> new RouteConfigurationException(List.of()));
    }
}
