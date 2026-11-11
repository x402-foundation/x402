package org.x402.http;

/**
 * What the HTTP layer needs from a framework's request. Header lookup
 * must be case-insensitive.
 */
public interface HttpAdapter {

  /**
   * A request header, case-insensitively.
   *
   * @param name the header name
   * @return the first value, or {@code null}
   */
  String getHeader(String name);

  /**
   * The HTTP method.
   *
   * @return the method
   */
  String getMethod();

  /**
   * The raw path within the application.
   *
   * @return the path
   */
  String getPath();

  /**
   * The full request URL, used as the default {@code resource.url}.
   *
   * @return the URL
   */
  String getUrl();

  /**
   * The {@code Accept} header.
   *
   * @return the value, or an empty string
   */
  default String getAcceptHeader() {
    String value = getHeader("Accept");
    return value == null ? "" : value;
  }

  /**
   * The {@code User-Agent} header.
   *
   * @return the value, or an empty string
   */
  default String getUserAgent() {
    String value = getHeader("User-Agent");
    return value == null ? "" : value;
  }
}
