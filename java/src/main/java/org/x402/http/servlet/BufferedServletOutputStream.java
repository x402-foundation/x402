package org.x402.http.servlet;

import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/**
 * In-memory {@link ServletOutputStream} behind {@link BufferingResponseWrapper}. Bytes stay in memory until the
 * filter releases them to the real response.
 *
 * <p>Not thread-safe, like the servlet response it belongs to.
 */
final class BufferedServletOutputStream extends ServletOutputStream {

    private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();

    @Override
    public void write(int b) {
        buffer.write(b);
    }

    @Override
    public void write(byte[] b, int off, int len) {
        buffer.write(b, off, len);
    }

    /** Always ready: writes go to memory and never block. */
    @Override
    public boolean isReady() {
        return true;
    }

    /**
     * Rejects non-blocking output, which requires asynchronous processing. Paid requests are processed
     * synchronously so their response can be held back until settlement.
     *
     * @throws IllegalStateException always
     */
    @Override
    public void setWriteListener(WriteListener writeListener) {
        throw new IllegalStateException(
                "Non-blocking output is not supported while x402 buffers a paid response");
    }

    byte[] toByteArray() {
        return buffer.toByteArray();
    }

    int size() {
        return buffer.size();
    }

    /** Writes the buffered bytes to {@code out} without copying them first. */
    void writeTo(OutputStream out) throws IOException {
        buffer.writeTo(out);
    }

    void reset() {
        buffer.reset();
    }
}
