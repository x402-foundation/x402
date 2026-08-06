package org.x402.server;

import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintWriter;

class BufferingResponseWrapper extends HttpServletResponseWrapper {

    private final ByteArrayOutputStream buffer = new ByteArrayOutputStream(4096);
    private final ServletOutputStream   stream  = new BufferingOutputStream(buffer);
    private       PrintWriter           writer;
    private       int                   status  = SC_OK;

    BufferingResponseWrapper(HttpServletResponse response) {
        super(response);
    }

    @Override public void setStatus(int sc) { this.status = sc; super.setStatus(sc); }
    @Override @SuppressWarnings("deprecation")
    public void setStatus(int sc, String sm) { this.status = sc; super.setStatus(sc, sm); }
    @Override public void sendError(int sc) throws IOException { this.status = sc; super.sendError(sc); }
    @Override public void sendError(int sc, String msg) throws IOException { this.status = sc; super.sendError(sc, msg); }
    @Override public int getStatus() { return status; }

    @Override public ServletOutputStream getOutputStream() { return stream; }
    @Override public PrintWriter getWriter() {
        if (writer == null) writer = new PrintWriter(stream, false);
        return writer;
    }

    void copyTo(HttpServletResponse real) throws IOException {
        if (writer != null) writer.flush();
        byte[] body = buffer.toByteArray();
        if (body.length > 0) real.getOutputStream().write(body);
    }

    @Override public void flushBuffer() { /* intentionally empty */ }

    private static final class BufferingOutputStream extends ServletOutputStream {
        private final ByteArrayOutputStream out;
        BufferingOutputStream(ByteArrayOutputStream out) { this.out = out; }
        @Override public void write(int b) { out.write(b); }
        @Override public void write(byte[] b, int off, int len) { out.write(b, off, len); }
        @Override public boolean isReady() { return true; }
        @Override public void setWriteListener(WriteListener listener) { }
    }
}
