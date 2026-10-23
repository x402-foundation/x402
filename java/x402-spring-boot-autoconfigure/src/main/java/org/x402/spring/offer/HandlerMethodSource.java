package org.x402.spring.offer;

import java.util.List;
import java.util.Objects;
import java.util.Set;
import org.springframework.web.method.HandlerMethod;

/**
 * The handler methods of one web stack, for {@link OfferRegistry}. WebMvc and WebFlux each supply
 * one; the registry itself is stack-neutral.
 */
public interface HandlerMethodSource {

  /**
   * One request mapping.
   *
   * @param handlerMethod the handler
   * @param patterns its URL patterns (Spring syntax)
   * @param methods its HTTP methods; empty = any
   */
  record Mapping(HandlerMethod handlerMethod, Set<String> patterns, Set<String> methods) {

    /** Copies the sets. */
    public Mapping {
      Objects.requireNonNull(handlerMethod, "handlerMethod");
      patterns = Set.copyOf(patterns);
      methods = Set.copyOf(methods);
    }
  }

  /**
   * Every mapping.
   *
   * @return the mappings
   */
  List<Mapping> mappings();

  /**
   * Whether a handler streams its response (cannot be buffered for settle-after-handler).
   *
   * @param handlerMethod the handler
   * @return {@code true} for a streaming handler
   */
  boolean isStreaming(HandlerMethod handlerMethod);
}
