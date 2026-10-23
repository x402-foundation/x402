package org.x402.spring.facilitator;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.List;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.core.io.buffer.DataBufferUtils;
import org.springframework.web.reactive.function.BodyExtractors;
import org.springframework.http.HttpHeaders;
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

  /** The largest request body read (256 KB); larger ones are answered with 413. */
  static final int MAX_BODY_BYTES = 256 * 1024;

  private static final byte[] TOO_LARGE =
      "{\"error\":\"request body too large\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);

  private FacilitatorRoutes() {}

  /** Thrown when a body outgrows {@link #MAX_BODY_BYTES}. */
  private static final class BodyTooLarge extends RuntimeException {
    private static final long serialVersionUID = 1L;

    BodyTooLarge() {
      super("request body too large", null, false, false);
    }
  }

  private static byte[] readBounded(InputStream in) {
    try (in) {
      byte[] data = in.readNBytes(MAX_BODY_BYTES + 1);
      if (data.length > MAX_BODY_BYTES) {
        throw new BodyTooLarge();
      }
      return data;
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

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
          if (request.headers().contentLength().orElse(0L) > MAX_BODY_BYTES) {
            return tooLargeMvc();
          }
          byte[] body;
          try {
            body = "GET".equals(request.method().name()) ? new byte[0]
                : readBounded(request.servletRequest().getInputStream());
          } catch (BodyTooLarge e) {
            return tooLargeMvc();
          }
          FacilitatorHttpResponse response = handler.handle(request.method().name(),
              request.requestPath().pathWithinApplication().value(), body);
          return org.springframework.web.servlet.function.ServerResponse
              .status(HttpStatusCode.valueOf(response.status()))
              .contentType(MediaType.APPLICATION_JSON).body(response.body());
        });
  }

  private static org.springframework.web.servlet.function.ServerResponse tooLargeMvc() {
    // Connection: close, so the server stops reading an oversized (or endless) upload instead of
    // draining it to keep the connection.
    return org.springframework.web.servlet.function.ServerResponse.status(413)
        .header(HttpHeaders.CONNECTION, "close")
        .contentType(MediaType.APPLICATION_JSON).body(TOO_LARGE);
  }

  private static reactor.core.publisher.Mono<
      org.springframework.web.reactive.function.server.ServerResponse> tooLargeFlux() {
    return org.springframework.web.reactive.function.server.ServerResponse.status(413)
        .header(HttpHeaders.CONNECTION, "close")
        .contentType(MediaType.APPLICATION_JSON).bodyValue(TOO_LARGE);
  }

  /** The request body in memory, or {@link BodyTooLarge} before it outgrows the cap. */
  private static reactor.core.publisher.Mono<byte[]> readBoundedFlux(
      org.springframework.web.reactive.function.server.ServerRequest request) {
    return DataBufferUtils.join(request.body(BodyExtractors.toDataBuffers()), MAX_BODY_BYTES)
        .map(buffer -> {
          try {
            byte[] bytes = new byte[buffer.readableByteCount()];
            buffer.read(bytes);
            return bytes;
          } finally {
            DataBufferUtils.release(buffer);
          }
        })
        .defaultIfEmpty(new byte[0])
        .onErrorMap(DataBufferLimitException.class, e -> new BodyTooLarge());
  }

  static org.springframework.web.reactive.function.server.RouterFunction<
      org.springframework.web.reactive.function.server.ServerResponse> webflux(
      FacilitatorHttpHandler handler) {
    List<String> paths = paths(handler);
    return org.springframework.web.reactive.function.server.RouterFunctions.route(
        request -> paths.contains(request.requestPath().pathWithinApplication().value()),
        request -> request.headers().contentLength().orElse(0L) > MAX_BODY_BYTES
            ? tooLargeFlux()
            : readBoundedFlux(request)
            .flatMap(body -> BlockingCalls.offload(() -> handler.handle(
                request.method().name(), request.requestPath().pathWithinApplication().value(),
                body)))
            .flatMap(response -> org.springframework.web.reactive.function.server.ServerResponse
                .status(HttpStatusCode.valueOf(response.status()))
                .contentType(MediaType.APPLICATION_JSON).bodyValue(response.body()))
            .onErrorResume(BodyTooLarge.class, e -> tooLargeFlux()));
  }
}
