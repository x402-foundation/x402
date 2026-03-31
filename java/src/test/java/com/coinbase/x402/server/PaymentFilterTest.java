package com.coinbase.x402.server;

import com.coinbase.x402.client.FacilitatorClient;
import com.coinbase.x402.client.SettlementResponse;
import com.coinbase.x402.client.VerificationResponse;
import com.coinbase.x402.model.Authorization;
import com.coinbase.x402.model.ExactSchemePayload;
import com.coinbase.x402.model.PaymentPayload;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintWriter;
import java.math.BigInteger;
import java.util.Base64;
import java.util.Map;

import static org.mockito.Mockito.*;

class PaymentFilterTest {

    @Mock HttpServletRequest  req;
    @Mock HttpServletResponse resp;
    @Mock FilterChain         chain;
    @Mock FacilitatorClient   fac;

    private PaymentFilter filter;

    @BeforeEach
    void init() throws Exception {
        MockitoAnnotations.openMocks(this);

        // writer stub
        when(resp.getWriter()).thenReturn(new PrintWriter(new ByteArrayOutputStream(), true));

        filter = new PaymentFilter(
                "0xReceiver",
                Map.of("/private", BigInteger.TEN),
                fac
        );
    }

    /* ------------ free endpoint passes straight through --------------- */
    @Test
    void freeEndpoint() throws Exception {
        when(req.getRequestURI()).thenReturn("/public");

        filter.doFilter(req, resp, chain);

        verify(chain).doFilter(req, resp);
        verify(resp, never()).setStatus(anyInt());
    }

    /* ------------ missing header => 402 -------------------------------- */
    @Test
    void missingHeader() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");
        when(req.getHeader("X-PAYMENT")).thenReturn(null);

        filter.doFilter(req, resp, chain);

        verify(resp).setStatus(HttpServletResponse.SC_PAYMENT_REQUIRED);
        verify(chain, never()).doFilter(any(), any());
    }

    /* ------------ valid header => OK ----------------------------------- */
    @Test
    void validHeader() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");

        // build a syntactically correct header whose resource matches the path
        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme      = "exact";
        p.network     = "base-sepolia";
        p.payload     = Map.of("resource", "/private");
        String header = p.toHeader();
        when(req.getHeader("X-PAYMENT")).thenReturn(header);

        // facilitator says it's valid
        VerificationResponse vr = new VerificationResponse();
        vr.isValid = true;
        when(fac.verify(any(PaymentPayload.class), any())).thenReturn(vr);

        // handler returns 200 OK
        when(resp.getStatus()).thenReturn(HttpServletResponse.SC_OK);

        // settlement succeeds
        SettlementResponse sr = new SettlementResponse();
        sr.success = true;
        sr.txHash = "0xabcdef1234567890";
        sr.networkId = "base-sepolia";
        when(fac.settle(any(PaymentPayload.class), any())).thenReturn(sr);

        filter.doFilter(req, resp, chain);

        verify(chain).doFilter(req, resp);
        verify(resp, never()).setStatus(HttpServletResponse.SC_PAYMENT_REQUIRED);
        verify(fac).verify(any(PaymentPayload.class), any());
        verify(fac).settle(any(PaymentPayload.class), any());
    }

    /* ------------ error response skips settlement ------------------------- */
    @Test
    void errorResponseSkipsSettlement() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");

        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme      = "exact";
        p.network     = "base-sepolia";
        p.payload     = Map.of("resource", "/private");
        String header = p.toHeader();
        when(req.getHeader("X-PAYMENT")).thenReturn(header);

        VerificationResponse vr = new VerificationResponse();
        vr.isValid = true;
        when(fac.verify(any(PaymentPayload.class), any())).thenReturn(vr);

        // handler returns 500 error
        when(resp.getStatus()).thenReturn(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);

        filter.doFilter(req, resp, chain);

        verify(chain).doFilter(req, resp);
        // settle should NOT be called for error responses
        verify(fac, never()).settle(any(), any());
    }

    /* ------------ 4xx response skips settlement ---------------------------- */
    @Test
    void clientErrorResponseSkipsSettlement() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");

        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme      = "exact";
        p.network     = "base-sepolia";
        p.payload     = Map.of("resource", "/private");
        String header = p.toHeader();
        when(req.getHeader("X-PAYMENT")).thenReturn(header);

        VerificationResponse vr = new VerificationResponse();
        vr.isValid = true;
        when(fac.verify(any(PaymentPayload.class), any())).thenReturn(vr);

        // handler returns 404 error
        when(resp.getStatus()).thenReturn(HttpServletResponse.SC_NOT_FOUND);

        filter.doFilter(req, resp, chain);

        verify(chain).doFilter(req, resp);
        // settle should NOT be called for 4xx responses
        verify(fac, never()).settle(any(), any());
    }

    /* ------------ facilitator rejects payment → 402 ------------------- */
    @Test
    void facilitatorRejection() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");

        // well-formed header for /private
        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme      = "exact";
        p.network     = "base-sepolia";
        p.payload     = Map.of("resource", "/private");
        String header = p.toHeader();
        when(req.getHeader("X-PAYMENT")).thenReturn(header);

        // facilitator response: invalid
        VerificationResponse vr = new VerificationResponse();
        vr.isValid = false;
        vr.invalidReason = "insufficient funds";
        when(fac.verify(any(PaymentPayload.class), any())).thenReturn(vr);

        filter.doFilter(req, resp, chain);

        verify(resp).setStatus(HttpServletResponse.SC_PAYMENT_REQUIRED);
        verify(chain, never()).doFilter(any(), any());
        // settle must NOT be called
        verify(fac, never()).settle(any(), any());
    }

    /* ------------ resource mismatch in header → 402 ------------------- */
    @Test
    void resourceMismatch() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");

        // header says resource is /other
        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme      = "exact";
        p.network     = "base-sepolia";
        p.payload     = Map.of("resource", "/other");
        String header = p.toHeader();
        when(req.getHeader("X-PAYMENT")).thenReturn(header);

        filter.doFilter(req, resp, chain);

        verify(resp).setStatus(HttpServletResponse.SC_PAYMENT_REQUIRED);
        verify(chain, never()).doFilter(any(), any());
        // facilitator should NOT have been called
        verify(fac, never()).verify(any(), any());
    }
    
    /* ------------ empty header (vs null) → 402 ---------------------------- */
    @Test
    void emptyHeader() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");
        when(req.getHeader("X-PAYMENT")).thenReturn("");  // Empty string

        filter.doFilter(req, resp, chain);

        verify(resp).setStatus(HttpServletResponse.SC_PAYMENT_REQUIRED);
        verify(chain, never()).doFilter(any(), any());
    }

    /* ------------ non-HTTP request passes through without checks ---------- */
    @Test
    void nonHttpRequest() throws Exception {
        // Create non-HTTP servlet request and response
        ServletRequest nonHttpReq = mock(ServletRequest.class);
        ServletResponse nonHttpRes = mock(ServletResponse.class);
        
        filter.doFilter(nonHttpReq, nonHttpRes, chain);
        
        // Should pass through without any checks
        verify(chain).doFilter(nonHttpReq, nonHttpRes);
        verifyNoInteractions(fac);  // No facilitator interactions
    }

    /* ------------ exception parsing header → 402 -------------------------- */
    @Test
    void malformedHeader() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");
        when(req.getHeader("X-PAYMENT")).thenReturn("invalid-json-format");

        filter.doFilter(req, resp, chain);

        verify(resp).setStatus(HttpServletResponse.SC_PAYMENT_REQUIRED);
        verify(chain, never()).doFilter(any(), any());
    }

    /* ------------ exception during verification → 402 --------------------- */
    @Test
    void verificationException() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");
        
        // Create a valid header
        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme      = "exact";
        p.network     = "base-sepolia";
        p.payload     = Map.of("resource", "/private");
        String header = p.toHeader();
        when(req.getHeader("X-PAYMENT")).thenReturn(header);
        
        // Make facilitator throw exception during verify
        when(fac.verify(any(), any())).thenThrow(new IOException("Network error"));
        
        filter.doFilter(req, resp, chain);
        
        // IOException should return 500 status, not 402
        verify(resp).setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
        verify(resp).setContentType("application/json");
        verify(chain, never()).doFilter(any(), any());
    }

    /* ------------ exception during settlement returns 402 */
    @Test
    void settlementException() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");
        
        // Create a valid header
        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme      = "exact";
        p.network     = "base-sepolia";
        p.payload     = Map.of("resource", "/private");
        String header = p.toHeader();
        when(req.getHeader("X-PAYMENT")).thenReturn(header);
        
        // Verification succeeds
        VerificationResponse vr = new VerificationResponse();
        vr.isValid = true;
        when(fac.verify(any(PaymentPayload.class), any())).thenReturn(vr);

        // But settlement throws exception (should return 402)
        doThrow(new IOException("Network error")).when(fac).settle(any(PaymentPayload.class), any());
        
        filter.doFilter(req, resp, chain);
        
        // Request should be processed, but then settlement failure should return 402
        verify(chain).doFilter(req, resp);
        verify(resp).setStatus(HttpServletResponse.SC_PAYMENT_REQUIRED);
        
        // Verify and settle were both called
        verify(fac).verify(any(PaymentPayload.class), any());
        verify(fac).settle(any(PaymentPayload.class), any());
    }

    /* ------------ settlement failure returns 402 */
    @Test
    void settlementFailure() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");
        
        // Create a valid header
        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme      = "exact";
        p.network     = "base-sepolia";
        p.payload     = Map.of("resource", "/private");
        String header = p.toHeader();
        when(req.getHeader("X-PAYMENT")).thenReturn(header);
        
        // Verification succeeds
        VerificationResponse vr = new VerificationResponse();
        vr.isValid = true;
        when(fac.verify(any(PaymentPayload.class), any())).thenReturn(vr);

        // Settlement fails (facilitator returns success=false)
        SettlementResponse sr = new SettlementResponse();
        sr.success = false;
        sr.error = "insufficient balance";
        when(fac.settle(any(PaymentPayload.class), any())).thenReturn(sr);
        
        filter.doFilter(req, resp, chain);
        
        // Request should be processed, but then settlement failure should return 402
        verify(chain).doFilter(req, resp);
        verify(resp).setStatus(HttpServletResponse.SC_PAYMENT_REQUIRED);
        
        // Verify and settle were both called
        verify(fac).verify(any(PaymentPayload.class), any());
        verify(fac).settle(any(PaymentPayload.class), any());
    }

    /* ------------ payer extraction from payment payload ---------------- */
    @Test
    void payerExtractedFromPaymentPayload() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");
        
        // Create payment payload with proper authorization structure
        String payerAddress = "0x1234567890abcdef1234567890abcdef12345678";
        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme = "exact";
        p.network = "base-sepolia";
        
        // Create the exact EVM payload structure
        ExactSchemePayload exactPayload = new ExactSchemePayload();
        exactPayload.signature = "0x1234567890abcdef";
        exactPayload.authorization = new Authorization();
        exactPayload.authorization.from = payerAddress;
        exactPayload.authorization.to = "0xReceiver";
        exactPayload.authorization.value = "1000000";
        exactPayload.authorization.validAfter = "0";
        exactPayload.authorization.validBefore = "999999999999";
        exactPayload.authorization.nonce = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        
        // Since PaymentPayload.payload is Map<String,Object>, we need to set it as a Map
        p.payload = Map.of(
            "resource", "/private",
            "signature", exactPayload.signature,
            "authorization", Map.of(
                "from", exactPayload.authorization.from,
                "to", exactPayload.authorization.to,
                "value", exactPayload.authorization.value,
                "validAfter", exactPayload.authorization.validAfter,
                "validBefore", exactPayload.authorization.validBefore,
                "nonce", exactPayload.authorization.nonce
            )
        );
        
        String header = p.toHeader();
        when(req.getHeader("X-PAYMENT")).thenReturn(header);
        
        // Verification succeeds
        VerificationResponse vr = new VerificationResponse();
        vr.isValid = true;
        when(fac.verify(any(PaymentPayload.class), any())).thenReturn(vr);
        
        // Settlement succeeds  
        SettlementResponse sr = new SettlementResponse();
        sr.success = true;
        sr.txHash = "0xabcdef1234567890";
        sr.networkId = "base-sepolia";
        when(fac.settle(any(PaymentPayload.class), any())).thenReturn(sr);
        
        filter.doFilter(req, resp, chain);
        
        // Verify request was processed successfully
        verify(chain).doFilter(req, resp);
        verify(resp, never()).setStatus(HttpServletResponse.SC_PAYMENT_REQUIRED);
        
        // Verify X-PAYMENT-RESPONSE header was set
        verify(resp).setHeader(eq("X-PAYMENT-RESPONSE"), any());
        verify(resp).setHeader(eq("Access-Control-Expose-Headers"), eq("X-PAYMENT-RESPONSE"));
        
        // Capture the settlement response header to verify payer was included
        org.mockito.ArgumentCaptor<String> headerCaptor = org.mockito.ArgumentCaptor.forClass(String.class);
        verify(resp).setHeader(eq("X-PAYMENT-RESPONSE"), headerCaptor.capture());
        
        // Decode and verify the settlement response contains the correct payer
        String base64Header = headerCaptor.getValue();
        String jsonString = new String(Base64.getDecoder().decode(base64Header));
        
        // Verify the JSON contains the expected payer address
        org.junit.jupiter.api.Assertions.assertTrue(jsonString.contains("\"payer\":\"" + payerAddress + "\""),
            "Settlement response should contain payer address: " + jsonString);
        org.junit.jupiter.api.Assertions.assertTrue(jsonString.contains("\"success\":true"),
            "Settlement response should indicate success: " + jsonString);
    }

    /* ------------ payer extraction with missing authorization ----------- */
    @Test
    void payerExtractionWithMissingAuthorization() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");
        
        // Create payment payload without authorization
        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme = "exact";
        p.network = "base-sepolia";
        p.payload = Map.of("resource", "/private");
        
        String header = p.toHeader();
        when(req.getHeader("X-PAYMENT")).thenReturn(header);
        
        // Verification succeeds
        VerificationResponse vr = new VerificationResponse();
        vr.isValid = true;
        when(fac.verify(any(PaymentPayload.class), any())).thenReturn(vr);
        
        // Settlement succeeds  
        SettlementResponse sr = new SettlementResponse();
        sr.success = true;
        sr.txHash = "0xabcdef1234567890";
        sr.networkId = "base-sepolia";
        when(fac.settle(any(PaymentPayload.class), any())).thenReturn(sr);
        
        filter.doFilter(req, resp, chain);
        
        // Verify request was processed successfully
        verify(chain).doFilter(req, resp);
        verify(resp, never()).setStatus(HttpServletResponse.SC_PAYMENT_REQUIRED);
        
        // Capture the settlement response header
        org.mockito.ArgumentCaptor<String> headerCaptor = org.mockito.ArgumentCaptor.forClass(String.class);
        verify(resp).setHeader(eq("X-PAYMENT-RESPONSE"), headerCaptor.capture());
        
        // Decode and verify the settlement response has null payer
        String base64Header = headerCaptor.getValue();
        String jsonString = new String(Base64.getDecoder().decode(base64Header));
        
        // Verify the JSON contains null payer when authorization is missing
        org.junit.jupiter.api.Assertions.assertTrue(jsonString.contains("\"payer\":null"),
            "Settlement response should contain null payer when authorization missing: " + jsonString);
    }

    /* ------------ payer extraction with malformed authorization --------- */
    @Test
    void payerExtractionWithMalformedAuthorization() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");
        
        // Create payment payload with malformed authorization (string instead of object)
        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme = "exact";
        p.network = "base-sepolia";
        p.payload = Map.of(
            "resource", "/private",
            "authorization", "malformed-string"  // Should be an object, not a string
        );
        
        String header = p.toHeader();
        when(req.getHeader("X-PAYMENT")).thenReturn(header);
        
        // Verification succeeds
        VerificationResponse vr = new VerificationResponse();
        vr.isValid = true;
        when(fac.verify(any(PaymentPayload.class), any())).thenReturn(vr);
        
        // Settlement succeeds  
        SettlementResponse sr = new SettlementResponse();
        sr.success = true;
        sr.txHash = "0xabcdef1234567890";
        sr.networkId = "base-sepolia";
        when(fac.settle(any(PaymentPayload.class), any())).thenReturn(sr);
        
        filter.doFilter(req, resp, chain);
        
        // Verify request was processed successfully (payer extraction failure should not break processing)
        verify(chain).doFilter(req, resp);
        verify(resp, never()).setStatus(HttpServletResponse.SC_PAYMENT_REQUIRED);
        
        // Capture the settlement response header
        org.mockito.ArgumentCaptor<String> headerCaptor = org.mockito.ArgumentCaptor.forClass(String.class);
        verify(resp).setHeader(eq("X-PAYMENT-RESPONSE"), headerCaptor.capture());
        
        // Decode and verify the settlement response has null payer for malformed data
        String base64Header = headerCaptor.getValue();
        String jsonString = new String(Base64.getDecoder().decode(base64Header));
        
        // Verify the JSON contains null payer when authorization is malformed
        org.junit.jupiter.api.Assertions.assertTrue(jsonString.contains("\"payer\":null"),
            "Settlement response should contain null payer when authorization malformed: " + jsonString);
    }

    /* ------------ facilitator IOException returns 500 --------------------- */
    @Test
    void facilitatorIOExceptionReturns500() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");
        
        // Create a valid header
        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme = "exact";
        p.network = "base-sepolia";
        p.payload = Map.of("resource", "/private");
        String header = p.toHeader();
        when(req.getHeader("X-PAYMENT")).thenReturn(header);
        
        // Make facilitator throw IOException during verify
        when(fac.verify(any(PaymentPayload.class), any())).thenThrow(new IOException("Network timeout"));
        
        filter.doFilter(req, resp, chain);
        
        // Should return 500 status for network errors
        verify(resp).setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
        verify(resp).setContentType("application/json");
        verify(chain, never()).doFilter(any(), any());
        
        // Verify error message is written to response
        verify(resp).getWriter();
    }

    /* ------------ facilitator unexpected exception returns 500 ------------ */
    @Test
    void facilitatorUnexpectedExceptionReturns500() throws Exception {
        when(req.getRequestURI()).thenReturn("/private");
        
        // Create a valid header
        PaymentPayload p = new PaymentPayload();
        p.x402Version = 1;
        p.scheme = "exact";
        p.network = "base-sepolia";
        p.payload = Map.of("resource", "/private");
        String header = p.toHeader();
        when(req.getHeader("X-PAYMENT")).thenReturn(header);
        
        // Make facilitator throw unexpected exception during verify
        when(fac.verify(any(PaymentPayload.class), any())).thenThrow(new RuntimeException("Unexpected error"));
        
        filter.doFilter(req, resp, chain);
        
        // Should return 500 status for unexpected errors
        verify(resp).setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
        verify(resp).setContentType("application/json");
        verify(chain, never()).doFilter(any(), any());
        
        // Verify error message is written to response
        verify(resp).getWriter();
    }
}
