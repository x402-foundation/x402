package org.x402;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ResourceConfigTest {

    private static final String PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
    private static final Price PRICE = Price.money("$0.001");

    @Test
    void factoryUsesDefaultTimeoutAndNoExtra() {
        ResourceConfig config = ResourceConfig.of("exact", PAY_TO, PRICE, "eip155:84532");

        assertEquals(0, config.maxTimeoutSeconds());
        assertNull(config.extra());
    }

    @Test
    void copiesExtraDefensively() {
        Map<String, Object> extra = new HashMap<>(Map.of("name", "USDC"));
        ResourceConfig config = new ResourceConfig("exact", PAY_TO, PRICE, "eip155:84532", 60, extra);
        extra.put("version", "2");

        assertEquals(Map.of("name", "USDC"), config.extra());
        assertThrows(UnsupportedOperationException.class, () -> config.extra().put("x", 1));
    }

    @Test
    void rejectsBlankSchemeAndPayTo() {
        assertThrows(IllegalArgumentException.class, () -> ResourceConfig.of(" ", PAY_TO, PRICE, "eip155:1"));
        assertThrows(IllegalArgumentException.class, () -> ResourceConfig.of("exact", "", PRICE, "eip155:1"));
    }

    @Test
    void rejectsWildcardAndMalformedNetworks() {
        assertThrows(IllegalArgumentException.class, () -> ResourceConfig.of("exact", PAY_TO, PRICE, "eip155:*"));
        assertThrows(IllegalArgumentException.class, () -> ResourceConfig.of("exact", PAY_TO, PRICE, "base-sepolia"));
    }

    @Test
    void rejectsNegativeTimeout() {
        assertThrows(IllegalArgumentException.class,
                () -> new ResourceConfig("exact", PAY_TO, PRICE, "eip155:1", -1, null));
    }
}
