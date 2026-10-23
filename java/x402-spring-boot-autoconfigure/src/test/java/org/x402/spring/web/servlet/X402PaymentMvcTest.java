package org.x402.spring.web.servlet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.http.HttpResponse;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.x402.http.X402Headers;
import org.x402.spring.ContractApp;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestHttp;
import org.x402.spring.X402StarterContract;
import org.x402.spring.annotation.X402Payment;

/** The starter contract on WebMvc (Tomcat), plus the servlet-only async and emitter cases. */
@SpringBootTest(classes = X402PaymentMvcTest.MvcApp.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "spring.main.web-application-type=servlet")
class X402PaymentMvcTest extends X402StarterContract {

  @LocalServerPort
  int port;

  @Autowired
  HookRecorder recorder;

  /** Servlet-only async handlers. */
  @RestController
  static class AsyncController {

    @X402Payment("weather")
    @GetMapping("/async/callable")
    Callable<String> callable() {
      return () -> "callable";
    }

    @X402Payment("weather")
    @GetMapping("/async/deferred")
    DeferredResult<String> deferred() {
      DeferredResult<String> result = new DeferredResult<>();
      CompletableFuture.runAsync(() -> result.setResult("deferred"),
          CompletableFuture.delayedExecutor(50, TimeUnit.MILLISECONDS));
      return result;
    }

    @X402Payment("weather")
    @GetMapping("/async/timeout")
    DeferredResult<String> timeout() {
      return new DeferredResult<>(100L);
    }

    @X402Payment("weather")
    @GetMapping("/async/throw")
    Callable<String> asyncThrow() {
      return () -> {
        throw new IllegalStateException("async handler exploded");
      };
    }
  }

  /** Only loaded by the emitter variant. */
  @RestController
  static class EmitterController {
    @X402Payment("weather")
    @GetMapping("/sse")
    SseEmitter sse() {
      return new SseEmitter();
    }
  }

  /** Tomcat passes {@code %2F} through so the encoded-slash case reaches Spring. */
  @Configuration(proxyBeanMethods = false)
  static class EncodedSlashes {
    @Bean
    WebServerFactoryCustomizer<TomcatServletWebServerFactory> passEncodedSlashes() {
      return factory -> factory.addConnectorCustomizers(
          connector -> connector.setEncodedSolidusHandling("passthrough"));
    }
  }

  @SpringBootConfiguration
  @EnableAutoConfiguration
  @Import({ContractApp.class, AsyncController.class, EncodedSlashes.class})
  static class MvcApp {}

  /** Every request needs authentication. */
  @Configuration(proxyBeanMethods = false)
  @EnableWebSecurity
  static class Secured {
    @Bean
    SecurityFilterChain everythingAuthenticated(HttpSecurity http) throws Exception {
      return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
          .httpBasic(Customizer.withDefaults()).build();
    }
  }

  @Override
  protected int port() {
    return port;
  }

  @Override
  protected HookRecorder recorder() {
    return recorder;
  }

  @Override
  protected ConfigurableApplicationContext startVariant(Map<String, Object> overrides,
      Class<?>... extra) {
    Map<String, Object> props = new LinkedHashMap<>(contractProperties());
    props.put("server.port", "0");
    props.put("spring.main.web-application-type", "servlet");
    props.putAll(overrides);
    Class<?>[] sources = new Class<?>[extra.length + 1];
    sources[0] = MvcApp.class;
    System.arraycopy(extra, 0, sources, 1, extra.length);
    return new SpringApplicationBuilder(sources).properties(props).run();
  }

  @Override
  protected Class<?> securityConfiguration() {
    return Secured.class;
  }

  @Override
  protected String contextPathProperty() {
    return "server.servlet.context-path";
  }

  private String url(String path) {
    return "http://127.0.0.1:" + port + path;
  }

  private HttpResponse<String> paidGet(String path) {
    HttpResponse<String> unpaid = TestHttp.get(url(path));
    assertThat(unpaid.statusCode()).isEqualTo(402);
    return TestHttp.get(url(path), X402Headers.PAYMENT_SIGNATURE, TestHttp.pay(unpaid, 0, null));
  }

  @Test
  void callableHandlerSettlesExactlyOnceOnTheFinalDispatch() {
    HttpResponse<String> response = paidGet("/async/callable");

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).isEqualTo("callable");
    assertThat(TestHttp.settlement(response)).isNotNull();
    assertThat(FACILITATOR.count("settle")).isEqualTo(1);
    assertThat(recorder.canceled.get()).isZero();
  }

  @Test
  void deferredResultSettlesExactlyOnce() {
    HttpResponse<String> response = paidGet("/async/deferred");

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).isEqualTo("deferred");
    assertThat(TestHttp.settlement(response)).isNotNull();
    assertThat(FACILITATOR.count("settle")).isEqualTo(1);
  }

  @Test
  void deferredResultTimeoutIsNotSettled() {
    HttpResponse<String> response = paidGet("/async/timeout");

    assertThat(response.statusCode()).isEqualTo(503);
    assertThat(FACILITATOR.count("settle")).isZero();
    assertThat(recorder.canceled.get()).isEqualTo(1);
  }

  @Test
  void anExceptionAfterAsyncStartIsNotSettled() {
    HttpResponse<String> response = paidGet("/async/throw");

    assertThat(response.statusCode()).isEqualTo(500);
    assertThat(FACILITATOR.count("settle")).isZero();
    assertThat(recorder.canceled.get()).isEqualTo(1);
  }

  @Test
  void paidEmitterHandlersAreRejectedAtStartup() {
    assertThatThrownBy(() -> startVariant(Map.of(), EmitterController.class).close())
        .hasStackTraceContaining("stream");
  }
}
