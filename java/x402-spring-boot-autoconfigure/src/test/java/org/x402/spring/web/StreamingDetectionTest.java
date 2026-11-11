package org.x402.spring.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.x402.spring.web.reactive.ReactiveHandlerMethodSource;
import org.x402.spring.web.servlet.ServletHandlerMethodSource;
import reactor.core.publisher.Flux;

/**
 * Both stacks recognise the same streaming handlers, so a settle-after-handler offer is refused
 * on either one instead of buffering an endless stream.
 */
class StreamingDetectionTest {

  @SuppressWarnings("unused")
  static class Handlers {
    @GetMapping("/sse")
    Flux<ServerSentEvent<String>> serverSentEvents() {
      return Flux.empty();
    }

    @GetMapping(value = "/ndjson", produces = "application/x-ndjson")
    Flux<String> ndjson() {
      return Flux.empty();
    }

    @GetMapping(value = "/stream-json", produces = "application/stream+json")
    Flux<String> streamJson() {
      return Flux.empty();
    }

    @GetMapping(value = "/events", produces = "text/event-stream")
    Flux<String> eventStream() {
      return Flux.empty();
    }

    @GetMapping("/list")
    Flux<String> collectedList() {
      return Flux.empty();
    }

    @GetMapping("/plain")
    List<String> plain() {
      return List.of();
    }
  }

  @SuppressWarnings("unused")
  static class MvcOnly {
    @GetMapping("/emitter")
    SseEmitter emitter() {
      return new SseEmitter();
    }
  }

  private static HandlerMethod handler(Object bean, String name) throws NoSuchMethodException {
    return new HandlerMethod(bean, bean.getClass().getDeclaredMethod(name));
  }

  @Test
  void webMvcAndWebFluxAgreeOnReactiveStreams() throws NoSuchMethodException {
    Handlers bean = new Handlers();
    for (String streaming : List.of("serverSentEvents", "ndjson", "streamJson", "eventStream")) {
      HandlerMethod method = handler(bean, streaming);
      assertThat(ServletHandlerMethodSource.isStreamingHandler(method)).as("mvc " + streaming).isTrue();
      assertThat(ReactiveHandlerMethodSource.isStreamingHandler(method)).as("flux " + streaming).isTrue();
    }
    for (String buffered : List.of("collectedList", "plain")) {
      HandlerMethod method = handler(bean, buffered);
      assertThat(ServletHandlerMethodSource.isStreamingHandler(method)).as("mvc " + buffered).isFalse();
      assertThat(ReactiveHandlerMethodSource.isStreamingHandler(method)).as("flux " + buffered).isFalse();
    }
  }

  @Test
  void webMvcStillRecognisesItsEmitters() throws NoSuchMethodException {
    assertThat(ServletHandlerMethodSource.isStreamingHandler(handler(new MvcOnly(), "emitter")))
        .isTrue();
  }
}
