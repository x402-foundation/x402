package org.x402.spring.web.reactive;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Supplier;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.reactive.result.method.RequestMappingInfoHandlerMapping;
import org.springframework.web.util.pattern.PathPattern;
import org.x402.spring.offer.HandlerMethodSource;
import org.x402.spring.web.StreamingHandlers;

/** The WebFlux handler methods (reactive {@link RequestMappingInfoHandlerMapping}s). */
public final class ReactiveHandlerMethodSource implements HandlerMethodSource {

  private final Supplier<List<RequestMappingInfoHandlerMapping>> mappings;

  /**
   * Creates the source.
   *
   * @param mappings the request mappings, read when {@link #mappings()} is called
   */
  public ReactiveHandlerMethodSource(Supplier<List<RequestMappingInfoHandlerMapping>> mappings) {
    this.mappings = mappings;
  }

  @Override
  public List<Mapping> mappings() {
    List<Mapping> out = new ArrayList<>();
    for (RequestMappingInfoHandlerMapping mapping : mappings.get()) {
      mapping.getHandlerMethods().forEach((info, handler) -> {
        Set<String> patterns = new LinkedHashSet<>();
        for (PathPattern p : info.getPatternsCondition().getPatterns()) {
          patterns.add(p.getPatternString());
        }
        Set<String> methods = new LinkedHashSet<>();
        info.getMethodsCondition().getMethods().forEach(m -> methods.add(m.name()));
        out.add(new Mapping(handler, patterns, methods));
      });
    }
    return out;
  }

  @Override
  public boolean isStreaming(HandlerMethod handlerMethod) {
    return isStreamingHandler(handlerMethod);
  }

  /**
   * Whether a WebFlux handler streams; see {@link StreamingHandlers}.
   *
   * @param handlerMethod the handler
   * @return {@code true} for a streaming handler
   */
  public static boolean isStreamingHandler(HandlerMethod handlerMethod) {
    return StreamingHandlers.isStreaming(handlerMethod);
  }
}
