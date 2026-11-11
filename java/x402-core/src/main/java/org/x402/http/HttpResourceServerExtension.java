package org.x402.http;

import org.x402.core.server.ResourceServerExtension;

/**
 * A resource-server extension with HTTP transport hooks. Its protected-request hook runs after the
 * server-wide ones, only for routes that declare the extension.
 */
public interface HttpResourceServerExtension extends ResourceServerExtension {

  /**
   * Runs before payment processing of a route declaring this extension.
   *
   * @param declaration the route's declaration
   * @param context the request
   * @param routeConfig the route
   * @return proceed, grant access or abort
   */
  default ProtectedRequestHook.Result onProtectedRequest(
      Object declaration, HttpRequestContext context, RouteConfig routeConfig) {
    return ProtectedRequestHook.Result.proceed();
  }
}
