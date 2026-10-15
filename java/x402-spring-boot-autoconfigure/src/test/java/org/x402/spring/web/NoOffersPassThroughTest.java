package org.x402.spring.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.reactive.HandlerMapping;
import org.x402.spring.offer.HandlerMethodSource;
import org.x402.spring.offer.OfferRegistry;
import org.x402.spring.offer.X402Offers;
import org.x402.spring.web.reactive.X402WebFilter;
import org.x402.spring.web.servlet.X402ServletFilter;
import reactor.core.publisher.Mono;

/** With no offers configured, the x402 filters pass every request on without looking it up. */
class NoOffersPassThroughTest {

  private static OfferRegistry emptyRegistry() {
    HandlerMethodSource none = new HandlerMethodSource() {
      @Override
      public List<Mapping> mappings() {
        return List.of();
      }

      @Override
      public boolean isStreaming(HandlerMethod handler) {
        return false;
      }
    };
    return new OfferRegistry(none, new X402Offers(Map.of(), List.of()), offer -> false);
  }

  @Test
  void theServletFilterDoesNoHandlerLookup() throws Exception {
    AtomicInteger lookups = new AtomicInteger();
    Supplier<List<org.springframework.web.servlet.HandlerMapping>> mappings = () -> {
      lookups.incrementAndGet();
      return List.of();
    };
    OfferRegistry registry = emptyRegistry();
    X402ServletFilter filter = new X402ServletFilter(() -> null, () -> registry, () -> {
      throw new AssertionError("path offers consulted");
    }, mappings, null, false);
    MockFilterChain chain = new MockFilterChain();

    filter.doFilter(new MockHttpServletRequest("GET", "/anything"), new MockHttpServletResponse(),
        chain);

    assertThat(lookups).hasValue(0);
    assertThat(chain.getRequest()).isNotNull();
  }

  @Test
  void theWebFilterDoesNoHandlerLookup() {
    AtomicInteger lookups = new AtomicInteger();
    Supplier<List<HandlerMapping>> mappings = () -> {
      lookups.incrementAndGet();
      return List.of();
    };
    X402WebFilter filter = new X402WebFilter(null, emptyRegistry(), null, mappings, null, false, 0);
    AtomicInteger passed = new AtomicInteger();

    filter.filter(MockServerWebExchange.from(MockServerHttpRequest.get("/anything")), exchange -> {
      passed.incrementAndGet();
      return Mono.empty();
    }).block();

    assertThat(lookups).hasValue(0);
    assertThat(passed).hasValue(1);
  }
}
