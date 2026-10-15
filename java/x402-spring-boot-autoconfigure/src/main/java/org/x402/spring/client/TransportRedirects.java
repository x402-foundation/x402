package org.x402.spring.client;

import java.lang.reflect.Field;
import java.net.HttpURLConnection;
import java.net.http.HttpClient;
import org.springframework.http.client.ClientHttpRequest;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.util.ClassUtils;
import org.springframework.util.ReflectionUtils;

/**
 * Whether a transport can follow a redirect with a paid request, so a payment is never signed
 * over one that might leak {@code PAYMENT-SIGNATURE}. Recognised
 * transports are inspected; anything else is {@link Safety#UNKNOWN}, and the payment clients do
 * not sign over it.
 */
public final class TransportRedirects {

  /** What is known about a transport's redirect handling. */
  public enum Safety {
    /** Provably does not follow redirects for the paid request. */
    SAFE,
    /** Known to follow redirects. */
    FOLLOWS,
    /** Cannot be verified. */
    UNKNOWN
  }

  private static final boolean REACTOR_NETTY = ClassUtils.isPresent(
      "reactor.netty.http.client.HttpClient", TransportRedirects.class.getClassLoader());
  private static final String SIMPLE_REQUEST = "org.springframework.http.client.SimpleClientHttpRequest";

  private TransportRedirects() {}

  /**
   * Inspects a blocking request factory or a reactive connector. Spring's factory wrappers are
   * unwrapped; JDK and Reactor Netty clients are read; {@link SimpleClientHttpRequestFactory} is
   * safe because {@link #disableOnPaidRequest} switches redirects off per paid connection.
   *
   * @param transport the factory or connector, may be {@code null}
   * @return the safety
   */
  public static Safety of(Object transport) {
    Object current = transport;
    for (int depth = 0; current != null && depth < 8; depth++) {
      if (current instanceof SimpleClientHttpRequestFactory) {
        // Only the factory itself: behind a wrapper the paid request is not the Simple request,
        // so redirects could not be switched off on its connection.
        return depth == 0 && simpleRequestField() != null ? Safety.SAFE : Safety.UNKNOWN;
      }
      Object client = read(current, "httpClient");
      if (client instanceof HttpClient jdk) {
        return jdk.followRedirects() == HttpClient.Redirect.NEVER ? Safety.SAFE : Safety.FOLLOWS;
      }
      if (client != null && REACTOR_NETTY && Reactor.isClient(client)) {
        return Reactor.follows(client) ? Safety.FOLLOWS : Safety.SAFE;
      }
      current = read(current, "requestFactory");
    }
    return Safety.UNKNOWN;
  }

  /**
   * Switches redirects off on a paid {@code HttpURLConnection} request, when it is one.
   *
   * @param request the paid request
   * @return {@code true} when the request is an {@code HttpURLConnection} request and redirects
   *     are now off
   */
  public static boolean disableOnPaidRequest(ClientHttpRequest request) {
    Field field = simpleRequestField();
    if (field != null && field.getDeclaringClass().isInstance(request)) {
      Object connection = ReflectionUtils.getField(field, request);
      if (connection instanceof HttpURLConnection http) {
        http.setInstanceFollowRedirects(false);
        return true;
      }
    }
    return false;
  }

  private static Field simpleRequestField() {
    try {
      Class<?> type = ClassUtils.forName(SIMPLE_REQUEST, TransportRedirects.class.getClassLoader());
      Field field = ReflectionUtils.findField(type, "connection", HttpURLConnection.class);
      if (field != null) {
        ReflectionUtils.makeAccessible(field);
      }
      return field;
    } catch (ClassNotFoundException | LinkageError | RuntimeException e) {
      return null;
    }
  }

  private static Object read(Object target, String name) {
    Field field = ReflectionUtils.findField(target.getClass(), name);
    if (field == null) {
      return null;
    }
    try {
      ReflectionUtils.makeAccessible(field);
      return field.get(target);
    } catch (IllegalAccessException | RuntimeException e) {
      return null;
    }
  }

  /** Isolates the optional Reactor Netty types. */
  static final class Reactor {
    private Reactor() {}

    static boolean isClient(Object client) {
      return client instanceof reactor.netty.http.client.HttpClient;
    }

    static boolean follows(Object client) {
      return ((reactor.netty.http.client.HttpClient) client).configuration()
          .followRedirectPredicate() != null;
    }
  }
}
