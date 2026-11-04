package org.x402.mechanisms.evm;

import org.junit.jupiter.api.Test;
import org.x402.Network;

import java.math.BigInteger;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class EvmNetworksTest {

    @Test
    void parsesChainIds() {
        assertEquals(BigInteger.valueOf(84532), EvmNetworks.chainId("eip155:84532"));
        assertEquals(BigInteger.ONE, EvmNetworks.chainId("eip155:1"));
        assertEquals(new BigInteger("9".repeat(32)), EvmNetworks.chainId("eip155:" + "9".repeat(32)));
    }

    @Test
    void rejectsNetworksWithoutAPositiveCanonicalChainId() {
        for (String invalid : List.of("eip155:0", "eip155:01", "eip155:-1", "eip155:", "eip155:abc",
                "eip155:84532 ", "EIP155:1", "eip155:" + "9".repeat(33), "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
                "base-sepolia", "")) {
            IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                    () -> EvmNetworks.chainId(invalid), invalid);
            assertTrue(e.getMessage().startsWith("Unsupported network: "), e.getMessage());
        }
    }

    @Test
    void familyMatchesEveryEvmNetwork() {
        assertEquals("eip155:*", EvmNetworks.FAMILY);
        assertTrue(Network.matches(EvmNetworks.FAMILY, "eip155:8453"));
        assertEquals(EvmNetworks.NAMESPACE, Network.namespace("eip155:8453"));
    }
}
