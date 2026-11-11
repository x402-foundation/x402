package org.x402.spring.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.concurrent.CompletionStage;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.context.request.async.DeferredResult;
import org.springframework.web.context.request.async.WebAsyncTask;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import org.x402.spring.web.servlet.ServletHandlerMethodSource;

/**
 * Every single-value async wrapper Spring MVC unwraps before writing the body is peeled before
 * the streaming check: {@code CompletionStage}, {@code DeferredResult} and {@code WebAsyncTask}.
 */
class StreamingAsyncWrappersTest {

  @SuppressWarnings("unused")
  static class Handlers {
    @GetMapping("/stage")
    CompletionStage<SseEmitter> stage() {
      return null;
    }

    @GetMapping("/deferred")
    DeferredResult<StreamingResponseBody> deferred() {
      return null;
    }

    @GetMapping("/task")
    WebAsyncTask<SseEmitter> task() {
      return null;
    }

    @GetMapping("/deferred-string")
    DeferredResult<String> deferredString() {
      return null;
    }
  }

  private static HandlerMethod handler(String name) throws NoSuchMethodException {
    return new HandlerMethod(new Handlers(), Handlers.class.getDeclaredMethod(name));
  }

  @Test
  void anEmitterBehindAnAsyncWrapperIsStreaming() throws NoSuchMethodException {
    for (String method : List.of("stage", "deferred", "task")) {
      assertThat(ServletHandlerMethodSource.isStreamingHandler(handler(method))).as(method)
          .isTrue();
    }
  }

  @Test
  void aBufferedBodyBehindAnAsyncWrapperIsNot() throws NoSuchMethodException {
    assertThat(ServletHandlerMethodSource.isStreamingHandler(handler("deferredString"))).isFalse();
  }
}
