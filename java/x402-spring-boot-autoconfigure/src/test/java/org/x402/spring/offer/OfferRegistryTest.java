package org.x402.spring.offer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import org.x402.spring.TestBinding;
import org.x402.spring.X402ConfigurationException;
import org.x402.spring.annotation.X402Payment;
import org.x402.spring.web.servlet.ServletHandlerMethodSource;

/** The stack-neutral handler → offer registry. */
class OfferRegistryTest {

  @X402Payment("weather")
  static class ClassLevel {
    @GetMapping("/class/inherits")
    String inherits() {
      return "";
    }

    @X402Payment("report")
    @GetMapping("/class/overrides")
    String overrides() {
      return "";
    }
  }

  static class Plain {
    @X402Payment("weather")
    @GetMapping("/weather")
    String weather() {
      return "";
    }

    @GetMapping("/free")
    String free() {
      return "";
    }

    @GetMapping("/report/{id}")
    String report() {
      return "";
    }
  }

  static class Unknown {
    @X402Payment("nope")
    @GetMapping("/nope")
    String nope() {
      return "";
    }
  }

  static class Streaming {
    @X402Payment("weather")
    @GetMapping("/sse")
    SseEmitter sse() {
      return null;
    }

    @X402Payment("weather")
    @GetMapping("/emitter")
    ResponseBodyEmitter emitter() {
      return null;
    }

    @X402Payment("weather")
    @GetMapping("/stream")
    StreamingResponseBody stream() {
      return null;
    }

    @X402Payment("weather")
    @GetMapping("/entity-stream")
    ResponseEntity<StreamingResponseBody> entityStream() {
      return null;
    }

    @X402Payment("weather")
    @GetMapping(path = "/events", produces = "text/event-stream")
    String events() {
      return "";
    }
  }

  private static X402Offers offers(String... extra) {
    List<String> kv = new ArrayList<>(List.of(
        "x402.accounts.net.network", "test:net",
        "x402.accounts.net.pay-to", "addr",
        "x402.routes.weather.accepts[0].account", "net",
        "x402.routes.weather.accepts[0].price", "$0.01",
        "x402.routes.report.accepts[0].account", "net",
        "x402.routes.report.accepts[0].price", "$0.50"));
    kv.addAll(List.of(extra));
    TestBinding.Bound bound = TestBinding.bind(kv.toArray(String[]::new));
    return OfferResolver.builder(bound.properties()).presence(bound.present())
        .facilitators(List.of("https://f")).build().resolve();
  }

  /** A source over the {@code @GetMapping} methods of some classes. */
  private static HandlerMethodSource source(Class<?>... types) {
    List<HandlerMethodSource.Mapping> mappings = new ArrayList<>();
    for (Class<?> type : types) {
      Object bean = instantiate(type);
      for (Method m : type.getDeclaredMethods()) {
        GetMapping get = m.getAnnotation(GetMapping.class);
        if (get != null) {
          Set<String> patterns = new LinkedHashSet<>(List.of(get.path().length > 0 ? get.path()
              : get.value()));
          mappings.add(new HandlerMethodSource.Mapping(new HandlerMethod(bean, m), patterns,
              Set.of("GET")));
        }
      }
    }
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

  private static Object instantiate(Class<?> type) {
    try {
      var ctor = type.getDeclaredConstructor();
      ctor.setAccessible(true);
      return ctor.newInstance();
    } catch (ReflectiveOperationException e) {
      throw new IllegalStateException(e);
    }
  }

  private static HandlerMethod handler(HandlerMethodSource source, String path) {
    return source.mappings().stream().filter(m -> m.patterns().contains(path)).findFirst()
        .orElseThrow().handlerMethod();
  }

  @Test
  void classLevelAppliesToEveryMethodAndMethodLevelOverrides() {
    HandlerMethodSource source = source(ClassLevel.class, Plain.class);
    OfferRegistry registry = new OfferRegistry(source, offers(), offer -> true);

    assertThat(registry.offerFor(handler(source, "/class/inherits"))).isEqualTo("weather");
    assertThat(registry.offerFor(handler(source, "/class/overrides"))).isEqualTo("report");
    assertThat(registry.offerFor(handler(source, "/weather"))).isEqualTo("weather");
    assertThat(registry.offerFor(handler(source, "/free"))).isNull();
    assertThat(registry.offerFor("not a handler method")).isNull();
    assertThat(registry.offerFor(null)).isNull();
  }

  @Test
  void unknownOfferFailsStartupListingTheKnownOffers() {
    assertThatThrownBy(() -> new OfferRegistry(source(Unknown.class), offers(), offer -> true))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("@X402Payment(\"nope\")")
        .hasMessageContaining("weather")
        .hasMessageContaining("report");
  }

  @Test
  void offerWithoutPathOrAnnotationWarns() {
    OfferRegistry registry = new OfferRegistry(source(Plain.class), offers(), offer -> true);
    assertThat(registry.warnings()).anyMatch(w -> w.contains("\"report\"")
        && w.contains("neither a path nor an @X402Payment"));
    assertThat(registry.warnings()).noneMatch(w -> w.contains("\"weather\"")
        && w.contains("neither a path nor an @X402Payment"));
  }

  @Test
  void bracesInPathFailStartup() {
    assertThatThrownBy(() -> new OfferRegistry(source(Plain.class),
        offers("x402.routes.report.path", "GET /report/{id}"), offer -> true))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("\"report\"")
        .hasMessageContaining("{");
  }

  @Test
  void pathMatchingNoHandlerWarns() {
    OfferRegistry registry = new OfferRegistry(source(Plain.class),
        offers("x402.routes.report.path", "GET /nowhere/*"), offer -> true);
    assertThat(registry.warnings()).anyMatch(w -> w.contains("\"report\"")
        && w.contains("matches no registered handler"));

    OfferRegistry matching = new OfferRegistry(source(Plain.class),
        offers("x402.routes.report.path", "GET /report/*"), offer -> true);
    assertThat(matching.warnings()).noneMatch(w -> w.contains("matches no registered handler"));
  }

  @Test
  void annotationAndPathOverlapIsLoggedOnce() {
    OfferRegistry registry = new OfferRegistry(source(Plain.class),
        offers("x402.routes.report.path", "/weather"), offer -> true);
    assertThat(registry.warnings().stream().filter(w -> w.contains("overlap"))).hasSize(1);
    assertThat(registry.warnings()).anyMatch(w -> w.contains("overlap")
        && w.contains("\"report\"") && w.contains("\"weather\""));
  }

  @Test
  void streamingHandlersAreRefusedForAuthorizationFlows() {
    HandlerMethodSource source = source(Streaming.class);
    for (String path : List.of("/sse", "/emitter", "/stream", "/entity-stream", "/events")) {
      assertThat(source.isStreaming(handler(source, path))).as(path).isTrue();
    }
    assertThatThrownBy(() -> new OfferRegistry(source, offers(), offer -> true))
        .isInstanceOf(X402ConfigurationException.class)
        .hasMessageContaining("stream");

    OfferRegistry upfront = new OfferRegistry(source, offers(), offer -> false);
    assertThat(upfront.offerFor(handler(source, "/sse"))).isEqualTo("weather");
  }

  @Test
  void plainHandlersAreNotStreaming() {
    HandlerMethodSource source = source(Plain.class);
    assertThat(source.isStreaming(handler(source, "/weather"))).isFalse();
  }

  @Test
  void offersUsedByAnnotationsAreListed() {
    OfferRegistry registry = new OfferRegistry(source(Plain.class), offers(), offer -> true);
    assertThat(registry.annotatedOffers()).containsExactly("weather");
  }
}
