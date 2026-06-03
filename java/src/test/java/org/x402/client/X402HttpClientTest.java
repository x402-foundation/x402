package org.x402.client;

import org.x402.crypto.CryptoSigner;
import org.x402.crypto.CryptoSignException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.io.IOException;
import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class X402HttpClientTest {
    
    @Mock
    private CryptoSigner mockSigner;
    
    private X402HttpClient client;
    
    @BeforeEach
    void setup() {
        MockitoAnnotations.openMocks(this);
        // Create client with mock signer
        client = new X402HttpClient(mockSigner) {
            // Override the internal HttpClient to avoid actual network calls
            @Override
            protected HttpResponse<String> sendRequest(HttpRequest request) throws IOException, InterruptedException {
                // Capture and verify the request, then return a mock response
                @SuppressWarnings("unchecked")
                HttpResponse<String> mockResponse = mock(HttpResponse.class);
                when(mockResponse.statusCode()).thenReturn(200);
                when(mockResponse.body()).thenReturn("{\"ok\":true}");
                return mockResponse;
            }
        };
    }

    @Test
    void testGet() throws IOException, InterruptedException, CryptoSignException {
        // Setup
        URI uri = URI.create("https://example.com/private");
        BigInteger amount = BigInteger.valueOf(1000);
        String assetContract = "0xTokenContract";
        String payTo = "0xReceiverAddress";
        
        // Mock the signer to return a fixed signature
        when(mockSigner.sign(any())).thenReturn("0xMockSignature");
        
        // Execute
        HttpResponse<String> response = client.get(uri, amount, assetContract, payTo);
        
        // Verify
        assertNotNull(response);
        assertEquals(200, response.statusCode());
        assertEquals("{\"ok\":true}", response.body());
        
        // Verify signer was called with proper payload
        try {
            verify(mockSigner).sign(argThat(payload -> {
                assertEquals(amount.toString(), payload.get("amount"));
                assertEquals(assetContract, payload.get("asset"));
                assertEquals(payTo, payload.get("payTo"));
                assertEquals("/private", payload.get("resource"));
                assertNotNull(payload.get("nonce"));
                return true;
            }));
        } catch (CryptoSignException e) {
            fail("Unexpected CryptoSignException: " + e.getMessage());
        }
    }
    
    @Test
    void testConstructor() {
        // Simply verify the constructor sets up the client properly
        X402HttpClient testClient = new X402HttpClient(mockSigner);
        assertNotNull(testClient);
    }
}