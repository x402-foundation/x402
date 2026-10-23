package org.x402.spring.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.x402.spring.TestBinding;
import org.x402.spring.X402ConfigurationException;
import org.x402.spring.annotation.X402Payment;
import org.x402.spring.offer.HandlerMethodSource;
import org.x402.spring.offer.OfferRegistry;
import org.x402.spring.offer.OfferResolver;
import org.x402.spring.offer.X402Offers;
import org.x402.spring.web.reactive.ReactiveHandlerMethodSource;
import org.x402.spring.web.servlet.ServletHandlerMethodSource;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Wrappers (ResponseEntity, Mono, CompletableFuture, Callable) do not hide a streaming body. */
class StreamingUnwrapTest {

  @SuppressWarnings("unused")
  static class Handlers {
    @X402Payment("weather")
    @GetMapping("/entity-flux")
    ResponseEntity<Flux<ServerSentEvent<String>>> entityFlux() {
      return null;
    }

    @X402Payment("weather")
    @GetMapping("/entity-sse")
    ResponseEntity<SseEmitter> entitySse() {
      return null;
    }

    @X402Payment("weather")
    @GetMapping("/mono-entity-flux")
    Mono<ResponseEntity<Flux<ServerSentEvent<String>>>> monoEntityFlux() {
      return null;
    }

    @X402Payment("weather")
    @GetMapping("/future-sse")
    CompletableFuture<SseEmitter> futureSse() {
      return null;
    }

    @X402Payment("weather")
    @GetMapping("/callable-entity-sse")
    Callable<ResponseEntity<SseEmitter>> callableEntitySse() {
      return null;
    }

    @X402Payment("weather")
    @GetMapping("/entity-string")
    ResponseEntity<String> entityString() {
      return null;
    }

    @X402Payment("weather")
    @GetMapping("/mono-string")
    Mono<String> monoString() {
      return null;
    }
  }

  private static HandlerMethod handler(String name) throws NoSuchMethodException {
    return new HandlerMethod(new Handlers(), Handlers.class.getDeclaredMethod(name));
  }

  private static X402Offers offers() {
    TestBinding.Bound bound = TestBinding.bind(
        "x402.accounts.net.network", "test:net",
        "x402.accounts.net.pay-to", "addr",
        "x402.routes.weather.accepts[0].account", "net",
        "x402.routes.weather.accepts[0].price", "$0.01");
    return OfferResolver.builder(bound.properties()).presence(bound.present())
        .facilitators(List.of("https://f")).build().resolve();
  }

  private static HandlerMethodSource source(String method, boolean servlet)
      throws NoSuchMethodException {
    HandlerMethod handler = handler(method);
    List<HandlerMethodSource.Mapping> mappings = new ArrayList<>();
    mappings.add(new HandlerMethodSource.Mapping(handler, Set.of("/x"), Set.of("GET")));
    return new HandlerMethodSource() {
      @Override
      public List<Mapping> mappings() {
        return mappings;
      }

      @Override
      public boolean isStreaming(HandlerMethod h) {
        return servlet ? ServletHandlerMethodSource.isStreamingHandler(h)
            : ReactiveHandlerMethodSource.isStreamingHandler(h);
      }
    };
  }

  @Test
  void wrappedReactiveStreamsFailStartupOnBothStacks() throws NoSuchMethodException {
    for (String method : List.of("entityFlux", "monoEntityFlux")) {
      for (boolean servlet : List.of(true, false)) {
        assertThatThrownBy(() -> new OfferRegistry(source(method, servlet), offers(), o -> true))
            .as(method + (servlet ? " mvc" : " flux"))
            .isInstanceOf(X402ConfigurationException.class)
            .hasMessageContaining("streaming");
      }
    }
  }

  @Test
  void wrappedEmittersFailStartupOnWebMvc() throws NoSuchMethodException {
    for (String method : List.of("entitySse", "futureSse", "callableEntitySse")) {
      assertThatThrownBy(() -> new OfferRegistry(source(method, true), offers(), o -> true))
          .as(method).isInstanceOf(X402ConfigurationException.class)
          .hasMessageContaining("streaming");
    }
  }

  @Test
  void wrappedBufferedBodiesStayAllowed() throws NoSuchMethodException {
    for (String method : List.of("entityString", "monoString")) {
      assertThat(ServletHandlerMethodSource.isStreamingHandler(handler(method))).as(method)
          .isFalse();
      assertThat(ReactiveHandlerMethodSource.isStreamingHandler(handler(method))).as(method)
          .isFalse();
    }
  }
}
