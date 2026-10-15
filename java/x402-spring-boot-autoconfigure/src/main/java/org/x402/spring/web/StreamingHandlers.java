package org.x402.spring.web;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import org.springframework.core.ResolvableType;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.util.ClassUtils;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.method.HandlerMethod;

/**
 * Streaming detection shared by the WebMvc and WebFlux handler sources: a handler streams when it
 * produces {@code text/event-stream}, NDJSON or {@code application/stream+json}, or returns a
 * {@code Flux<ServerSentEvent>}. A streaming response cannot be buffered until settlement.
 */
public final class StreamingHandlers {

  private static final List<String> STREAMING_TYPES = List.of(
      MediaType.TEXT_EVENT_STREAM_VALUE, MediaType.APPLICATION_NDJSON_VALUE,
      "application/stream+json");
  private static final boolean REACTOR_PRESENT =
      ClassUtils.isPresent("reactor.core.publisher.Flux", StreamingHandlers.class.getClassLoader());

  private StreamingHandlers() {}

  /**
   * Whether a handler streams by its produces or by returning {@code Flux<ServerSentEvent>}.
   *
   * @param handlerMethod the handler
   * @return {@code true} for a streaming handler
   */
  public static boolean isStreaming(HandlerMethod handlerMethod) {
    if (REACTOR_PRESENT && ReactorTypes.returnsServerSentEvents(handlerMethod)) {
      return true;
    }
    return producesStream(AnnotatedElementUtils.findMergedAnnotation(handlerMethod.getMethod(),
        RequestMapping.class))
        || producesStream(AnnotatedElementUtils.findMergedAnnotation(handlerMethod.getBeanType(),
            RequestMapping.class));
  }

  private static boolean producesStream(RequestMapping mapping) {
    return mapping != null && Arrays.stream(mapping.produces())
        .map(p -> p.toLowerCase(Locale.ROOT))
        .anyMatch(p -> STREAMING_TYPES.stream().anyMatch(p::startsWith));
  }

  /** Loaded only when Reactor is on the classpath (it is optional for WebMvc apps). */
  private static final class ReactorTypes {
    private ReactorTypes() {}

    static boolean returnsServerSentEvents(HandlerMethod handlerMethod) {
      ResolvableType type = ResolvableType.forMethodReturnType(handlerMethod.getMethod());
      if (!reactor.core.publisher.Flux.class.isAssignableFrom(type.resolve(Object.class))) {
        return false;
      }
      Class<?> element = type.as(reactor.core.publisher.Flux.class).getGeneric(0).resolve();
      return element != null && ServerSentEvent.class.isAssignableFrom(element);
    }
  }
}
