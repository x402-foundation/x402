package org.x402.http.servlet;

import org.x402.FacilitatorClient;
import org.x402.Price;
import org.x402.X402ResourceServer;
import org.x402.http.HttpResourceServer;
import org.x402.http.PaymentOption;
import org.x402.http.RouteConfig;
import org.x402.http.RouteConfigurationException;
import org.x402.testsupport.server.FakeFacilitator;
import org.x402.testsupport.server.FakeSchemeServer;

import jakarta.servlet.FilterChain;
import jakarta.servlet.FilterConfig;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class PaymentFilterTest {

    private static final String NETWORK = "eip155:84532";

    @AfterEach
    void clearInterruptFlag() {
        Thread.interrupted();
    }

    private static HttpResourceServer payments(FacilitatorClient facilitator, String network) {
        X402ResourceServer resourceServer = X402ResourceServer.builder()
                .register(NETWORK, new FakeSchemeServer("exact"))
                .facilitator(facilitator)
                .build();
        PaymentOption option = PaymentOption.builder()
                .scheme("exact").network(network).payTo("0x209693Bc6afc0C5328bA36FaF03C514EF312287C")
                .price(Price.money("$0.001")).build();
        return new HttpResourceServer(
                resourceServer, Map.of("GET /paid", RouteConfig.builder().accept(option).build()));
    }

    @Test
    void initializesTheServerOnce() throws Exception {
        FacilitatorClient facilitator = mock(FacilitatorClient.class);
        when(facilitator.supported()).thenReturn(new FakeFacilitator(NETWORK).supported());
        HttpResourceServer server = payments(facilitator, NETWORK);
        PaymentFilter filter = new PaymentFilter(server);

        filter.init(mock(FilterConfig.class));
        filter.init(mock(FilterConfig.class));

        assertTrue(server.isInitialized());
        verify(facilitator, times(1)).supported();
    }

    @Test
    void startsWhenTheFacilitatorIsUnreachableAndInitializesOnTheNextPaidRequest() throws Exception {
        FacilitatorClient facilitator = mock(FacilitatorClient.class);
        when(facilitator.supported())
                .thenThrow(new IOException("unreachable"))
                .thenReturn(new FakeFacilitator(NETWORK).supported());
        HttpResourceServer server = payments(facilitator, NETWORK);
        PaymentFilter filter = new PaymentFilter(server);

        filter.init(null);
        assertFalse(server.isInitialized());

        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getMethod()).thenReturn("GET");
        when(request.getRequestURI()).thenReturn("/paid");
        when(request.getRequestURL()).thenReturn(new StringBuffer("http://localhost/paid"));
        HttpServletResponse response = mock(HttpServletResponse.class);
        when(response.getOutputStream()).thenReturn(mock(ServletOutputStream.class));
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(request, response, chain);

        assertTrue(server.isInitialized());
        verify(response).setStatus(402);
        verifyNoInteractions(chain);
        verify(facilitator, times(2)).supported();
    }

    @Test
    void wrapsRouteConfigurationErrorsInAServletException() {
        PaymentFilter filter = new PaymentFilter(payments(new FakeFacilitator(NETWORK), "eip155:1"));

        ServletException error = assertThrows(ServletException.class, () -> filter.init(null));

        RouteConfigurationException cause = assertInstanceOf(RouteConfigurationException.class, error.getCause());
        assertEquals(RouteConfigurationException.MISSING_SCHEME, cause.problems().get(0).reason());
    }

    @Test
    void restoresTheInterruptFlagWhenInitializationIsInterrupted() throws Exception {
        FacilitatorClient facilitator = mock(FacilitatorClient.class);
        when(facilitator.supported()).thenThrow(new InterruptedException());
        PaymentFilter filter = new PaymentFilter(payments(facilitator, NETWORK));

        ServletException error = assertThrows(ServletException.class, () -> filter.init(null));

        assertInstanceOf(InterruptedException.class, error.getCause());
        assertTrue(Thread.currentThread().isInterrupted());
    }

    @Test
    void passesNonHttpRequestsThrough() throws Exception {
        HttpResourceServer server = payments(new FakeFacilitator(NETWORK), NETWORK);
        ServletRequest request = mock(ServletRequest.class);
        ServletResponse response = mock(ServletResponse.class);
        FilterChain chain = mock(FilterChain.class);

        new PaymentFilter(server).doFilter(request, response, chain);

        verify(chain).doFilter(request, response);
        verifyNoInteractions(request, response);
        assertFalse(server.isInitialized());
    }

    @Test
    void passesNestedDispatchesOfAPaidRequestThrough() throws Exception {
        HttpServletRequest request = mock(HttpServletRequest.class);
        HttpServletResponse response = mock(HttpServletResponse.class);
        FilterChain chain = mock(FilterChain.class);
        when(request.getAttribute(PaymentFilter.PAYMENT_PAYLOAD_ATTRIBUTE)).thenReturn(new Object());

        new PaymentFilter(payments(new FakeFacilitator(NETWORK), NETWORK)).doFilter(request, response, chain);

        verify(chain).doFilter(request, response);
        verify(request, times(0)).getRequestURI();
    }
}
