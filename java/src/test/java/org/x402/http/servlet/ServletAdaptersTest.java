package org.x402.http.servlet;

import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpUpgradeHandler;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ServletAdaptersTest {

    @ParameterizedTest(name = "{0} in context \"{1}\" -> {2}")
    @CsvSource(delimiter = '|', value = {
        "/weather|''|/weather",
        "/shop/weather|/shop|/weather",
        "/shop|/shop|''",
        "/shopping/weather|/shop|/shopping/weather",
        "/other/weather|/shop|/other/weather",
        "/shop;jsessionid=1/weather|/shop|/shop;jsessionid=1/weather",
    })
    void stripsOnlyAWholeContextPathSegment(String uri, String contextPath, String expected) {
        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getRequestURI()).thenReturn(uri);
        when(request.getContextPath()).thenReturn(contextPath);

        assertEquals(expected, new ServletRequestAdapter(request).path());
    }

    @Test
    void fallsBackToRootWithoutARequestUri() {
        assertEquals("/", new ServletRequestAdapter(mock(HttpServletRequest.class)).path());
    }

    @Test
    void exposesTheContainerDecodedPath() {
        HttpServletRequest request = mock(HttpServletRequest.class);
        ServletRequestAdapter adapter = new ServletRequestAdapter(request);
        assertEquals(Optional.empty(), adapter.decodedPath());

        when(request.getServletPath()).thenReturn("/api");
        assertEquals(Optional.of("/api"), adapter.decodedPath());

        when(request.getPathInfo()).thenReturn("/users/1");
        assertEquals(Optional.of("/api/users/1"), adapter.decodedPath());
    }

    @Test
    void buildsTheUrlWithItsQueryAndReadsHeaders() {
        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getRequestURL()).thenReturn(new StringBuffer("https://api.example.com/weather"));
        when(request.getMethod()).thenReturn("GET");
        when(request.getHeader("PAYMENT-SIGNATURE")).thenReturn("abc");
        ServletRequestAdapter adapter = new ServletRequestAdapter(request);

        assertEquals("https://api.example.com/weather", adapter.url());
        when(request.getRequestURL()).thenReturn(new StringBuffer("https://api.example.com/weather"));
        when(request.getQueryString()).thenReturn("city=Tallinn");
        assertEquals("https://api.example.com/weather?city=Tallinn", adapter.url());
        assertEquals("GET", adapter.method());
        assertEquals(Optional.of("abc"), adapter.header("PAYMENT-SIGNATURE"));
        assertEquals(Optional.empty(), adapter.header("Other"));
    }

    @Test
    void paidRequestsRefuseAsyncAndUpgrades() {
        PaidRequest request = new PaidRequest(mock(HttpServletRequest.class));

        assertFalse(request.isAsyncSupported());
        assertThrows(IllegalStateException.class, request::startAsync);
        assertThrows(IllegalStateException.class,
                () -> request.startAsync(mock(ServletRequest.class), mock(ServletResponse.class)));
        assertThrows(ServletException.class, () -> request.upgrade(HttpUpgradeHandler.class));
    }

    @Test
    void headerSnapshotRestoresUpstreamHeadersAfterReset() {
        Map<String, List<String>> headers = new LinkedHashMap<>();
        HttpServletResponse response = mock(HttpServletResponse.class);
        when(response.getHeaderNames()).thenAnswer(invocation -> List.copyOf(headers.keySet()));
        when(response.getHeaders(anyString())).thenAnswer(
                invocation -> List.copyOf(headers.getOrDefault(invocation.<String>getArgument(0), List.of())));
        doAnswer(invocation -> {
            headers.computeIfAbsent(invocation.getArgument(0), name -> new ArrayList<>())
                    .add(invocation.getArgument(1));
            return null;
        }).when(response).addHeader(anyString(), anyString());
        doAnswer(invocation -> {
            headers.clear();
            headers.put("Set-Cookie", new ArrayList<>(List.of("JSESSIONID=1")));
            return null;
        }).when(response).reset();
        headers.put("Access-Control-Allow-Origin", new ArrayList<>(List.of("https://app.example")));
        headers.put("Set-Cookie", new ArrayList<>(List.of("JSESSIONID=1")));
        headers.put("Vary", new ArrayList<>(List.of("Origin", "Accept")));
        HeaderSnapshot snapshot = HeaderSnapshot.of(response);
        headers.put("X-Handler", new ArrayList<>(List.of("secret")));

        snapshot.resetTo(response);

        assertEquals(Map.of(
                "Access-Control-Allow-Origin", List.of("https://app.example"),
                "Set-Cookie", List.of("JSESSIONID=1"),
                "Vary", List.of("Origin", "Accept")), headers);
    }
}
