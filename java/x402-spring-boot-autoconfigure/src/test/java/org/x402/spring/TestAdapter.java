package org.x402.spring;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.http.HeaderCodec;
import org.x402.http.HttpAdapter;
import org.x402.http.HttpProcessResult;
import org.x402.http.HttpRequestContext;
import org.x402.http.X402Headers;

/** A plain HTTP adapter for driving the core HTTP server from tests. */
public final class TestAdapter implements HttpAdapter {

  private final String method;
  private final String path;
  private final Map<String, String> headers = new LinkedHashMap<>();

  private TestAdapter(String method, String path) {
    this.method = method;
    this.path = path;
  }

  /**
   * A GET request.
   *
   * @param path the path
   * @return the adapter
   */
  public static TestAdapter get(String path) {
    return new TestAdapter("GET", path);
  }

  /**
   * Adds a header.
   *
   * @param name the name
   * @param value the value
   * @return this adapter
   */
  public TestAdapter header(String name, String value) {
    headers.put(name.toLowerCase(Locale.ROOT), value);
    return this;
  }

  /**
   * The request context.
   *
   * @return the context
   */
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
    return "https://api.example.com" + path;
  }

  /**
   * Decodes the {@code PAYMENT-REQUIRED} header of a 402 result.
   *
   * @param result a payment error
   * @return the 402
   */
  public static PaymentRequired paymentRequired(HttpProcessResult result) {
    return HeaderCodec.decodePaymentRequired(
        ((HttpProcessResult.PaymentError) result).headers().get(X402Headers.PAYMENT_REQUIRED));
  }

  /**
   * Encodes a payment for one advertised option.
   *
   * @param required the 402
   * @param accepted the accepted requirements (may carry extra client fields)
   * @param mode the fake facilitator mode, or {@code null}
   * @return the {@code PAYMENT-SIGNATURE} value
   */
  public static String signature(PaymentRequired required, PaymentRequirements accepted,
      String mode) {
    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("signature", "sig");
    if (mode != null) {
      payload.put("mode", mode);
    }
    return HeaderCodec.encodePaymentSignature(new PaymentPayload(2, required.resource(), accepted,
        payload, required.extensions()));
  }
}
