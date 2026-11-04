package org.x402.http.servlet;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.UnsupportedEncodingException;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class BufferingResponseWrapperTest {

    private final CapturingOutputStream delivered = new CapturingOutputStream();
    private final HttpServletRequest request = mock(HttpServletRequest.class);
    private HttpServletResponse response;
    private BufferingResponseWrapper buffered;

    @BeforeEach
    void wrapAMockResponse() throws IOException {
        response = mock(HttpServletResponse.class);
        when(response.getStatus()).thenReturn(HttpServletResponse.SC_OK);
        when(response.getCharacterEncoding()).thenReturn("UTF-8");
        when(response.getOutputStream()).thenReturn(delivered);
        when(response.getHeaderNames()).thenReturn(List.of("X-Upstream"));
        when(request.getDispatcherType()).thenReturn(DispatcherType.REQUEST);
        buffered = new BufferingResponseWrapper(response, request);
    }

    @Test
    void startsFromTheRealResponseStatus() {
        when(response.getStatus()).thenReturn(201);

        assertEquals(201, new BufferingResponseWrapper(response, request).getStatus());
    }

    @Test
    void keepsTheBodyAndStatusUntilReleased() throws IOException {
        buffered.setStatus(201);
        buffered.getOutputStream().write("secret".getBytes(StandardCharsets.UTF_8));
        buffered.flushBuffer();

        assertFalse(buffered.isCommitted());
        verify(response, never()).getOutputStream();
        verify(response, never()).flushBuffer();
        verify(response, never()).setStatus(anyInt());

        buffered.release();

        var order = inOrder(response);
        order.verify(response).setStatus(201);
        order.verify(response).setContentLengthLong(6);
        assertEquals("secret", delivered.text());
    }

    @Test
    void encodesTheWriterWithTheResponseCharsetAndFixesIt() throws IOException {
        PrintWriter writer = buffered.getWriter();
        writer.print("héllo");

        assertSame(writer, buffered.getWriter());
        assertArrayEquals("héllo".getBytes(StandardCharsets.UTF_8), buffered.bufferedBody());
        verify(response).setCharacterEncoding("UTF-8");
    }

    @Test
    void defaultsTheWriterToIso88591AsTheServletSpecDoes() throws IOException {
        when(response.getCharacterEncoding()).thenReturn(null);

        buffered.getWriter().print("é");

        assertArrayEquals(new byte[] {(byte) 0xE9}, buffered.bufferedBody());
        verify(response).setCharacterEncoding("ISO-8859-1");
    }

    @Test
    void rejectsAnUnsupportedCharset() {
        when(response.getCharacterEncoding()).thenReturn("no-such-charset");

        assertThrows(UnsupportedEncodingException.class, buffered::getWriter);
    }

    @Test
    void enforcesWriterAndOutputStreamExclusivity() throws IOException {
        buffered.getWriter();
        assertThrows(IllegalStateException.class, buffered::getOutputStream);

        BufferingResponseWrapper other = new BufferingResponseWrapper(response, request);
        other.getOutputStream();
        assertThrows(IllegalStateException.class, other::getWriter);
    }

    @Test
    void capturesTheContentLengthInsteadOfForwardingIt() throws IOException {
        buffered.setContentLength(3);
        assertEquals("3", buffered.getHeader("content-length"));
        buffered.setIntHeader("Content-Length", 4);
        buffered.addIntHeader("Content-Length", 5);
        buffered.addHeader("Content-Length", " 7 ");
        assertTrue(buffered.containsHeader("Content-Length"));
        assertEquals(List.of("7"), List.copyOf(buffered.getHeaders("Content-Length")));
        assertEquals(List.of("X-Upstream", "Content-Length"), List.copyOf(buffered.getHeaderNames()));
        buffered.getOutputStream().write(new byte[7]);

        buffered.release();

        verify(response, never()).setHeader(anyString(), anyString());
        verify(response, never()).setContentLength(anyInt());
        verify(response).setContentLengthLong(7);
    }

    @Test
    void clearsTheContentLengthWithANullHeader() {
        buffered.setHeader("Content-Length", "9");
        buffered.setHeader("Content-Length", null);

        assertFalse(buffered.containsHeader("Content-Length"));
        assertNull(buffered.getHeader("Content-Length"));
        assertTrue(buffered.getHeaders("Content-Length").isEmpty());
        assertThrows(NumberFormatException.class, () -> buffered.setHeader("Content-Length", "abc"));
    }

    @Test
    void forwardsOtherHeaders() {
        when(response.getHeader("X-Upstream")).thenReturn("1");
        when(response.containsHeader("X-Upstream")).thenReturn(true);
        when(response.getHeaders("X-Upstream")).thenReturn(List.of("1"));

        buffered.setHeader("X-A", "a");
        buffered.addHeader("X-B", "b");
        buffered.setIntHeader("X-C", 1);
        buffered.addIntHeader("X-D", 2);

        verify(response).setHeader("X-A", "a");
        verify(response).addHeader("X-B", "b");
        verify(response).setIntHeader("X-C", 1);
        verify(response).addIntHeader("X-D", 2);
        assertEquals("1", buffered.getHeader("X-Upstream"));
        assertTrue(buffered.containsHeader("X-Upstream"));
        assertEquals(List.of("1"), List.copyOf(buffered.getHeaders("X-Upstream")));
    }

    @Test
    void holdsBackSendErrorAndReplaysIt() throws IOException {
        buffered.getOutputStream().write(1);
        buffered.sendError(404, "Not Found");

        assertTrue(buffered.isCommitted());
        assertEquals(404, buffered.getStatus());
        assertEquals(0, buffered.bufferedBody().length);
        buffered.setStatus(200);
        buffered.setContentLength(10);
        assertEquals(404, buffered.getStatus());
        assertThrows(IllegalStateException.class, () -> buffered.sendError(500));
        assertThrows(IllegalStateException.class, buffered::resetBuffer);
        assertThrows(IllegalStateException.class, buffered::reset);
        assertThrows(IllegalStateException.class, () -> buffered.sendRedirect("/x"));
        verify(response, never()).sendError(anyInt(), any());

        buffered.release();

        verify(response).sendError(404, "Not Found");
    }

    @Test
    void replaysSendErrorWithoutAMessage() throws IOException {
        buffered.sendError(500);

        buffered.release();

        verify(response).sendError(500);
    }

    @Test
    void holdsBackARedirectAndReplaysTheServlet5Form() throws IOException {
        buffered.getWriter().print("discarded");
        buffered.sendRedirect("/elsewhere");

        assertTrue(buffered.isCommitted());
        assertEquals(302, buffered.getStatus());
        verify(response, never()).sendRedirect(anyString());

        buffered.release();

        verify(response).sendRedirect("/elsewhere");
        assertEquals("", delivered.text());
    }

    @Test
    void replaysServlet61RedirectVariants() throws IOException {
        buffered.sendRedirect("/moved", 301);
        buffered.release();
        verify(response).sendRedirect("/moved", 301, true);

        BufferingResponseWrapper keeping = new BufferingResponseWrapper(response, request);
        keeping.getOutputStream().write("kept".getBytes(StandardCharsets.UTF_8));
        keeping.sendRedirect("/see-other", false);
        keeping.getOutputStream().write("ignored".getBytes(StandardCharsets.UTF_8));
        keeping.release();

        var order = inOrder(response);
        order.verify(response).getOutputStream();
        order.verify(response).sendRedirect("/see-other", 302, false);
        assertEquals("kept", delivered.text());
    }

    @Test
    void resetClearsEverythingAndResetsTheRealResponse() throws IOException {
        buffered.getWriter().print("partial");
        buffered.setStatus(500);
        buffered.setContentLength(7);

        buffered.reset();

        verify(response).reset();
        assertEquals(200, buffered.getStatus());
        assertFalse(buffered.containsHeader("Content-Length"));
        assertEquals(0, buffered.bufferedBody().length);
        buffered.getOutputStream().write(1);
        assertEquals(1, buffered.bufferedBody().length);
    }

    @Test
    void resetBufferClearsOnlyTheBody() throws IOException {
        buffered.getWriter().print("partial");
        buffered.setStatus(201);

        buffered.resetBuffer();
        buffered.getWriter().print("final");

        assertEquals(201, buffered.getStatus());
        assertEquals("final", new String(buffered.bufferedBody(), StandardCharsets.UTF_8));
        verify(response, never()).resetBuffer();
    }

    @Test
    void releasesAnEmptyBodyWithoutTouchingTheOutputStream() throws IOException {
        buffered.release();

        verify(response).setContentLengthLong(0);
        verify(response, never()).getOutputStream();
    }

    @Test
    void refusesNonBlockingOutput() throws IOException {
        ServletOutputStream stream = buffered.getOutputStream();

        assertTrue(stream.isReady());
        assertThrows(IllegalStateException.class, () -> stream.setWriteListener(mock(WriteListener.class)));
    }

    @Test
    void ignoresWhatAnIncludedResourceMayNotChange() throws IOException {
        buffered.getOutputStream().write("article ".getBytes(StandardCharsets.UTF_8));
        when(request.getDispatcherType()).thenReturn(DispatcherType.INCLUDE);

        buffered.setStatus(404);
        buffered.setContentLength(5);
        buffered.setHeader("Content-Length", "5");
        buffered.sendError(404);
        buffered.sendRedirect("/elsewhere");
        buffered.reset();
        buffered.getOutputStream().write("fragment".getBytes(StandardCharsets.UTF_8));
        when(request.getDispatcherType()).thenReturn(DispatcherType.REQUEST);

        assertFalse(buffered.isCommitted());
        assertEquals(200, buffered.getStatus());
        buffered.release();
        verify(response).setStatus(200);
        verify(response).setContentLengthLong(16);
        verify(response, never()).reset();
        verify(response, never()).sendError(anyInt());
        verify(response, never()).sendRedirect(anyString());
        assertEquals("article fragment", delivered.text());
    }

    @Test
    void recognizesAnIncludeByItsRequestAttribute() {
        when(request.getAttribute(RequestDispatcher.INCLUDE_REQUEST_URI)).thenReturn("/fragment");

        buffered.setStatus(404);

        assertEquals(200, buffered.getStatus());
    }

    @Test
    void keepsTheCharsetFixedByGetWriter() throws IOException {
        when(response.getCharacterEncoding()).thenReturn(null);
        buffered.setCharacterEncoding("US-ASCII");
        verify(response).setCharacterEncoding("US-ASCII");

        buffered.getWriter().print("é");
        buffered.setContentType("text/plain;charset=UTF-8");
        buffered.setCharacterEncoding("UTF-8");

        var order = inOrder(response);
        order.verify(response).setCharacterEncoding("ISO-8859-1");
        order.verify(response).setContentType("text/plain;charset=UTF-8");
        order.verify(response).setCharacterEncoding("ISO-8859-1");
        verify(response, never()).setCharacterEncoding("UTF-8");
        assertArrayEquals(new byte[] {(byte) 0xE9}, buffered.bufferedBody());
    }

    /** Servlet output stream that records what is written to it. */
    private static final class CapturingOutputStream extends ServletOutputStream {

        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();

        @Override
        public void write(int b) {
            bytes.write(b);
        }

        @Override
        public boolean isReady() {
            return true;
        }

        @Override
        public void setWriteListener(WriteListener writeListener) {
            throw new UnsupportedOperationException();
        }

        String text() {
            return bytes.toString(StandardCharsets.UTF_8);
        }
    }
}
