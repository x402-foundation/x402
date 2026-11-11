package org.x402.spring.web.servlet;

import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.UnsupportedEncodingException;
import java.io.Writer;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.Charset;
import java.nio.charset.CharsetEncoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.IllegalCharsetNameException;
import java.nio.charset.StandardCharsets;
import java.nio.charset.UnsupportedCharsetException;
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
import java.util.TreeSet;
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
  /** Characters written through the writer, not yet encoded into {@link #body}. */
  private final StringBuilder chars = new StringBuilder();
  private final Map<String, List<String>> headers = new LinkedCaseInsensitiveMap<>(Locale.ROOT);
  /** Headers the handler set (replacing) rather than only added to. */
  private final Set<String> replaced = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
  private final List<Cookie> cookies = new ArrayList<>();
  private ServletOutputStream stream;
  private PrintWriter writer;
  /** Pending writer characters are encoded once this many have collected. */
  private static final int ENCODE_CHUNK_CHARS = 8192;
  private static final int ENCODE_BUFFER_BYTES = 16384;
  /** One encoder for the whole body, so a charset's byte-order mark is written once. */
  private CharsetEncoder encoder;
  /**
   * Set by {@link #getWriter()}: as on a servlet container, the charset no longer changes until
   * {@link #reset()}, so the declared charset always matches the encoded bytes.
   */
  private boolean charsetFixed;
  /** Whether the encoder was told the input ended; cleared by a reset. */
  private boolean finished;
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
          encodeChars(false);
          body.write(b);
        }

        @Override
        public void write(byte[] b, int off, int len) {
          encodeChars(false);
          body.write(b, off, len);
        }
      };
    }
    return stream;
  }

  /**
   * A writer without an encoder buffer of its own: characters wait in {@link #chars}, so a reset
   * forgets them, and are encoded in order whenever bytes follow or the body is read.
   */
  @Override
  public PrintWriter getWriter() throws UnsupportedEncodingException {
    if (encoder == null) {
      try {
        encoder = newEncoder(getCharacterEncoding());
      } catch (IllegalCharsetNameException | UnsupportedCharsetException e) {
        throw new UnsupportedEncodingException(getCharacterEncoding());
      }
    }
    // Pinned, so release() declares exactly the charset the bytes are encoded in.
    characterEncoding = encoder.charset().name();
    charsetFixed = true;
    if (writer == null) {
      writer = new PrintWriter(new Writer() {
        @Override
        public void write(char[] buf, int off, int len) {
          chars.append(buf, off, len);
          if (chars.length() >= ENCODE_CHUNK_CHARS) {
            encodeChars(false); // encode as it goes: never a whole body held twice
          }
        }

        @Override
        public void flush() {
          // encoded on demand
        }

        @Override
        public void close() {
          // the body lives until release
        }
      });
    }
    return writer;
  }

  /**
   * Encodes the pending characters in order with the body's one encoder; a trailing high
   * surrogate waits for its pair, and is dropped as malformed when the body is final.
   */
  private void encodeChars(boolean last) {
    boolean finish = last && encoder != null && !finished;
    if (chars.length() == 0 && !finish) {
      return;
    }
    if (encoder == null) {
      // The writer was kept across a reset() and used again without getWriter(); an invalid
      // charset set since then falls back to the servlet default instead of failing a paid body.
      try {
        encoder = newEncoder(getCharacterEncoding());
      } catch (IllegalArgumentException e) {
        encoder = newEncoder(StandardCharsets.ISO_8859_1.name());
      }
      characterEncoding = encoder.charset().name();
      charsetFixed = true;
    }
    CharBuffer in = CharBuffer.wrap(chars);
    ByteBuffer out = ByteBuffer.allocate(ENCODE_BUFFER_BYTES);
    // End of input (once, until the next reset; body() is read more than once): a dangling
    // surrogate is replaced, and a stateful charset writes its reset sequence.
    boolean end = last && !finished;
    while (encoder.encode(in, out, end).isOverflow()) {
      drain(out);
    }
    if (end) {
      while (encoder.flush(out).isOverflow()) {
        drain(out);
      }
      finished = true;
    }
    drain(out);
    chars.delete(0, in.position());
    if (last) {
      chars.setLength(0);
    }
  }

  private void drain(ByteBuffer out) {
    body.write(out.array(), 0, out.position());
    out.clear();
  }

  private static CharsetEncoder newEncoder(String charset) {
    return Charset.forName(charset).newEncoder()
        .onMalformedInput(CodingErrorAction.REPLACE)
        .onUnmappableCharacter(CodingErrorAction.REPLACE);
  }

  @Override
  public void flushBuffer() {
    if (writer != null) {
      writer.flush();
    }
    encodeChars(false);
  }

  @Override
  public void resetBuffer() {
    body.reset();
    chars.setLength(0);
    finished = false;
    if (encoder != null) {
      encoder.reset();
    }
  }

  @Override
  public void reset() {
    body.reset();
    chars.setLength(0);
    // The charset is free again; the next writer use encodes with whatever is set then.
    encoder = null;
    charsetFixed = false;
    finished = false;
    headers.clear();
    replaced.clear();
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
    if (CONTENT_TYPE.equalsIgnoreCase(name)) {
      setContentType(value);
      return;
    }
    storeHeader(name, value);
  }

  private void storeHeader(String name, String value) {
    if (value == null) {
      headers.remove(name);
    } else {
      List<String> values = new ArrayList<>();
      values.add(value);
      headers.put(name, values);
      replaced.add(name);
    }
  }

  @Override
  public void addHeader(String name, String value) {
    if (special(name, value) || value == null) {
      return;
    }
    if (CONTENT_TYPE.equalsIgnoreCase(name)) {
      // Single-valued, and its charset must reach the encoder: as a container does.
      setContentType(value);
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
    // As release() will leave it: a header the handler set replaces the real response's; one it
    // only added follows the values already there.
    List<String> values = headers.get(name);
    if (values == null || values.isEmpty()) {
      return super.getHeader(name);
    }
    if (replaced.contains(name)) {
      return values.get(0);
    }
    String outer = super.getHeader(name);
    return outer != null ? outer : values.get(0);
  }

  @Override
  public Collection<String> getHeaders(String name) {
    List<String> values = headers.get(name);
    if (values == null) {
      return super.getHeaders(name);
    }
    if (replaced.contains(name)) {
      return List.copyOf(values);
    }
    List<String> all = new ArrayList<>(super.getHeaders(name));
    all.addAll(values);
    return all;
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
    String charset = charsetParameter(type);
    if (charset != null && charsetFixed) {
      // After getWriter() the charset stays; the type changes without it.
      type = withoutCharset(type);
      charset = null;
    }
    storeHeader(CONTENT_TYPE, type);
    if (charset != null) {
      characterEncoding = charset;
    }
  }

  /** A content type with its {@code charset} parameter removed. */
  static String withoutCharset(String type) {
    String[] parts = type.split(";");
    StringBuilder out = new StringBuilder(parts[0].trim());
    for (int i = 1; i < parts.length; i++) {
      String part = parts[i].trim();
      int eq = part.indexOf('=');
      if (!part.isEmpty()
          && !(eq > 0 && part.substring(0, eq).trim().equalsIgnoreCase("charset"))) {
        out.append(';').append(part);
      }
    }
    return out.toString();
  }

  /** The {@code charset} parameter of a content type, unquoted, or {@code null}. */
  static String charsetParameter(String type) {
    if (type == null) {
      return null;
    }
    String[] parts = type.split(";");
    for (int i = 1; i < parts.length; i++) {
      String part = parts[i].trim();
      int eq = part.indexOf('=');
      if (eq > 0 && part.substring(0, eq).trim().equalsIgnoreCase("charset")) {
        String value = part.substring(eq + 1).trim();
        if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
          value = value.substring(1, value.length() - 1);
        }
        return value.isEmpty() ? null : value;
      }
    }
    return null;
  }

  @Override
  public String getContentType() {
    String type = getHeader(CONTENT_TYPE);
    if (type != null && characterEncoding != null) {
      // One charset parameter, the one the body is (or will be) encoded in.
      return withoutCharset(type) + ";charset=" + characterEncoding;
    }
    return type;
  }

  @Override
  public void setCharacterEncoding(String charset) {
    if (!charsetFixed) {
      characterEncoding = charset;
    }
  }

  @Override
  public String getCharacterEncoding() {
    return characterEncoding != null ? characterEncoding : super.getCharacterEncoding();
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
    encodeChars(true);
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
    // As if written directly: a header the handler set replaces what outer filters or the
    // container put there; one it only added to keeps those values (Set-Cookie, Vary).
    headers.forEach((name, values) -> {
      boolean first = replaced.contains(name);
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
