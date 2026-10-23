package org.x402.spring.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.boot.http.client.ClientHttpRequestFactoryBuilder;
import org.springframework.boot.http.client.ClientHttpRequestFactorySettings;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.client.ClientHttpRequest;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.mock.http.client.MockClientHttpRequest;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestTemplate;
import org.x402.core.client.X402Client;
import org.x402.core.client.X402ClientException;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.SettleResponse;
import org.x402.http.HeaderCodec;
import org.x402.http.HostPolicy;
import org.x402.http.X402Headers;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestClientScheme;
import org.x402.spring.client.servlet.X402ClientBeanPostProcessor;
import org.x402.spring.client.servlet.X402ClientHttpRequestFactory;
import org.x402.spring.client.servlet.X402ClientHttpRequestFactoryBuilderPostProcessor;
import org.x402.spring.client.servlet.X402ClientHttpRequestFactoryDecorator;

/** Edge paths of the blocking payment factory and its post-processors. */
class ClientFactoryEdgeTest {

  private static final HostPolicy ANY_EXAMPLE = HostPolicy.of(List.of("api.example.com"));
  private static final URI URL = URI.create("https://api.example.com/x");

  private final TestClientScheme scheme = new TestClientScheme();
  private final X402Client client = new X402Client().register(HookRecorder.NET, scheme);

  /** What the fake transport saw. */
  record Sent(HttpMethod method, HttpHeaders headers, byte[] body) {}

  private static String required(String resource) {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(resource), List.of(new PaymentRequirements("exact", HookRecorder.NET,
            "USDM", "10000", "addr", 300, Map.of())), null));
  }

  private static ClientHttpRequestFactory fake(List<Sent> sent,
      Function<HttpHeaders, ClientHttpResponse> answer) {
    return (uri, method) -> new MockClientHttpRequest(method, uri) {
      @Override
      protected ClientHttpResponse executeInternal() {
        sent.add(new Sent(method, getHeaders(), getBodyAsBytes()));
        return answer.apply(getHeaders());
      }
    };
  }

  private static ClientHttpResponse response(HttpStatusCode status, Map<String, String> headers) {
    return new X402ClientStarterTest.RecordingResponse(status, headers, () -> { });
  }

  private static ClientHttpResponse send(ClientHttpRequestFactory factory, HttpMethod method,
      String body, String... headers) throws IOException {
    ClientHttpRequest request = factory.createRequest(URL, method);
    for (int i = 0; i < headers.length; i += 2) {
      request.getHeaders().add(headers[i], headers[i + 1]);
    }
    if (body != null) {
      request.getBody().write(body.getBytes(StandardCharsets.UTF_8));
    }
    return request.execute();
  }

  @Test
  void aBodyIsReplayedOnThePaidRetryAndNon402PassesThrough() throws IOException {
    List<Sent> sent = new ArrayList<>();
    ClientHttpRequestFactory factory = X402ClientHttpRequestFactory.wrap(fake(sent, h ->
        h.containsKey(X402Headers.PAYMENT_SIGNATURE) ? response(HttpStatus.OK, Map.of())
            : response(HttpStatus.PAYMENT_REQUIRED, Map.of(X402Headers.PAYMENT_REQUIRED,
                required(URL.toString())))), client, ANY_EXAMPLE);

    try (ClientHttpResponse r = send(factory, HttpMethod.POST, "{\"q\":1}")) {
      assertThat(r.getStatusCode().value()).isEqualTo(200);
    }
    assertThat(sent).hasSize(2);
    assertThat(new String(sent.get(1).body(), StandardCharsets.UTF_8)).isEqualTo("{\"q\":1}");
    assertThat(sent.get(1).method()).isEqualTo(HttpMethod.POST);

    ClientHttpRequestFactory ok = X402ClientHttpRequestFactory.wrap(
        fake(new ArrayList<>(), h -> response(HttpStatus.OK, Map.of())), client, ANY_EXAMPLE);
    assertThat(send(ok, HttpMethod.GET, null).getStatusCode().value()).isEqualTo(200);
  }

  @Test
  void a402WithoutPaymentRequiredIsReturnedUnchanged() throws IOException {
    ClientHttpRequestFactory factory = X402ClientHttpRequestFactory.wrap(fake(new ArrayList<>(),
        h -> response(HttpStatus.PAYMENT_REQUIRED, Map.of())), client, ANY_EXAMPLE);
    assertThat(send(factory, HttpMethod.GET, null).getStatusCode().value()).isEqualTo(402);
    assertThat(scheme.signed).isEmpty();
  }

  @Test
  void aMalformedHeaderOrAnAlreadyPaidRequestThrows() {
    ClientHttpRequestFactory malformed = X402ClientHttpRequestFactory.wrap(
        fake(new ArrayList<>(), h -> response(HttpStatus.PAYMENT_REQUIRED,
            Map.of(X402Headers.PAYMENT_REQUIRED, "%%%"))), client, ANY_EXAMPLE);
    assertThatThrownBy(() -> send(malformed, HttpMethod.GET, null))
        .isInstanceOf(X402ClientException.class)
        .hasMessageContaining("Failed to parse payment requirements");

    ClientHttpRequestFactory again = X402ClientHttpRequestFactory.wrap(
        fake(new ArrayList<>(), h -> response(HttpStatus.PAYMENT_REQUIRED,
            Map.of(X402Headers.PAYMENT_REQUIRED, required(URL.toString())))), client, ANY_EXAMPLE);
    assertThatThrownBy(() -> send(again, HttpMethod.GET, null, X402Headers.PAYMENT_SIGNATURE,
        "x"))
        .isInstanceOf(X402ClientException.class).hasMessageContaining("already attempted");
  }

  @Test
  void anUnparsableResourceUrlIsNotPaid() throws IOException {
    ClientHttpRequestFactory factory = X402ClientHttpRequestFactory.wrap(fake(new ArrayList<>(),
        h -> response(HttpStatus.PAYMENT_REQUIRED, Map.of(X402Headers.PAYMENT_REQUIRED,
            required("not a uri")))), client, ANY_EXAMPLE);
    assertThat(send(factory, HttpMethod.GET, null).getStatusCode().value()).isEqualTo(402);
    assertThat(scheme.signed).isEmpty();
  }

  @Test
  void aPaymentResponseHookMayRecoverOnceWithAFreshPayment() throws IOException {
    AtomicInteger hooks = new AtomicInteger();
    client.onPaymentResponse(ctx -> hooks.incrementAndGet() == 1);
    List<Sent> sent = new ArrayList<>();
    String receipt = HeaderCodec.encodePaymentResponse(
        SettleResponse.failure("expired", "expired", "", HookRecorder.NET));
    ClientHttpRequestFactory factory = X402ClientHttpRequestFactory.wrap(fake(sent, h ->
        h.containsKey(X402Headers.PAYMENT_SIGNATURE)
            ? response(HttpStatus.PAYMENT_REQUIRED, sent.size() == 2
                ? Map.of(X402Headers.PAYMENT_REQUIRED, required(URL.toString()))
                : Map.of(X402Headers.PAYMENT_RESPONSE, receipt))
            : response(HttpStatus.PAYMENT_REQUIRED, Map.of(X402Headers.PAYMENT_REQUIRED,
                required(URL.toString())))), client, ANY_EXAMPLE);

    send(factory, HttpMethod.GET, null).close();

    assertThat(sent).hasSize(3);
    assertThat(hooks.get()).isEqualTo(2);
    assertThat(scheme.signed).hasSize(2);
  }

  @Test
  void malformedReceiptsAreIgnoredByTheResponseHooks() throws IOException {
    List<Object> seen = new ArrayList<>();
    client.onPaymentResponse(ctx -> {
      seen.add(ctx.settleResponse() == null ? "none" : "receipt");
      seen.add(ctx.paymentRequired() == null ? "none" : "required");
      return false;
    });
    ClientHttpRequestFactory factory = X402ClientHttpRequestFactory.wrap(fake(new ArrayList<>(),
        h -> h.containsKey(X402Headers.PAYMENT_SIGNATURE)
            ? response(HttpStatus.PAYMENT_REQUIRED, Map.of(X402Headers.PAYMENT_RESPONSE, "%%",
                X402Headers.PAYMENT_REQUIRED, "%%"))
            : response(HttpStatus.PAYMENT_REQUIRED, Map.of(X402Headers.PAYMENT_REQUIRED,
                required(URL.toString())))), client, ANY_EXAMPLE);
    send(factory, HttpMethod.GET, null).close();
    assertThat(seen).containsExactly("none", "none");
  }

  @Test
  void accessorsAndIdempotentDecoration() {
    SimpleClientHttpRequestFactory transport = new SimpleClientHttpRequestFactory();
    X402ClientHttpRequestFactory wrapped = (X402ClientHttpRequestFactory)
        X402ClientHttpRequestFactory.wrap(transport, client, ANY_EXAMPLE);
    assertThat(wrapped.delegate()).isSameAs(transport);
    assertThat(wrapped.hostPolicy()).isSameAs(ANY_EXAMPLE);
    X402ClientHttpRequestFactoryDecorator decorator =
        new X402ClientHttpRequestFactoryDecorator(client, ANY_EXAMPLE);
    assertThat(decorator.decorate(wrapped)).isSameAs(wrapped);
  }

  @Test
  void theBuilderPostProcessorDelegatesAndKeepsCustomizers() {
    StaticListableBeanFactory beans = new StaticListableBeanFactory();
    beans.addBean("x402Decorator", new X402ClientHttpRequestFactoryDecorator(client,
        ANY_EXAMPLE));
    X402ClientHttpRequestFactoryBuilderPostProcessor processor =
        new X402ClientHttpRequestFactoryBuilderPostProcessor(
            beans.getBeanProvider(X402ClientHttpRequestFactoryDecorator.class));
    Object wrapped = processor.postProcessAfterInitialization(
        ClientHttpRequestFactoryBuilder.simple(), "builder");
    assertThat(processor.postProcessAfterInitialization(wrapped, "builder")).isSameAs(wrapped);
    assertThat(processor.postProcessAfterInitialization("other", "x")).isEqualTo("other");

    @SuppressWarnings("unchecked")
    ClientHttpRequestFactoryBuilder<ClientHttpRequestFactory> builder =
        (ClientHttpRequestFactoryBuilder<ClientHttpRequestFactory>) wrapped;
    AtomicInteger customized = new AtomicInteger();
    ClientHttpRequestFactory built = builder.withCustomizer(f -> customized.incrementAndGet())
        .build(ClientHttpRequestFactorySettings.defaults());
    assertThat(built).isInstanceOf(X402ClientHttpRequestFactory.class);
    assertThat(((X402ClientHttpRequestFactory) built).delegate())
        .isInstanceOf(SimpleClientHttpRequestFactory.class);
    // the transport and its non-redirecting twin for paid requests
    assertThat(customized.get()).isEqualTo(2);
    assertThat(((X402ClientHttpRequestFactory) built).paidDelegate())
        .isNotSameAs(((X402ClientHttpRequestFactory) built).delegate());
  }

  @Test
  void theBeanPostProcessorRecognisesMarkedAndDecoratedClients() {
    X402ClientBeanPostProcessor processor = new X402ClientBeanPostProcessor();
    RestTemplate marked = new RestTemplate();
    X402ClientBeanPostProcessor.restTemplateMarker().customize(marked);
    X402ClientBeanPostProcessor.restTemplateMarker().customize(marked);
    assertThat(marked.getClientHttpRequestInitializers()).hasSize(1);
    RestTemplate decorated = new RestTemplate(X402ClientHttpRequestFactory.wrap(
        new SimpleClientHttpRequestFactory(), client, ANY_EXAMPLE));
    RestClient.Builder builder = RestClient.builder();
    X402ClientBeanPostProcessor.restClientMarker().customize(builder);
    for (Object bean : List.of(marked, decorated, builder.build(), "plain")) {
      assertThat(processor.postProcessAfterInitialization(bean, "b")).isSameAs(bean);
    }
  }
}
