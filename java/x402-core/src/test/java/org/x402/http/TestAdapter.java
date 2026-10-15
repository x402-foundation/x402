package org.x402.http;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import org.x402.core.types.PaymentPayload;

/** A map-backed {@link HttpAdapter} for tests. */
public final class TestAdapter implements HttpAdapter {

  private final String method;
  private final String path;
  private final String url;
  private final Map<String, String> headers = new LinkedHashMap<>();

  private TestAdapter(String method, String path) {
    this.method = method;
    this.path = path;
    this.url = "https://api.example.com" + path;
  }

  public static TestAdapter get(String path) {
    return new TestAdapter("GET", path);
  }

  public static TestAdapter request(String method, String path) {
    return new TestAdapter(method, path);
  }

  public TestAdapter header(String name, String value) {
    headers.put(name.toLowerCase(Locale.ROOT), value);
    return this;
  }

  public TestAdapter paying(PaymentPayload payload) {
    return header(X402Headers.PAYMENT_SIGNATURE, HeaderCodec.encodePaymentSignature(payload));
  }

  public TestAdapter browser() {
    return header("Accept", "text/html,application/xhtml+xml")
        .header("User-Agent", "Mozilla/5.0 (Macintosh)");
  }

  public HttpRequestContext context() {
    return HttpRequestContext.of(this);
  }

  @Override
  public String getHeader(String name) {
    return headers.get(name.toLowerCase(Locale.ROOT));
  }

  @Override
  public String getMethod() {
    return method;
  }

  @Override
  public String getPath() {
    return path;
  }

  @Override
  public String getUrl() {
    return url;
  }
}
