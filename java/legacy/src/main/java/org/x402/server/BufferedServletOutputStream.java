package org.x402.server;

import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

/** In-memory {@link ServletOutputStream} backing {@link BufferingHttpServletResponseWrapper}. */
final class BufferedServletOutputStream extends ServletOutputStream {

    private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();

    @Override
    public void write(int b) throws IOException {
        buffer.write(b);
    }

    @Override
    public void write(byte[] b, int off, int len) throws IOException {
        buffer.write(b, off, len);
    }

    @Override
    public boolean isReady() {
        return true;
    }

    @Override
    public void setWriteListener(WriteListener writeListener) {
        // Buffering is always synchronous; async write-readiness notifications don't apply.
    }

    byte[] toByteArray() {
        return buffer.toByteArray();
    }
}
