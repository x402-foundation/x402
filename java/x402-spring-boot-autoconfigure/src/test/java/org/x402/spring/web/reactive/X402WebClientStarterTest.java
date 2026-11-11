package org.x402.spring.web.reactive;

import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.anyRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.anyUrl;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.matching;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;
import com.github.tomakehurst.wiremock.matching.RequestPatternBuilder;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;
import org.x402.core.SchemeNetworkClient;
import org.x402.core.client.X402ClientException;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.http.HeaderCodec;
import org.x402.http.X402Headers;
import org.x402.spring.HookRecorder;
import org.x402.spring.X402ClientCustomizer;
import org.x402.spring.client.reactive.X402ExchangeFilterFunction;
import reactor.core.publisher.Flux;
import reactor.netty.http.client.HttpClient;

/**
 * WebClient payments: Boot's builder, self-built beans, the host allowlist, bounded body
 * replay, signing off the event loop, and no redirect of a paid request.
 */
@ExtendWith(OutputCaptureExtension.class)
class X402WebClientStarterTest {

  private static WireMockServer api;
  private static WireMockServer elsewhere;
  private ConfigurableApplicationContext context;

  /** Records which thread signs. */
  static final class ThreadRecordingScheme implements SchemeNetworkClient {
    final List<String> threads = new CopyOnWriteArrayList<>();

    @Override
    public String scheme() {
      return "exact";
    }

    @Override
    public PaymentPayloadResult createPaymentPayload(int x402Version,
        PaymentRequirements requirements, PaymentPayloadContext context) {
      threads.add(Thread.currentThread().getName());
      return new PaymentPayloadResult(x402Version, Map.of("signed", requirements.amount()), null);
    }

    @Override
    public DefaultAsset findDefaultAsset(String asset, String network) {
      return "USDM".equals(asset) ? new DefaultAsset("USDM", 6, "USDM") : null;
    }
  }

  @SpringBootConfiguration
  @EnableAutoConfiguration
  static class ClientApp {
    @Bean
    ThreadRecordingScheme threadRecordingScheme() {
      return new ThreadRecordingScheme();
    }

    @Bean
    X402ClientCustomizer testSchemes(ThreadRecordingScheme scheme) {
      return client -> client.register(HookRecorder.NET, scheme);
    }

    @Bean
    WebClient selfBuiltWebClient() {
      return WebClient.create();
    }

    @Bean
    WebClient followingSelfBuiltWebClient() {
      return WebClient.builder().clientConnector(new ReactorClientHttpConnector(
          HttpClient.create().followRedirect(true))).build();
    }

    @Bean
    WebClient bootBuiltWebClient(WebClient.Builder builder) {
      return builder.build();
    }
  }

  @BeforeAll
  static void startServers() {
    api = new WireMockServer(WireMockConfiguration.options().dynamicPort());
    elsewhere = new WireMockServer(WireMockConfiguration.options().dynamicPort());
    api.start();
    elsewhere.start();
  }

  @AfterAll
  static void stopServers() {
    api.stop();
    elsewhere.stop();
  }

  private static String header(String asset, String amount, String path) {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(api.baseUrl() + path), List.of(new PaymentRequirements("exact",
            HookRecorder.NET, asset, amount, "addr", 300, Map.of())), null));
  }

  @BeforeEach
  void stubs() {
    api.resetAll();
    elsewhere.resetAll();
    api.stubFor(get(urlEqualTo("/paid")).withHeader(X402Headers.PAYMENT_SIGNATURE, absent())
        .willReturn(aResponse().withStatus(402)
            .withHeader(X402Headers.PAYMENT_REQUIRED, header("USDM", "10000", "/paid"))));
    api.stubFor(get(urlEqualTo("/paid")).withHeader(X402Headers.PAYMENT_SIGNATURE, matching(".+"))
        .willReturn(aResponse().withStatus(200).withBody("paid")));
    api.stubFor(get(urlEqualTo("/over-cap")).willReturn(aResponse().withStatus(402)
        .withHeader(X402Headers.PAYMENT_REQUIRED, header("USDM", "2000000", "/over-cap"))));
    api.stubFor(post(urlEqualTo("/upload")).withHeader(X402Headers.PAYMENT_SIGNATURE, absent())
        .willReturn(aResponse().withStatus(402)
            .withHeader(X402Headers.PAYMENT_REQUIRED, header("USDM", "10000", "/upload"))));
    api.stubFor(post(urlEqualTo("/upload")).withHeader(X402Headers.PAYMENT_SIGNATURE,
        matching(".+")).willReturn(aResponse().withStatus(200).withBody("stored")));
    api.stubFor(get(urlEqualTo("/redirect")).withHeader(X402Headers.PAYMENT_SIGNATURE, absent())
        .willReturn(aResponse().withStatus(402)
            .withHeader(X402Headers.PAYMENT_REQUIRED, header("USDM", "10000", "/redirect"))));
    api.stubFor(get(urlEqualTo("/redirect"))
        .withHeader(X402Headers.PAYMENT_SIGNATURE, matching(".+"))
        .willReturn(aResponse().withStatus(302)
            .withHeader("Location", elsewhere.baseUrl() + "/landing")));
    elsewhere.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(200).withBody("stolen")));
  }

  @AfterEach
  void close() {
    if (context != null) {
      context.close();
    }
  }

  private void start(String... properties) {
    List<String> all = new ArrayList<>(List.of(
        "spring.main.web-application-type=none",
        "x402.client.enabled=true",
        "x402.client.hosts[0]=localhost"));
    all.addAll(List.of(properties));
    context = new SpringApplicationBuilder(ClientApp.class)
        .properties(all.toArray(String[]::new)).run();
  }

  private int paid(RequestPatternBuilder pattern) {
    return api.countRequestsMatching(pattern.withHeader(X402Headers.PAYMENT_SIGNATURE,
        matching(".+")).build()).getCount();
  }

  private WebClient boot() {
    return context.getBean(WebClient.Builder.class).build();
  }

  private ThreadRecordingScheme scheme() {
    return context.getBean(ThreadRecordingScheme.class);
  }

  @Test
  void aWebClientFromBootsBuilderPaysA402FromAnAllowedHostSigningOnBoundedElastic() {
    start();
    String body = boot().get().uri(api.baseUrl() + "/paid").retrieve().bodyToMono(String.class)
        .block();
    assertThat(body).isEqualTo("paid");
    assertThat(scheme().threads).hasSize(1);
    assertThat(scheme().threads.get(0)).startsWith("boundedElastic");
  }

  @Test
  void anOffListHostGetsThe402BackUnpaid() {
    start("x402.client.hosts[0]=api.example.com");
    assertThatThrownBy(() -> boot().get().uri(api.baseUrl() + "/paid").retrieve()
        .bodyToMono(String.class).block())
        .isInstanceOf(WebClientResponseException.class)
        .satisfies(e -> assertThat(((WebClientResponseException) e).getStatusCode().value())
            .isEqualTo(402));
    assertThat(paid(anyRequestedFor(anyUrl()))).isZero();
  }

  @Test
  void aSelfBuiltWebClientBeanPaysUnlessInstrumentationIsOff() {
    start();
    assertThat(context.getBean("selfBuiltWebClient", WebClient.class).get()
        .uri(api.baseUrl() + "/paid").retrieve().bodyToMono(String.class).block())
        .isEqualTo("paid");
    context.close();

    start("x402.client.instrument-beans=false");
    assertThatThrownBy(() -> context.getBean("selfBuiltWebClient", WebClient.class).get()
        .uri(api.baseUrl() + "/paid").retrieve().bodyToMono(String.class).block())
        .isInstanceOf(WebClientResponseException.class);
  }

  @Test
  void aBootBuiltWebClientExposedAsABeanIsInstrumentedOnce() {
    start();
    WebClient bean = context.getBean("bootBuiltWebClient", WebClient.class);
    List<Integer> count = new ArrayList<>();
    bean.mutate().filters(filters -> count.add((int) filters.stream()
        .filter(f -> f instanceof X402ExchangeFilterFunction).count()));
    assertThat(count).containsExactly(1);
    assertThat(bean.get().uri(api.baseUrl() + "/paid").retrieve().bodyToMono(String.class)
        .block()).isEqualTo("paid");
    assertThat(scheme().threads).hasSize(1);
  }

  @Test
  void anOverCapPriceIsRefused() {
    start();
    assertThatThrownBy(() -> boot().get().uri(api.baseUrl() + "/over-cap").retrieve()
        .bodyToMono(String.class).block())
        .hasRootCauseInstanceOf(X402ClientException.class);
    assertThat(paid(anyRequestedFor(anyUrl()))).isZero();
  }

  @Test
  void aSingleUseBodyIsRecordedDuringTheFirstSendAndReplayed() {
    start();
    AtomicBoolean used = new AtomicBoolean();
    Flux<String> once = Flux.defer(() -> used.compareAndSet(false, true)
        ? Flux.just("{\"q\":", "1}") : Flux.error(new IllegalStateException("single use")));
    String body = boot().post().uri(api.baseUrl() + "/upload")
        .header("Content-Type", "application/json").body(once, String.class).retrieve()
        .bodyToMono(String.class).block();
    assertThat(body).isEqualTo("stored");
    assertThat(api.findAll(postRequestedFor(urlEqualTo("/upload"))
        .withHeader(X402Headers.PAYMENT_SIGNATURE, matching(".+")))
        .get(0).getBodyAsString()).isEqualTo("{\"q\":1}");
  }

  @Test
  void aBodyLargerThanMaxReplayBodyGetsThe402BackUnpaid(CapturedOutput output) {
    start("x402.client.max-replay-body=4B");
    assertThatThrownBy(() -> boot().post().uri(api.baseUrl() + "/upload")
        .bodyValue("0123456789").retrieve().bodyToMono(String.class).block())
        .isInstanceOf(WebClientResponseException.class);
    assertThat(paid(postRequestedFor(urlEqualTo("/upload")))).isZero();
    assertThat(scheme().threads).isEmpty();
    assertThat(output.getOut() + output.getErr()).contains("max-replay-body");
  }

  @Test
  void aServletAppGetsTheWebClientFilterToo() {
    start("spring.main.web-application-type=servlet", "server.port=0");
    assertThat(boot().get().uri(api.baseUrl() + "/paid").retrieve().bodyToMono(String.class)
        .block()).isEqualTo("paid");
  }

  @Test
  void aBootBuiltWebClientNeverFollowsARedirectOfThePaidRequest() {
    start("spring.http.reactiveclient.redirects=follow");
    ResponseEntity<String> response = boot().get().uri(api.baseUrl() + "/redirect").retrieve()
        .toEntity(String.class).block();
    assertThat(response.getStatusCode().value()).isEqualTo(302);
    assertThat(elsewhere.countRequestsMatching(anyRequestedFor(anyUrl()).build()).getCount())
        .isZero();
  }

  @Test
  void aSelfBuiltRedirectFollowingConnectorNeverCarriesAPaidRequest() {
    start();
    WebClient following = context.getBean("followingSelfBuiltWebClient", WebClient.class);
    assertThatThrownBy(() -> following.get().uri(api.baseUrl() + "/redirect").retrieve()
        .toEntity(String.class).block())
        .hasRootCauseInstanceOf(X402ClientException.class)
        .rootCause().hasMessageContaining("redirect");
    assertThat(elsewhere.countRequestsMatching(anyRequestedFor(anyUrl()).build()).getCount())
        .isZero();
    assertThat(paid(anyRequestedFor(urlEqualTo("/redirect")))).isZero();
    assertThat(api.countRequestsMatching(anyRequestedFor(urlEqualTo("/redirect"))
        .withHeader(X402Headers.PAYMENT_SIGNATURE, absent()).build()).getCount()).isEqualTo(1);
  }
}
