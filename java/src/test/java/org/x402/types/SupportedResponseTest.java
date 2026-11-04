package org.x402.types;

import org.junit.jupiter.api.Test;
import org.x402.util.Json;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class SupportedResponseTest {

    private static final String SIGNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

    @Test
    void copiesSignerListsOnConstruction() {
        List<String> addresses = new ArrayList<>(List.of(SIGNER));
        SupportedResponse response = new SupportedResponse(List.of(), List.of(), Map.of("eip155:*", addresses));

        addresses.add("0x0000000000000000000000000000000000000001");

        assertEquals(List.of(SIGNER), response.signers().get("eip155:*"));
        assertThrows(UnsupportedOperationException.class, () -> response.signers().get("eip155:*").add("0x1"));
        assertThrows(UnsupportedOperationException.class, () -> response.signers().put("solana:*", List.of()));
    }

    @Test
    void keepsSignerListsReadFromJsonImmutable() throws IOException {
        SupportedResponse response = Json.read(
                "{\"kinds\":[],\"signers\":{\"eip155:*\":[\"" + SIGNER + "\",null]}}", SupportedResponse.class);

        assertEquals(Arrays.asList(SIGNER, null), response.signers().get("eip155:*"));
        assertThrows(UnsupportedOperationException.class, () -> response.signers().get("eip155:*").clear());
    }

    @Test
    void keepsNullSignerListsAndDefaultsAbsentCollections() {
        Map<String, List<String>> signers = new HashMap<>();
        signers.put("eip155:*", null);

        assertNull(new SupportedResponse(null, null, signers).signers().get("eip155:*"));
        assertEquals(new SupportedResponse(List.of(), List.of(), Map.of()), new SupportedResponse(null, null, null));
    }
}
