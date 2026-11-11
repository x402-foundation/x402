package org.x402.servlet;

import jakarta.servlet.http.HttpServletRequest;
import org.x402.http.HttpAdapter;

/** A servlet request as the core HTTP layer reads it. */
final class ServletRequestAdapter implements HttpAdapter {

  private final HttpServletRequest request;
  private final String rawPath;
  private final boolean paywall;

  ServletRequestAdapter(HttpServletRequest request, String rawPath, boolean paywall) {
    this.request = request;
    this.rawPath = rawPath;
    this.paywall = paywall;
  }

  @Override
  public String getHeader(String name) {
    return request.getHeader(name);
  }

  @Override
  public String getMethod() {
    return request.getMethod();
  }

  @Override
  public String getPath() {
    return rawPath;
  }

  @Override
  public String getUrl() {
    String query = request.getQueryString();
    return request.getRequestURL() + (query == null ? "" : "?" + query);
  }

  @Override
  public String getUserAgent() {
    // Paywall off: never detected as a browser, so 402s stay JSON.
    return paywall ? HttpAdapter.super.getUserAgent() : "";
  }

  /**
   * The request path within the application, still percent-encoded: the request URI with every
   * segment's {@code ;} parameters removed (as the Spring adapters and {@code UrlPathHelper} do, so
   * a router that strips them without resolving dot segments is covered) and without the context
   * path (cut at a segment boundary).
   *
   * @param request the request
   * @return the raw path, {@code /} at least
   */
  static String rawPath(HttpServletRequest request) {
    String uri = request.getRequestURI();
    if (uri == null || uri.isEmpty()) {
      return "/";
    }
    uri = removeSemicolonContent(uri);
    String context = removeSemicolonContent(
        request.getContextPath() == null ? "" : request.getContextPath());
    if (!context.isEmpty() && uri.startsWith(context)
        && (uri.length() == context.length() || uri.charAt(context.length()) == '/')) {
      uri = uri.substring(context.length());
    }
    return uri.isEmpty() ? "/" : uri;
  }

  /**
   * Cuts every segment at its first {@code ;} (matrix parameters, {@code jsessionid}); an encoded
   * {@code %3B} is not a delimiter and stays.
   *
   * @param path a raw path
   * @return the path without {@code ;} parameters
   */
  static String removeSemicolonContent(String path) {
    if (path.indexOf(';') < 0) {
      return path;
    }
    StringBuilder out = new StringBuilder(path.length());
    int start = 0;
    while (true) {
      int slash = path.indexOf('/', start);
      String segment = path.substring(start, slash < 0 ? path.length() : slash);
      int semicolon = segment.indexOf(';');
      out.append(semicolon < 0 ? segment : segment.substring(0, semicolon));
      if (slash < 0) {
        return out.toString();
      }
      out.append('/');
      start = slash + 1;
    }
  }

  /**
   * The path the container dispatches on: decoded, {@code ;} parameters removed and dot segments
   * resolved ({@code servletPath + pathInfo}).
   *
   * @param request the request
   * @return the decoded path, or {@code null} when the container exposes none
   */
  static String decodedPath(HttpServletRequest request) {
    String servletPath = request.getServletPath();
    String pathInfo = request.getPathInfo();
    String path = (servletPath == null ? "" : servletPath) + (pathInfo == null ? "" : pathInfo);
    return path.isEmpty() ? null : path;
  }
}
