package org.x402.http;

import java.util.Objects;

/**
 * One protected-route request.
 *
 * @param adapter access to headers and URL
 * @param method the HTTP method
 * @param path the <b>raw</b> (not decoded) path within the application, with the context path
 *     removed and {@code ;} parameters stripped
 * @param decodedPath the decoded form of the same path, or {@code null}; tried second when
 *     matching routes
 * @param routePattern the matched route's path pattern, set by the HTTP layer
 */
public record HttpRequestContext(
    HttpAdapter adapter, String method, String path, String decodedPath, String routePattern) {

  /** Validates. */
  public HttpRequestContext {
    Objects.requireNonNull(adapter, "adapter");
  }

  /**
   * A context from an adapter's method and path.
   *
   * @param adapter the adapter
   * @return the context
   */
  public static HttpRequestContext of(HttpAdapter adapter) {
    return new HttpRequestContext(adapter, adapter.getMethod(), adapter.getPath(), null, null);
  }

  /**
   * Returns a copy with an explicit raw and decoded path.
   *
   * @param rawPath the raw path
   * @param decoded the decoded path, may be {@code null}
   * @return the copy
   */
  public HttpRequestContext withPaths(String rawPath, String decoded) {
    return new HttpRequestContext(adapter, method, rawPath, decoded, routePattern);
  }

  /**
   * Returns a copy with another method.
   *
   * @param newMethod the method
   * @return the copy
   */
  public HttpRequestContext withMethod(String newMethod) {
    return new HttpRequestContext(adapter, newMethod, path, decodedPath, routePattern);
  }

  /**
   * Returns a copy with the matched route pattern.
   *
   * @param pattern the pattern
   * @return the copy
   */
  public HttpRequestContext withRoutePattern(String pattern) {
    return new HttpRequestContext(adapter, method, path, decodedPath, pattern);
  }

  /**
   * A request header.
   *
   * @param name the name, case-insensitive
   * @return the value, or {@code null}
   */
  public String header(String name) {
    return adapter.getHeader(name);
  }

  /**
   * The request URL.
   *
   * @return the URL
   */
  public String url() {
    return adapter.getUrl();
  }
}
