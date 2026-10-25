package org.x402.spring.client;

import java.lang.reflect.Field;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.http.HttpClient;
import java.util.List;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.client.ClientHttpRequest;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.util.ClassUtils;
import org.springframework.util.ReflectionUtils;
import org.x402.core.client.X402ClientException;
import org.x402.http.HostPolicy;
import org.x402.http.X402Headers;

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

  private static final Log LOG = LogFactory.getLog(TransportRedirects.class);

  private TransportRedirects() {}

  /** Headers dropped when a paid request is re-sent as a bodyless GET. */
  public static final List<String> BODY_HEADERS = List.of(HttpHeaders.CONTENT_TYPE,
      HttpHeaders.CONTENT_ENCODING, HttpHeaders.CONTENT_LANGUAGE, HttpHeaders.CONTENT_LENGTH);

  /**
   * Whether a status is a redirect the clients act on.
   *
   * @param status the status code
   * @return {@code true} for 301, 302, 303, 307 and 308
   */
  public static boolean isRedirect(int status) {
    return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
  }

  /**
   * Whether a redirect turns the request into a bodyless GET: a 303, or a 301/302 of a POST.
   *
   * @param status the redirect status
   * @param method the request method
   * @return {@code true} when the next request is a GET without a body
   */
  public static boolean toGet(int status, HttpMethod method) {
    return status == 303 || ((status == 301 || status == 302) && HttpMethod.POST.equals(method));
  }

  /**
   * Where a paid request may be re-sent after it was answered with a redirect, the one case the
   * Spring clients allow: a same-host http-to-https upgrade on the default ports, to a host the
   * policy allows, of a response that has not already settled the payment (no {@code
   * PAYMENT-RESPONSE}: re-sending would pay, or be refused as a duplicate, a second time).
   *
   * @param from the paid request's URI
   * @param status the response status
   * @param headers the response headers
   * @param hostPolicy the client's host policy
   * @return the target, or {@code null} when the response is returned as it is
   */
  public static URI paidRedirectTarget(URI from, int status, HttpHeaders headers,
      HostPolicy hostPolicy) {
    if (!isRedirect(status) || headers.getFirst(X402Headers.PAYMENT_RESPONSE) != null) {
      return null;
    }
    String location = headers.getFirst(HttpHeaders.LOCATION);
    if (location == null || location.isBlank()) {
      return null;
    }
    URI target;
    try {
      target = from.resolve(location);
    } catch (IllegalArgumentException e) {
      return null;
    }
    if (!secureUpgrade(from, target) || !hostPolicy.allows(target)) {
      LOG.debug("x402: not re-sending the paid request to " + target
          + ": it is not an http to https upgrade on the same host and default ports; the "
          + "redirect is returned");
      return null;
    }
    return target;
  }

  /**
   * The error for a paid request redirected a second time.
   *
   * @param target where the paid request was re-sent
   * @param location the second redirect's {@code Location}, may be {@code null}
   * @return the exception to throw
   */
  public static X402ClientException redirectedAgain(URI target, String location) {
    return new X402ClientException("x402: the paid request to " + target + " was redirected "
        + "again" + (location == null ? "" : " to " + location)
        + "; a paid request follows one redirect at most, so it was not sent on");
  }

  /**
   * Whether a redirect is a same-host upgrade from http on its default port to https on its
   * default port: the only redirect a paid request is re-sent over. Another port is another
   * origin, as in the plain-Java client.
   *
   * @param from the request URI
   * @param to the redirect target
   * @return {@code true} for such an upgrade
   */
  public static boolean secureUpgrade(URI from, URI to) {
    return "http".equalsIgnoreCase(from.getScheme()) && "https".equalsIgnoreCase(to.getScheme())
        && from.getHost() != null && from.getHost().equalsIgnoreCase(to.getHost())
        && (from.getPort() == -1 || from.getPort() == 80)
        && (to.getPort() == -1 || to.getPort() == 443);
  }

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
