package org.x402.servlet;

import jakarta.servlet.AsyncContext;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpUpgradeHandler;

/**
 * The request a paid handler sees. Asynchronous processing and protocol upgrades are refused:
 * both would give the handler the unbuffered response, which would reach the client before the
 * payment settles. From #4129 (Stefano Amorelli).
 */
final class PaidRequest extends HttpServletRequestWrapper {

  static final String UNSUPPORTED = "x402 PaymentFilter does not support asynchronous "
      + "processing or protocol upgrades on paid routes: the response is held back until the "
      + "payment settles";

  PaidRequest(HttpServletRequest request) {
    super(request);
  }

  @Override
  public boolean isAsyncSupported() {
    return false;
  }

  @Override
  public AsyncContext startAsync() {
    throw new IllegalStateException(UNSUPPORTED);
  }

  @Override
  public AsyncContext startAsync(ServletRequest servletRequest, ServletResponse servletResponse) {
    throw new IllegalStateException(UNSUPPORTED);
  }

  @Override
  public <T extends HttpUpgradeHandler> T upgrade(Class<T> handlerClass)
      throws ServletException {
    throw new ServletException(UNSUPPORTED);
  }
}
