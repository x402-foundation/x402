package org.x402.spring;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.function.BooleanSupplier;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.SettleResponse;
import org.x402.http.HeaderCodec;
import org.x402.http.X402Headers;

/** A plain {@code java.net.http} client for the starter's real-server tests. */
public final class TestHttp {

  private static final HttpClient CLIENT = HttpClient.newBuilder()
      .connectTimeout(Duration.ofSeconds(5)).build();

  private TestHttp() {}

  /**
   * Sends a request.
   *
   * @param method the method
   * @param uri the URI
   * @param headers alternating header names and values
   * @return the response
   */
  public static HttpResponse<String> send(String method, String uri, String... headers) {
    HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(uri)).timeout(Duration.ofSeconds(30))
        .method(method, HttpRequest.BodyPublishers.noBody());
    for (int i = 0; i < headers.length; i += 2) {
      b.header(headers[i], headers[i + 1]);
    }
    return send(b.build());
  }

  /**
   * Sends a request with a body.
   *
   * @param method the method
   * @param uri the URI
   * @param contentType the content type
   * @param body the body
   * @param headers alternating header names and values
   * @return the response
   */
  public static HttpResponse<String> sendBody(String method, String uri, String contentType,
      String body, String... headers) {
    HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(uri)).timeout(Duration.ofSeconds(30))
        .method(method, HttpRequest.BodyPublishers.ofString(body))
        .header("Content-Type", contentType);
    for (int i = 0; i < headers.length; i += 2) {
      b.header(headers[i], headers[i + 1]);
    }
    return send(b.build());
  }

  /**
   * GET.
   *
   * @param uri the URI
   * @param headers alternating header names and values
   * @return the response
   */
  public static HttpResponse<String> get(String uri, String... headers) {
    return send("GET", uri, headers);
  }

  private static HttpResponse<String> send(HttpRequest request) {
    try {
      return CLIENT.send(request, HttpResponse.BodyHandlers.ofString());
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException(e);
    }
  }

  /**
   * The decoded {@code PAYMENT-REQUIRED} header.
   *
   * @param response a 402
   * @return the 402 body
   */
  public static PaymentRequired required(HttpResponse<?> response) {
    return HeaderCodec.decodePaymentRequired(
        response.headers().firstValue(X402Headers.PAYMENT_REQUIRED).orElseThrow(
            () -> new AssertionError("no PAYMENT-REQUIRED header; status "
                + response.statusCode())));
  }

  /**
   * The decoded {@code PAYMENT-RESPONSE} header, or {@code null}.
   *
   * @param response a response
   * @return the settlement
   */
  public static SettleResponse settlement(HttpResponse<?> response) {
    return response.headers().firstValue(X402Headers.PAYMENT_RESPONSE)
        .map(HeaderCodec::decodePaymentResponse).orElse(null);
  }

  /**
   * A {@code PAYMENT-SIGNATURE} for option {@code index} of a 402.
   *
   * @param unpaid the 402 response
   * @param index the option
   * @param mode the fake facilitator mode, or {@code null}
   * @return the header value
   */
  public static String pay(HttpResponse<?> unpaid, int index, String mode) {
    PaymentRequired required = required(unpaid);
    return TestAdapter.signature(required, required.accepts().get(index), mode);
  }

  /**
   * Waits until a condition holds.
   *
   * @param timeout the maximum wait
   * @param condition the condition
   */
  public static void await(Duration timeout, BooleanSupplier condition) {
    long deadline = System.nanoTime() + timeout.toNanos();
    while (!condition.getAsBoolean()) {
      if (System.nanoTime() > deadline) {
        throw new AssertionError("condition not met within " + timeout);
      }
      try {
        Thread.sleep(25);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException(e);
      }
    }
  }
}
