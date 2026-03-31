package com.coinbase.x402.client;

import com.coinbase.x402.model.PaymentPayload;
import com.coinbase.x402.model.PaymentRequirements;
import com.github.tomakehurst.wiremock.WireMockServer;
import org.junit.jupiter.api.*;
import static com.github.tomakehurst.wiremock.client.WireMock.*;

import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class HttpFacilitatorClientTest {

    static WireMockServer wm;
    HttpFacilitatorClient client;

    @BeforeAll
    static void startServer() {
        wm = new WireMockServer(0);   // random port
        wm.start();
    }

    @AfterAll
    static void stopServer() { wm.stop(); }

    @BeforeEach
    void setUp() {
        wm.resetAll();
        client = new HttpFacilitatorClient("http://localhost:" + wm.port());
    }

    /** Helper to create a minimal PaymentPayload for testing */
    private PaymentPayload createTestPayload() {
        PaymentPayload payload = new PaymentPayload();
        payload.x402Version = 1;
        payload.scheme = "exact";
        payload.network = "base-sepolia";
        payload.payload = Map.of(
            "signature", "0xtest",
            "authorization", Map.of(
                "from", "0xPayer",
                "to", "0xReceiver",
                "value", "1000000"
            )
        );
        return payload;
    }
    
    @Test
    void constructorHandlesTrailingSlash() {
        // Create client with trailing slash
        HttpFacilitatorClient clientWithTrailingSlash = 
            new HttpFacilitatorClient("http://localhost:" + wm.port() + "/");
        
        // Stub a simple request to verify the URL is formatted correctly
        wm.stubFor(get(urlEqualTo("/supported"))
            .willReturn(aResponse()
                .withHeader("Content-Type","application/json")
                .withBody("{\"kinds\":[]}")));
        
        // This would fail with a 404 if the URL was not correctly handled
        assertDoesNotThrow(() -> clientWithTrailingSlash.supported());
    }

    @Test
    void verifyAndSettleHappyPath() throws Exception {
        // stub /verify
        wm.stubFor(post(urlEqualTo("/verify"))
            .willReturn(aResponse()
                .withHeader("Content-Type","application/json")
                .withBody("{\"isValid\":true}")));

        // stub /settle
        wm.stubFor(post(urlEqualTo("/settle"))
            .willReturn(aResponse()
                .withHeader("Content-Type","application/json")
                .withBody("{\"success\":true,\"txHash\":\"0xabc\",\"networkId\":\"1\"}")));

        PaymentPayload payload = createTestPayload();
        PaymentRequirements req = new PaymentRequirements();
        VerificationResponse vr = client.verify(payload, req);
        assertTrue(vr.isValid);

        SettlementResponse sr = client.settle(payload, req);
        assertTrue(sr.success);
        assertEquals("0xabc", sr.txHash);
    }

    @Test
    void supportedEndpoint() throws Exception {
        wm.stubFor(get(urlEqualTo("/supported"))
            .willReturn(aResponse()
                .withHeader("Content-Type","application/json")
                .withBody("{\"kinds\":[{\"scheme\":\"exact\",\"network\":\"base-sepolia\"}]}")));

        Set<Kind> kinds = client.supported();
        assertEquals(1, kinds.size());
        Kind k = kinds.iterator().next();
        assertEquals("exact", k.scheme);
        assertEquals("base-sepolia", k.network);
    }
    
    @Test
    void supportedEndpointWithEmptyKinds() throws Exception {
        // Test when the 'kinds' list is empty
        wm.stubFor(get(urlEqualTo("/supported"))
            .willReturn(aResponse()
                .withHeader("Content-Type","application/json")
                .withBody("{\"kinds\":[]}")));

        Set<Kind> kinds = client.supported();
        assertTrue(kinds.isEmpty());
    }
    
    @Test
    void supportedEndpointWithMissingKinds() throws Exception {
        // Test when the 'kinds' field is missing entirely
        wm.stubFor(get(urlEqualTo("/supported"))
            .willReturn(aResponse()
                .withHeader("Content-Type","application/json")
                .withBody("{\"otherField\":123}")));

        Set<Kind> kinds = client.supported();
        assertTrue(kinds.isEmpty());
    }
    
    @Test
    void verifyWithInvalidResponse() throws Exception {
        // Test handling of invalid JSON in the verify response
        wm.stubFor(post(urlEqualTo("/verify"))
            .willReturn(aResponse()
                .withHeader("Content-Type","application/json")
                .withBody("{\"isValid\":false,\"invalidReason\":\"insufficient balance\"}")));

        PaymentPayload payload = createTestPayload();
        PaymentRequirements req = new PaymentRequirements();
        VerificationResponse response = client.verify(payload, req);

        assertFalse(response.isValid);
        assertEquals("insufficient balance", response.invalidReason);
    }
    
    @Test
    void settleWithPartialResponse() throws Exception {
        // Test when settlement response only has some fields
        wm.stubFor(post(urlEqualTo("/settle"))
            .willReturn(aResponse()
                .withHeader("Content-Type","application/json")
                .withBody("{\"success\":true}")));  // Missing txHash and networkId

        PaymentPayload payload = createTestPayload();
        PaymentRequirements req = new PaymentRequirements();
        SettlementResponse response = client.settle(payload, req);

        assertTrue(response.success);
        assertNull(response.txHash);  // Should be null since it wasn't in the response
        assertNull(response.networkId);
    }
    
    @Test
    void settleWithError() throws Exception {
        // Test settlement with error response
        wm.stubFor(post(urlEqualTo("/settle"))
            .willReturn(aResponse()
                .withHeader("Content-Type","application/json")
                .withBody("{\"success\":false,\"error\":\"payment timed out\"}")));

        PaymentPayload payload = createTestPayload();
        PaymentRequirements req = new PaymentRequirements();
        SettlementResponse response = client.settle(payload, req);

        assertFalse(response.success);
        assertEquals("payment timed out", response.error);
    }

    @Test
    void testNetworkTimeout() {
        // Test with a non-existent server to simulate network issues
        HttpFacilitatorClient badClient = new HttpFacilitatorClient("http://localhost:1");  // Port 1 should not be listening

        PaymentPayload payload = createTestPayload();
        PaymentRequirements req = new PaymentRequirements();

        // Both methods should throw an exception
        assertThrows(Exception.class, () -> badClient.verify(payload, req));
        assertThrows(Exception.class, () -> badClient.settle(payload, req));
        assertThrows(Exception.class, () -> badClient.supported());
    }

    @Test
    void verifyRejectsNon200Status() {
        PaymentPayload payload = createTestPayload();
        PaymentRequirements req = new PaymentRequirements();

        // Test HTTP 201 - should be rejected even though it's successful
        wm.stubFor(post(urlEqualTo("/verify"))
            .willReturn(aResponse()
                .withStatus(201)
                .withHeader("Content-Type", "application/json")
                .withBody("{\"isValid\":true}")));

        Exception ex = assertThrows(Exception.class, () -> client.verify(payload, req));
        assertTrue(ex.getMessage().contains("HTTP 201"));
    }

    @Test
    void settleRejectsNon200Status() {
        PaymentPayload payload = createTestPayload();
        PaymentRequirements req = new PaymentRequirements();

        // Test HTTP 404
        wm.stubFor(post(urlEqualTo("/settle"))
            .willReturn(aResponse()
                .withStatus(404)
                .withHeader("Content-Type", "application/json")
                .withBody("{\"error\":\"not found\"}")));

        Exception ex = assertThrows(Exception.class, () -> client.settle(payload, req));
        assertTrue(ex.getMessage().contains("HTTP 404"));
        assertTrue(ex.getMessage().contains("not found"));
    }

    @Test
    void supportedRejectsNon200Status() {
        // Test HTTP 500
        wm.stubFor(get(urlEqualTo("/supported"))
            .willReturn(aResponse()
                .withStatus(500)
                .withHeader("Content-Type", "application/json")
                .withBody("{\"error\":\"internal server error\"}")));
        
        Exception ex = assertThrows(Exception.class, () -> client.supported());
        assertTrue(ex.getMessage().contains("HTTP 500"));
        assertTrue(ex.getMessage().contains("internal server error"));
    }

    @Test
    void verifyHandles400BadRequest() {
        PaymentPayload payload = createTestPayload();
        PaymentRequirements req = new PaymentRequirements();

        wm.stubFor(post(urlEqualTo("/verify"))
            .willReturn(aResponse()
                .withStatus(400)
                .withHeader("Content-Type", "application/json")
                .withBody("{\"error\":\"invalid payment header\"}")));

        Exception ex = assertThrows(Exception.class, () -> client.verify(payload, req));
        assertTrue(ex.getMessage().contains("HTTP 400"));
        assertTrue(ex.getMessage().contains("invalid payment header"));
    }
}
