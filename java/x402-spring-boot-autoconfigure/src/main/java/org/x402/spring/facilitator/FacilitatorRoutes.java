package org.x402.spring.facilitator;

import java.util.List;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.x402.http.facilitator.FacilitatorHttpHandler;
import org.x402.http.facilitator.FacilitatorHttpResponse;
import org.x402.spring.web.reactive.BlockingCalls;

/**
 * Thin router functions over {@link FacilitatorHttpHandler}: the three endpoint paths under the
 * base path go to the handler with any method (it answers 405 for the wrong one); nothing else is
 * matched, so a root base path does not swallow the application's own routes.
 */
final class FacilitatorRoutes {

  private FacilitatorRoutes() {}

  static List<String> paths(FacilitatorHttpHandler handler) {
    String base = handler.basePath();
    return List.of(base + "/verify", base + "/settle", base + "/supported");
  }

  static org.springframework.web.servlet.function.RouterFunction<
      org.springframework.web.servlet.function.ServerResponse> mvc(
      FacilitatorHttpHandler handler) {
    List<String> paths = paths(handler);
    return org.springframework.web.servlet.function.RouterFunctions.route(
        request -> paths.contains(request.requestPath().pathWithinApplication().value()),
        request -> {
          byte[] body = "GET".equals(request.method().name()) ? new byte[0]
              : request.body(byte[].class);
          FacilitatorHttpResponse response = handler.handle(request.method().name(),
              request.requestPath().pathWithinApplication().value(), body);
          return org.springframework.web.servlet.function.ServerResponse
              .status(HttpStatusCode.valueOf(response.status()))
              .contentType(MediaType.APPLICATION_JSON).body(response.body());
        });
  }

  static org.springframework.web.reactive.function.server.RouterFunction<
      org.springframework.web.reactive.function.server.ServerResponse> webflux(
      FacilitatorHttpHandler handler) {
    List<String> paths = paths(handler);
    return org.springframework.web.reactive.function.server.RouterFunctions.route(
        request -> paths.contains(request.requestPath().pathWithinApplication().value()),
        request -> request.bodyToMono(byte[].class).defaultIfEmpty(new byte[0])
            .flatMap(body -> BlockingCalls.offload(() -> handler.handle(
                request.method().name(), request.requestPath().pathWithinApplication().value(),
                body)))
            .flatMap(response -> org.springframework.web.reactive.function.server.ServerResponse
                .status(HttpStatusCode.valueOf(response.status()))
                .contentType(MediaType.APPLICATION_JSON).bodyValue(response.body())));
  }
}
