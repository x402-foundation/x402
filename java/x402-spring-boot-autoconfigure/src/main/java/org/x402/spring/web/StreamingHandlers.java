package org.x402.spring.web;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletionStage;
import org.springframework.core.ResolvableType;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.http.HttpEntity;
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
  /**
   * Single-value wrappers Spring unwraps before writing the body. The WebMvc ones are optional
   * (absent in a WebFlux-only app); {@code ListenableFuture} is gone in Spring 7.
   */
  private static final List<Class<?>> WRAPPERS = wrappers();
  private static final boolean REACTOR_PRESENT =
      ClassUtils.isPresent("reactor.core.publisher.Flux", StreamingHandlers.class.getClassLoader());

  private StreamingHandlers() {}

  private static List<Class<?>> wrappers() {
    List<Class<?>> wrappers = new ArrayList<>(List.of(HttpEntity.class, CompletionStage.class,
        Callable.class));
    for (String name : List.of("org.springframework.web.context.request.async.DeferredResult",
        "org.springframework.web.context.request.async.WebAsyncTask",
        "org.springframework.util.concurrent.ListenableFuture")) {
      ClassLoader loader = StreamingHandlers.class.getClassLoader();
      if (ClassUtils.isPresent(name, loader)) {
        wrappers.add(ClassUtils.resolveClassName(name, loader));
      }
    }
    return List.copyOf(wrappers);
  }

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

  /**
   * The body type of a handler's return value with its asynchronous and entity wrappers peeled
   * off: {@code ResponseEntity}/{@code HttpEntity}, {@code Mono}, {@code CompletionStage}, {@code
   * Callable}, {@code DeferredResult}, {@code WebAsyncTask} and {@code ListenableFuture}, in any
   * nesting.
   *
   * @param handlerMethod the handler
   * @return the innermost type; {@link ResolvableType#NONE} when it cannot be resolved
   */
  public static ResolvableType unwrappedReturnType(HandlerMethod handlerMethod) {
    ResolvableType type = ResolvableType.forMethodReturnType(handlerMethod.getMethod(),
        handlerMethod.getBeanType());
    for (int depth = 0; depth < 8; depth++) {
      Class<?> raw = type.resolve();
      Class<?> wrapper = raw == null ? null : wrapper(raw);
      if (wrapper == null) {
        return type;
      }
      ResolvableType inner = type.as(wrapper).getGeneric(0);
      if (inner.resolve() == null) {
        return inner;
      }
      type = inner;
    }
    return type;
  }

  private static Class<?> wrapper(Class<?> raw) {
    for (Class<?> wrapper : WRAPPERS) {
      if (wrapper.isAssignableFrom(raw)) {
        return wrapper;
      }
    }
    return "reactor.core.publisher.Mono".equals(raw.getName()) ? raw : null;
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
      ResolvableType type = unwrappedReturnType(handlerMethod);
      if (!reactor.core.publisher.Flux.class.isAssignableFrom(type.resolve(Object.class))) {
        return false;
      }
      Class<?> element = type.as(reactor.core.publisher.Flux.class).getGeneric(0).resolve();
      return element != null && ServerSentEvent.class.isAssignableFrom(element);
    }
  }
}
