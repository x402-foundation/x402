package org.x402.spring.web.reactive;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.springframework.http.HttpHeaders;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.http.server.reactive.ServerHttpResponseDecorator;
import org.springframework.web.reactive.HandlerMapping;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.ServerWebExchangeDecorator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Asks the {@code DispatcherHandler}'s handler mappings which handler wins, on an exchange whose
 * attribute and response-header writes stay private (as the servlet side's isolated request).
 */
final class ReactiveHandlerResolver {

  /**
   * The winning handler and its pattern.
   *
   * @param handler the handler, {@code null} when none matches
   * @param pattern the best-matching pattern, may be {@code null}
   */
  record Resolution(Object handler, String pattern) {}

  static final Resolution NONE = new Resolution(null, null);

  private final Supplier<List<HandlerMapping>> mappings;

  ReactiveHandlerResolver(Supplier<List<HandlerMapping>> mappings) {
    this.mappings = mappings;
  }

  Mono<Resolution> resolve(ServerWebExchange exchange) {
    Isolated isolated = new Isolated(exchange);
    List<HandlerMapping> all = mappings.get();
    if (all == null) {
      return Mono.just(NONE);
    }
    return Flux.fromIterable(all)
        .concatMap(m -> m.getHandler(isolated)
            .map(handler -> new Resolution(handler, pattern(isolated)))
            .onErrorResume(e -> Mono.just(NONE)))
        .next()
        .defaultIfEmpty(NONE);
  }

  private static String pattern(ServerWebExchange exchange) {
    Object p = exchange.getAttributes().get(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
    return p == null ? null : p.toString();
  }

  /** Private attributes and response headers; everything else is the real exchange. */
  static final class Isolated extends ServerWebExchangeDecorator {
    private final Map<String, Object> attributes;
    private final ServerHttpResponse response;

    Isolated(ServerWebExchange delegate) {
      super(delegate);
      this.attributes = new HashMap<>(delegate.getAttributes());
      HttpHeaders headers = new HttpHeaders();
      headers.putAll(delegate.getResponse().getHeaders());
      this.response = new ServerHttpResponseDecorator(delegate.getResponse()) {
        @Override
        public HttpHeaders getHeaders() {
          return headers;
        }
      };
    }

    @Override
    public Map<String, Object> getAttributes() {
      return attributes;
    }

    @Override
    public ServerHttpResponse getResponse() {
      return response;
    }
  }
}
