package org.x402.server;

import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;

/**
 * Buffers the response body written by downstream filters/servlets instead of sending it to the
 * client immediately, so {@link PaymentFilter} can discard it (or send a 402 instead) if
 * settlement later fails.
 *
 * <p>Only the body is buffered — status codes and headers set through this wrapper are forwarded
 * to the underlying response immediately (the default {@link HttpServletResponseWrapper}
 * delegation). That's safe: a servlet container doesn't actually deliver bytes to the client
 * until they're written to the underlying output stream, and that never happens through this
 * wrapper until {@link PaymentFilter} explicitly flushes the buffer post-settlement.
 */
final class BufferingHttpServletResponseWrapper extends HttpServletResponseWrapper {

    private BufferedServletOutputStream outputStream;
    private PrintWriter writer;

    BufferingHttpServletResponseWrapper(HttpServletResponse response) {
        super(response);
    }

    @Override
    public ServletOutputStream getOutputStream() throws IOException {
        if (writer != null) {
            throw new IllegalStateException("getWriter() already called");
        }
        if (outputStream == null) {
            outputStream = new BufferedServletOutputStream();
        }
        return outputStream;
    }

    @Override
    public PrintWriter getWriter() throws IOException {
        if (outputStream != null) {
            throw new IllegalStateException("getOutputStream() already called");
        }
        if (writer == null) {
            String encoding = getCharacterEncoding() != null ? getCharacterEncoding() : "UTF-8";
            outputStream = new BufferedServletOutputStream();
            writer = new PrintWriter(new OutputStreamWriter(outputStream, encoding), true);
        }
        return writer;
    }

    /** Returns the buffered response body, flushing the writer first if it was used. */
    byte[] getBufferedBody() {
        if (writer != null) {
            writer.flush();
        }
        return outputStream != null ? outputStream.toByteArray() : new byte[0];
    }

    @Override
    public boolean isCommitted() {
        // Nothing has ever actually been written to the underlying response.
        return false;
    }
}
