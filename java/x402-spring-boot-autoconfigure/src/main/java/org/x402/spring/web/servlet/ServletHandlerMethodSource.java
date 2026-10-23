package org.x402.spring.web.servlet;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Supplier;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfoHandlerMapping;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import org.x402.spring.offer.HandlerMethodSource;
import org.x402.spring.web.StreamingHandlers;

/** The WebMvc handler methods ({@link RequestMappingInfoHandlerMapping}s). */
public final class ServletHandlerMethodSource implements HandlerMethodSource {

  private final Supplier<List<RequestMappingInfoHandlerMapping>> mappings;

  /**
   * Creates the source.
   *
   * @param mappings the request mappings, read when {@link #mappings()} is called
   */
  public ServletHandlerMethodSource(Supplier<List<RequestMappingInfoHandlerMapping>> mappings) {
    this.mappings = mappings;
  }

  @Override
  public List<Mapping> mappings() {
    List<Mapping> out = new ArrayList<>();
    for (RequestMappingInfoHandlerMapping mapping : mappings.get()) {
      mapping.getHandlerMethods().forEach((info, handler) -> {
        Set<String> methods = new LinkedHashSet<>();
        info.getMethodsCondition().getMethods().forEach(m -> methods.add(m.name()));
        out.add(new Mapping(handler, info.getPatternValues(), methods));
      });
    }
    return out;
  }

  @Override
  public boolean isStreaming(HandlerMethod handlerMethod) {
    return isStreamingHandler(handlerMethod);
  }

  /**
   * Whether a WebMvc handler streams: {@code SseEmitter}, {@code ResponseBodyEmitter}, {@code
   * StreamingResponseBody} (also inside {@code ResponseEntity}, {@code CompletableFuture},
   * {@code Callable} or {@code Mono}), or what {@link StreamingHandlers}
   * recognises on both stacks.
   *
   * @param handlerMethod the handler
   * @return {@code true} for a streaming handler
   */
  public static boolean isStreamingHandler(HandlerMethod handlerMethod) {
    Class<?> type = StreamingHandlers.unwrappedReturnType(handlerMethod).resolve();
    if (type != null && streamingType(type)) {
      return true;
    }
    return StreamingHandlers.isStreaming(handlerMethod);
  }

  private static boolean streamingType(Class<?> type) {
    return ResponseBodyEmitter.class.isAssignableFrom(type)
        || StreamingResponseBody.class.isAssignableFrom(type);
  }
}
