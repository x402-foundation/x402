package org.x402.http.servlet;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;

import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.io.UnsupportedEncodingException;
import java.nio.charset.Charset;
import java.nio.charset.IllegalCharsetNameException;
import java.nio.charset.StandardCharsets;
import java.nio.charset.UnsupportedCharsetException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Holds back everything that would commit the response to the client until {@link PaymentFilter} has settled
 * the payment, then replays it with {@link #release()}.
 *
 * <p>The body, the status, the content length, {@code sendError} and {@code sendRedirect} are captured here.
 * {@code flushBuffer} does not commit. Other headers are forwarded to the real response, which a servlet
 * container does not send before it is committed; on a settlement failure the filter resets the real
 * response, dropping them. The whole body is kept in memory.
 *
 * <p>Containers hand an included resource this outermost wrapper, so the wrapper itself enforces what the servlet
 * specification requires of an include: changes to the status and content length, {@code sendError},
 * {@code sendRedirect} and {@code reset} are ignored. Once {@link #getWriter()} has fixed the charset, later
 * charset changes are ignored too, so the {@code Content-Type} header matches the buffered bytes.
 *
 * <p>Not thread-safe, like the servlet response it wraps.
 */
final class BufferingResponseWrapper extends HttpServletResponseWrapper {

    private static final String CONTENT_LENGTH = "Content-Length";

    private final HttpServletRequest request;
    private final BufferedServletOutputStream body = new BufferedServletOutputStream();
    private PrintWriter writer;
    private Charset lockedCharset;
    private boolean outputStreamUsed;
    private int status;
    private long contentLength = -1;
    private Commit commit;
    private byte[] redirectBody = new byte[0];

    /**
     * Wraps a response.
     *
     * @param response the real response
     * @param request the request passed down the chain with this wrapper, checked for an ongoing include
     */
    BufferingResponseWrapper(HttpServletResponse response, HttpServletRequest request) {
        super(response);
        this.request = request;
        this.status = response.getStatus();
    }

    @Override
    public ServletOutputStream getOutputStream() {
        if (writer != null) {
            throw new IllegalStateException("getWriter() has already been called on this response");
        }
        outputStreamUsed = true;
        return body;
    }

    @Override
    public PrintWriter getWriter() throws UnsupportedEncodingException {
        if (outputStreamUsed) {
            throw new IllegalStateException("getOutputStream() has already been called on this response");
        }
        if (writer == null) {
            lockedCharset = writerCharset();
            // A container fixes the charset when getWriter() is called; do the same so the header matches the bytes.
            getResponse().setCharacterEncoding(lockedCharset.name());
            writer = new PrintWriter(new OutputStreamWriter(body, lockedCharset));
        }
        return writer;
    }

    /** Ignored once {@link #getWriter()} has fixed the charset, as a container does. */
    @Override
    public void setCharacterEncoding(String charset) {
        if (writer == null) {
            super.setCharacterEncoding(charset);
        }
    }

    /** Sets the media type; once {@link #getWriter()} has fixed the charset, a charset parameter is ignored. */
    @Override
    public void setContentType(String type) {
        super.setContentType(type);
        if (writer != null) {
            super.setCharacterEncoding(lockedCharset.name());
        }
    }

    @Override
    public void setStatus(int sc) {
        if (commit == null && !including()) {
            status = sc;
        }
    }

    @Override
    public int getStatus() {
        return status;
    }

    @Override
    public void sendError(int sc) {
        sendError(sc, null);
    }

    @Override
    public void sendError(int sc, String msg) {
        if (including()) {
            return;
        }
        requireNotCommitted();
        clearBody();
        status = sc;
        commit = new Commit(sc, msg, null, true);
    }

    @Override
    public void sendRedirect(String location) {
        sendRedirect(location, HttpServletResponse.SC_FOUND, true);
    }

    @Override
    public void sendRedirect(String location, boolean clearBuffer) {
        sendRedirect(location, HttpServletResponse.SC_FOUND, clearBuffer);
    }

    @Override
    public void sendRedirect(String location, int sc) {
        sendRedirect(location, sc, true);
    }

    @Override
    public void sendRedirect(String location, int sc, boolean clearBuffer) {
        if (including()) {
            return;
        }
        requireNotCommitted();
        if (clearBuffer) {
            clearBody();
        }
        status = sc;
        redirectBody = bufferedBody();
        commit = new Commit(sc, null, location, clearBuffer);
    }

    @Override
    public void setContentLength(int len) {
        setContentLengthLong(len);
    }

    @Override
    public void setContentLengthLong(long len) {
        if (commit == null && !including()) {
            contentLength = len;
        }
    }

    @Override
    public void setHeader(String name, String value) {
        if (isContentLength(name)) {
            setContentLengthLong(value == null ? -1 : Long.parseLong(value.trim()));
        } else {
            super.setHeader(name, value);
        }
    }

    @Override
    public void addHeader(String name, String value) {
        if (isContentLength(name)) {
            setHeader(name, value);
        } else {
            super.addHeader(name, value);
        }
    }

    @Override
    public void setIntHeader(String name, int value) {
        if (isContentLength(name)) {
            setContentLengthLong(value);
        } else {
            super.setIntHeader(name, value);
        }
    }

    @Override
    public void addIntHeader(String name, int value) {
        if (isContentLength(name)) {
            setContentLengthLong(value);
        } else {
            super.addIntHeader(name, value);
        }
    }

    @Override
    public boolean containsHeader(String name) {
        return isContentLength(name) ? contentLength >= 0 : super.containsHeader(name);
    }

    @Override
    public String getHeader(String name) {
        if (isContentLength(name)) {
            return contentLength >= 0 ? Long.toString(contentLength) : null;
        }
        return super.getHeader(name);
    }

    @Override
    public Collection<String> getHeaders(String name) {
        if (isContentLength(name)) {
            return contentLength >= 0 ? List.of(Long.toString(contentLength)) : List.of();
        }
        return super.getHeaders(name);
    }

    @Override
    public Collection<String> getHeaderNames() {
        Set<String> names = new LinkedHashSet<>(super.getHeaderNames());
        if (contentLength >= 0) {
            names.add(CONTENT_LENGTH);
        }
        return new ArrayList<>(names);
    }

    /** Flushes the writer into the buffer. Unlike a real response, this never commits. */
    @Override
    public void flushBuffer() {
        if (writer != null) {
            writer.flush();
        }
    }

    @Override
    public void resetBuffer() {
        requireNotCommitted();
        clearBody();
    }

    @Override
    public void reset() {
        if (including()) {
            return;
        }
        requireNotCommitted();
        super.reset();
        clearBody();
        writer = null;
        lockedCharset = null;
        outputStreamUsed = false;
        status = HttpServletResponse.SC_OK;
        contentLength = -1;
    }

    /** Returns {@code true} only after {@code sendError} or {@code sendRedirect}, which commit a real response. */
    @Override
    public boolean isCommitted() {
        return commit != null;
    }

    /**
     * Writes the captured status, content length and body to the real response, or replays the captured
     * {@code sendError} or {@code sendRedirect}.
     *
     * @throws IOException if the real response cannot be written
     */
    void release() throws IOException {
        HttpServletResponse target = (HttpServletResponse) getResponse();
        if (commit != null) {
            commit.replay(target, redirectBody);
            return;
        }
        flushBuffer();
        int size = body.size();
        target.setStatus(status);
        target.setContentLengthLong(contentLength >= 0 ? contentLength : size);
        if (size > 0) {
            body.writeTo(target.getOutputStream());
        }
    }

    /**
     * Returns the bytes written so far, flushing the writer first.
     *
     * @return a copy of the buffered body
     */
    byte[] bufferedBody() {
        flushBuffer();
        return body.toByteArray();
    }

    private Charset writerCharset() throws UnsupportedEncodingException {
        String encoding = getCharacterEncoding();
        if (encoding == null) {
            return StandardCharsets.ISO_8859_1;
        }
        try {
            return Charset.forName(encoding);
        } catch (IllegalCharsetNameException | UnsupportedCharsetException e) {
            UnsupportedEncodingException unsupported = new UnsupportedEncodingException(encoding);
            unsupported.initCause(e);
            throw unsupported;
        }
    }

    private void clearBody() {
        flushBuffer();
        body.reset();
    }

    private void requireNotCommitted() {
        if (commit != null) {
            throw new IllegalStateException("The response has already been committed by sendError or sendRedirect");
        }
    }

    /** Returns whether an included resource is writing, which may not change the status or headers. */
    private boolean including() {
        return request.getDispatcherType() == DispatcherType.INCLUDE
                || request.getAttribute(RequestDispatcher.INCLUDE_REQUEST_URI) != null;
    }

    private static boolean isContentLength(String name) {
        return CONTENT_LENGTH.equalsIgnoreCase(name);
    }

    /**
     * A captured {@code sendError} ({@code location == null}) or {@code sendRedirect}.
     *
     * @param status the status code
     * @param message the error message, or {@code null}
     * @param location the redirect location, or {@code null} for an error
     * @param clearBuffer whether a redirect discards the body written before it
     */
    private record Commit(int status, String message, String location, boolean clearBuffer) {

        /** Replays the call on the real response; {@code body} is kept only by a redirect that does not clear. */
        void replay(HttpServletResponse target, byte[] body) throws IOException {
            if (location == null) {
                if (message == null) {
                    target.sendError(status);
                } else {
                    target.sendError(status, message);
                }
                return;
            }
            if (status == HttpServletResponse.SC_FOUND && clearBuffer) {
                // The single-argument form is the only one Servlet 5 containers implement.
                target.sendRedirect(location);
                return;
            }
            if (!clearBuffer && body.length > 0) {
                target.getOutputStream().write(body);
            }
            target.sendRedirect(location, status, clearBuffer);
        }
    }
}
