package org.x402.spring.web.servlet;

import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.io.UnsupportedEncodingException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.util.LinkedCaseInsensitiveMap;
import org.x402.http.X402Headers;

/**
 * Buffers a paid handler's whole response until settlement decides its fate. Status, headers,
 * cookies, content type, encoding, body, {@code sendError} and {@code sendRedirect} are all held
 * here; the real response only carries what outer filters set. {@link #release()} replays
 * everything; on a failed settle or a facilitator error nothing of the handler's response (not even
 * a {@code Location} or a token header) reaches the client.
 */
final class BufferingResponse extends HttpServletResponseWrapper {

  private static final String CONTENT_LENGTH = "Content-Length";
  private static final String CONTENT_TYPE = "Content-Type";

  private final ByteArrayOutputStream body = new ByteArrayOutputStream(1024);
  private final Map<String, List<String>> headers = new LinkedCaseInsensitiveMap<>(Locale.ROOT);
  private final List<Cookie> cookies = new ArrayList<>();
  private ServletOutputStream stream;
  private PrintWriter writer;
  private int status = SC_OK;
  private String characterEncoding;
  private Locale locale;
  private Integer errorStatus;
  private String errorMessage;
  private String redirect;
  private String settlementOverrides;

  BufferingResponse(HttpServletResponse response) {
    super(response);
  }

  // ---------------------------------------------------------------- body

  @Override
  public ServletOutputStream getOutputStream() {
    if (stream == null) {
      stream = new ServletOutputStream() {
        @Override
        public boolean isReady() {
          return true;
        }

        @Override
        public void setWriteListener(WriteListener listener) {
          throw new UnsupportedOperationException("x402 buffers paid responses; "
              + "non-blocking writes are not supported");
        }

        @Override
        public void write(int b) {
          body.write(b);
        }

        @Override
        public void write(byte[] b, int off, int len) {
          body.write(b, off, len);
        }
      };
    }
    return stream;
  }

  @Override
  public PrintWriter getWriter() throws UnsupportedEncodingException {
    if (writer == null) {
      writer = new PrintWriter(new OutputStreamWriter(body, getCharacterEncoding()));
    }
    return writer;
  }

  @Override
  public void flushBuffer() {
    if (writer != null) {
      writer.flush();
    }
  }

  @Override
  public void resetBuffer() {
    body.reset();
  }

  @Override
  public void reset() {
    body.reset();
    headers.clear();
    cookies.clear();
    status = SC_OK;
    characterEncoding = null;
    locale = null;
    errorStatus = null;
    errorMessage = null;
    redirect = null;
    settlementOverrides = null;
  }

  @Override
  public void setContentLength(int len) {
    // computed when the body is released
  }

  @Override
  public void setContentLengthLong(long len) {
    // computed when the body is released
  }

  // ---------------------------------------------------------------- status

  @Override
  public void setStatus(int sc) {
    status = sc;
  }

  @Override
  public int getStatus() {
    if (errorStatus != null) {
      return errorStatus;
    }
    return redirect != null ? SC_FOUND : status;
  }

  @Override
  public void sendError(int sc) {
    sendError(sc, null);
  }

  @Override
  public void sendError(int sc, String msg) {
    errorStatus = sc;
    errorMessage = msg;
  }

  @Override
  public void sendRedirect(String location) {
    redirect = location;
  }

  @Override
  public boolean isCommitted() {
    return errorStatus != null || redirect != null;
  }

  // ---------------------------------------------------------------- headers

  @Override
  public void setHeader(String name, String value) {
    if (special(name, value)) {
      return;
    }
    if (value == null) {
      headers.remove(name);
    } else {
      List<String> values = new ArrayList<>();
      values.add(value);
      headers.put(name, values);
    }
  }

  @Override
  public void addHeader(String name, String value) {
    if (special(name, value) || value == null) {
      return;
    }
    headers.computeIfAbsent(name, n -> new ArrayList<>()).add(value);
  }

  /** Content-Length is recomputed; Settlement-Overrides never reaches the client. */
  private boolean special(String name, String value) {
    if (CONTENT_LENGTH.equalsIgnoreCase(name)) {
      return true;
    }
    if (X402Headers.SETTLEMENT_OVERRIDES.equalsIgnoreCase(name)) {
      settlementOverrides = value;
      return true;
    }
    return false;
  }

  @Override
  public void setIntHeader(String name, int value) {
    setHeader(name, Integer.toString(value));
  }

  @Override
  public void addIntHeader(String name, int value) {
    addHeader(name, Integer.toString(value));
  }

  @Override
  public void setDateHeader(String name, long date) {
    setHeader(name, httpDate(date));
  }

  @Override
  public void addDateHeader(String name, long date) {
    addHeader(name, httpDate(date));
  }

  private static String httpDate(long date) {
    return DateTimeFormatter.RFC_1123_DATE_TIME.format(
        Instant.ofEpochMilli(date).atOffset(ZoneOffset.UTC));
  }

  @Override
  public boolean containsHeader(String name) {
    if (X402Headers.SETTLEMENT_OVERRIDES.equalsIgnoreCase(name)) {
      return settlementOverrides != null;
    }
    return headers.containsKey(name) || super.containsHeader(name);
  }

  @Override
  public String getHeader(String name) {
    if (X402Headers.SETTLEMENT_OVERRIDES.equalsIgnoreCase(name)) {
      return settlementOverrides;
    }
    List<String> values = headers.get(name);
    return values != null && !values.isEmpty() ? values.get(0) : super.getHeader(name);
  }

  @Override
  public Collection<String> getHeaders(String name) {
    List<String> values = headers.get(name);
    return values != null ? List.copyOf(values) : super.getHeaders(name);
  }

  @Override
  public Collection<String> getHeaderNames() {
    Set<String> names = new LinkedHashSet<>(super.getHeaderNames());
    names.addAll(headers.keySet());
    return names;
  }

  @Override
  public void addCookie(Cookie cookie) {
    cookies.add(cookie);
  }

  @Override
  public void setContentType(String type) {
    setHeader(CONTENT_TYPE, type);
    if (type != null) {
      int charset = type.toLowerCase(Locale.ROOT).indexOf("charset=");
      if (charset >= 0) {
        characterEncoding = type.substring(charset + 8).trim();
      }
    }
  }

  @Override
  public String getContentType() {
    String type = getHeader(CONTENT_TYPE);
    if (type != null && characterEncoding != null
        && !type.toLowerCase(Locale.ROOT).contains("charset=")) {
      return type + ";charset=" + characterEncoding;
    }
    return type;
  }

  @Override
  public void setCharacterEncoding(String charset) {
    characterEncoding = charset;
  }

  @Override
  public String getCharacterEncoding() {
    return characterEncoding != null ? characterEncoding
        : StandardCharsets.ISO_8859_1.name();
  }

  @Override
  public void setLocale(Locale loc) {
    locale = loc;
  }

  @Override
  public Locale getLocale() {
    return locale != null ? locale : super.getLocale();
  }

  // ---------------------------------------------------------------- results

  byte[] body() {
    flushBuffer();
    return body.toByteArray();
  }

  /**
   * The {@code Settlement-Overrides} header the handler set; it never reaches the client.
   */
  String settlementOverrides() {
    return settlementOverrides;
  }

  /** The handler's headers, one value each, plus {@code Settlement-Overrides}. */
  Map<String, String> headersForSettlement() {
    Map<String, String> out = new LinkedHashMap<>();
    HttpServletResponse real = (HttpServletResponse) getResponse();
    for (String name : real.getHeaderNames()) {
      out.put(name, real.getHeader(name));
    }
    headers.forEach((name, values) -> out.put(name, values.isEmpty() ? "" : values.get(0)));
    if (settlementOverrides != null) {
      out.put(X402Headers.SETTLEMENT_OVERRIDES, settlementOverrides);
    }
    return out;
  }

  /** Writes the held-back response to the real one. */
  void release() throws IOException {
    HttpServletResponse real = (HttpServletResponse) getResponse();
    if (locale != null) {
      real.setLocale(locale);
    }
    headers.forEach((name, values) -> {
      boolean first = true;
      for (String value : values) {
        if (first) {
          real.setHeader(name, value);
          first = false;
        } else {
          real.addHeader(name, value);
        }
      }
    });
    if (characterEncoding != null) {
      real.setCharacterEncoding(characterEncoding);
    }
    cookies.forEach(real::addCookie);
    if (errorStatus != null) {
      real.sendError(errorStatus, errorMessage);
      return;
    }
    if (redirect != null) {
      real.sendRedirect(redirect);
      return;
    }
    real.setStatus(status);
    byte[] bytes = body();
    if (bytes.length > 0) {
      real.setContentLength(bytes.length);
      real.getOutputStream().write(bytes);
    }
    real.flushBuffer();
  }
}
