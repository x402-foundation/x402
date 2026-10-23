package org.x402.spring.offer;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.method.HandlerMethod;
import org.x402.spring.TestBinding;
import org.x402.spring.annotation.X402Payment;
import org.x402.spring.web.servlet.ServletHandlerMethodSource;

/**
 * Offers are keyed by (handler bean type, method): an inherited handler method served by two
 * controllers is priced per controller, never for both.
 */
class OfferRegistryHandlerKeyTest {

  @SuppressWarnings("unused")
  static class Base {
    @GetMapping("/report")
    String report() {
      return "";
    }
  }

  @X402Payment("weather")
  @RequestMapping("/premium")
  static class Premium extends Base {}

  @RequestMapping("/free")
  static class Free extends Base {}

  @X402Payment("report")
  @RequestMapping("/other")
  static class Other extends Base {}

  private static X402Offers offers() {
    TestBinding.Bound bound = TestBinding.bind(
        "x402.accounts.net.network", "test:net",
        "x402.accounts.net.pay-to", "addr",
        "x402.routes.weather.accepts[0].account", "net",
        "x402.routes.weather.accepts[0].price", "$0.01",
        "x402.routes.report.accepts[0].account", "net",
        "x402.routes.report.accepts[0].price", "$0.50");
    return OfferResolver.builder(bound.properties()).presence(bound.present())
        .facilitators(List.of("https://f")).build().resolve();
  }

  private static HandlerMethod handler(Object bean, String prefix, List<HandlerMethodSource.Mapping> out)
      throws NoSuchMethodException {
    Method method = Base.class.getDeclaredMethod("report");
    HandlerMethod handler = new HandlerMethod(bean, method);
    out.add(new HandlerMethodSource.Mapping(handler, Set.of(prefix + "/report"), Set.of("GET")));
    return handler;
  }

  private static HandlerMethodSource source(List<HandlerMethodSource.Mapping> mappings) {
    return new HandlerMethodSource() {
      @Override
      public List<Mapping> mappings() {
        return mappings;
      }

      @Override
      public boolean isStreaming(HandlerMethod handlerMethod) {
        return ServletHandlerMethodSource.isStreamingHandler(handlerMethod);
      }
    };
  }

  @Test
  void anInheritedHandlerIsPaidOnlyOnTheAnnotatedSubclass() throws Exception {
    List<HandlerMethodSource.Mapping> mappings = new ArrayList<>();
    HandlerMethod premium = handler(new Premium(), "/premium", mappings);
    HandlerMethod free = handler(new Free(), "/free", mappings);

    OfferRegistry registry = new OfferRegistry(source(mappings), offers(), offer -> false);

    assertThat(registry.offerFor(premium)).isEqualTo("weather");
    assertThat(registry.offerFor(free)).isNull();
  }

  @Test
  void twoSubclassesOfOneBaseKeepTheirOwnOffers() throws Exception {
    List<HandlerMethodSource.Mapping> mappings = new ArrayList<>();
    HandlerMethod premium = handler(new Premium(), "/premium", mappings);
    HandlerMethod other = handler(new Other(), "/other", mappings);

    OfferRegistry registry = new OfferRegistry(source(mappings), offers(), offer -> false);

    assertThat(registry.offerFor(premium)).isEqualTo("weather");
    assertThat(registry.offerFor(other)).isEqualTo("report");
  }
}
