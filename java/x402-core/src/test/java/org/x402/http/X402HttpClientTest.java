package org.x402.http;

import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.matching;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.options;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.PREPROD;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.stubbing.Scenario;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.x402.core.FakeClientScheme;
import org.x402.core.Fixtures;
import org.x402.core.client.X402Client;
import org.x402.core.client.X402ClientException;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.SettleResponse;

/** {@code X402HttpClient}: wrap, pay-and-retry, host policy, redirects and bounded replay bodies. */
class X402HttpClientTest {

  private final WireMockServer wm = new WireMockServer(options().dynamicPort());
  private final X402Client x402 = new X402Client().register(PREPROD, new FakeClientScheme());
  private final PaymentRequirements req = Fixtures.requirements();

  @BeforeEach
  void start() {
    wm.start();
  }

  @AfterEach
  void stop() {
    wm.stop();
  }

  private String required(String resourceUrl) {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(resourceUrl), List.of(req), null));
  }

  private void paywall(String path, String resourceHost) {
    wm.stubFor(get(urlEqualTo(path)).withHeader("PAYMENT-SIGNATURE", absent())
        .willReturn(aResponse().withStatus(402)
            .withHeader("PAYMENT-REQUIRED", required("http://" + resourceHost + path))
            .withBody("{}")));
    wm.stubFor(get(urlEqualTo(path)).withHeader("PAYMENT-SIGNATURE", matching(".+"))
        .willReturn(aResponse().withStatus(200)
            .withHeader("PAYMENT-RESPONSE", HeaderCodec.encodePaymentResponse(
                SettleResponse.success("tx", PREPROD, "p")))
            .withBody("content")));
  }

  private URI local(String path) {
    return URI.create("http://localhost:" + wm.port() + path);
  }

  private URI loopback(String path) {
    return URI.create("http://127.0.0.1:" + wm.port() + path);
  }

  private static HttpClient noRedirects() {
    return HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
  }

  @Test
  void wrapPaysOnce402AndKeepsTheDelegatesSettings() throws Exception {
    paywall("/paid", "localhost");
    HttpClient delegate = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3))
        .version(HttpClient.Version.HTTP_1_1).build();
    HttpClient client = X402HttpClient.wrap(delegate, x402);
    assertThat(client.connectTimeout()).isEqualTo(delegate.connectTimeout());
    assertThat(client.version()).isEqualTo(HttpClient.Version.HTTP_1_1);
    assertThat(client.followRedirects()).isEqualTo(delegate.followRedirects());
    assertThat(client.proxy()).isEqualTo(delegate.proxy());
    assertThat(client.cookieHandler()).isEqualTo(delegate.cookieHandler());
    assertThat(client.authenticator()).isEqualTo(delegate.authenticator());
    assertThat(client.executor()).isEqualTo(delegate.executor());
    assertThat(client.sslContext()).isSameAs(delegate.sslContext());
    assertThat(client.sslParameters()).isNotNull();

    HttpResponse<String> response = client.send(HttpRequest.newBuilder(local("/paid")).build(),
        BodyHandlers.ofString());
    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).isEqualTo("content");
    assertThat(X402HttpClient.paymentResponse(response)).get()
        .extracting(SettleResponse::transaction).isEqualTo("tx");
    PaymentPayload sent = HeaderCodec.decodePaymentSignature(wm.findAll(
        getRequestedFor(urlEqualTo("/paid")).withHeader("PAYMENT-SIGNATURE", matching(".+")))
        .get(0).getHeader("PAYMENT-SIGNATURE"));
    assertThat(sent.accepted()).isEqualTo(req);
  }

  @Test
  void requestBodiesAreRecordedAndReplayed() throws Exception {
    wm.stubFor(post(urlEqualTo("/job")).withHeader("PAYMENT-SIGNATURE", absent())
        .willReturn(aResponse().withStatus(402).withHeader("PAYMENT-REQUIRED",
            required("http://localhost/job"))));
    wm.stubFor(post(urlEqualTo("/job")).withHeader("PAYMENT-SIGNATURE", matching(".+"))
        .willReturn(aResponse().withStatus(201).withBody("created")));
    HttpClient client = X402HttpClient.wrap(HttpClient.newHttpClient(), x402);
    HttpResponse<String> response = client.send(HttpRequest.newBuilder(local("/job"))
        .header("X-Api-Key", "k").POST(BodyPublishers.ofString("{\"q\":1}")).build(),
        BodyHandlers.ofString());
    assertThat(response.statusCode()).isEqualTo(201);
    wm.verify(postRequestedFor(urlEqualTo("/job")).withHeader("PAYMENT-SIGNATURE", matching(".+"))
        .withHeader("X-Api-Key", equalTo("k")).withRequestBody(equalTo("{\"q\":1}")));
  }

  @Test
  void anOversizedBodyReturnsThe402UnpaidWithoutSigning() throws Exception {
    wm.stubFor(post(urlEqualTo("/big")).willReturn(aResponse().withStatus(402)
        .withHeader("PAYMENT-REQUIRED", required("http://localhost/big")).withBody("pay me")));
    HttpClient client = X402HttpClient.builder(HttpClient.newHttpClient(), x402)
        .maxReplayBody(4).build();
    HttpResponse<String> response = client.send(HttpRequest.newBuilder(local("/big"))
        .POST(BodyPublishers.ofString("more than four bytes")).build(), BodyHandlers.ofString());
    assertThat(response.statusCode()).isEqualTo(402);
    assertThat(response.body()).isEqualTo("pay me");
    wm.verify(1, postRequestedFor(urlEqualTo("/big")));
    wm.verify(0, postRequestedFor(urlEqualTo("/big")).withHeader("PAYMENT-SIGNATURE",
        matching(".*")));
  }

  @Test
  void aHostPolicyNeedsADelegateThatDoesNotFollowRedirects() {
    HostPolicy policy = HostPolicy.of(List.of("localhost"));
    assertThatThrownBy(() -> X402HttpClient.wrap(HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NORMAL).build(), x402, policy))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("followRedirects");
    assertThat(X402HttpClient.wrap(noRedirects(), x402, policy).followRedirects())
        .isEqualTo(HttpClient.Redirect.NORMAL);
  }

  @Test
  void aHostPolicyLimitsWhichHostsArePaid() throws Exception {
    paywall("/paid", "localhost");
    HttpClient client = X402HttpClient.wrap(noRedirects(), x402,
        HostPolicy.of(List.of("LOCALHOST")));
    assertThat(client.send(HttpRequest.newBuilder(loopback("/paid")).build(),
        BodyHandlers.ofString()).statusCode()).isEqualTo(402);
    wm.verify(0, getRequestedFor(urlEqualTo("/paid")).withHeader("PAYMENT-SIGNATURE",
        matching(".*")));
    assertThat(client.send(HttpRequest.newBuilder(local("/paid")).build(),
        BodyHandlers.ofString()).statusCode()).isEqualTo(200);
  }

  @Test
  void theResourceUrlHostMustBeAllowedToo() throws Exception {
    paywall("/paid", "evil.example");
    HttpClient client = X402HttpClient.wrap(noRedirects(), x402, HostPolicy.of(
        List.of("localhost")));
    HttpResponse<String> response = client.send(HttpRequest.newBuilder(local("/paid")).build(),
        BodyHandlers.ofString());
    assertThat(response.statusCode()).isEqualTo(402);
    assertThat(response.body()).isEqualTo("{}");
    wm.verify(0, getRequestedFor(urlEqualTo("/paid")).withHeader("PAYMENT-SIGNATURE",
        matching(".*")));
  }

  @Test
  void anOffListRedirectTargetNeverReceivesThePaymentSignature() throws Exception {
    wm.stubFor(get(urlEqualTo("/moved")).willReturn(aResponse().withStatus(301)
        .withHeader("Location", "/paid")));
    wm.stubFor(get(urlEqualTo("/paid")).withHeader("PAYMENT-SIGNATURE", absent())
        .willReturn(aResponse().withStatus(402)
            .withHeader("PAYMENT-REQUIRED", required("http://localhost/paid"))));
    wm.stubFor(get(urlEqualTo("/paid")).withHeader("PAYMENT-SIGNATURE", matching(".+"))
        .willReturn(aResponse().withStatus(302)
            .withHeader("Location", loopback("/collect").toString())));
    wm.stubFor(get(urlEqualTo("/collect")).willReturn(aResponse().withStatus(200)));
    HttpClient client = X402HttpClient.wrap(noRedirects(), x402, HostPolicy.of(
        List.of("localhost")));

    HttpResponse<String> response = client.send(HttpRequest.newBuilder(local("/moved")).build(),
        BodyHandlers.ofString());
    assertThat(response.statusCode()).isEqualTo(302);
    assertThat(response.uri().getPath()).isEqualTo("/paid");
    wm.verify(0, getRequestedFor(urlEqualTo("/collect")));
    wm.verify(1, getRequestedFor(urlEqualTo("/paid")).withHeader("PAYMENT-SIGNATURE",
        matching(".+")));
  }

  @Test
  void unpaidRedirectsAreFollowedAndAPaidRetryFollowsAllowedHosts() throws Exception {
    paywall("/final", "localhost");
    wm.stubFor(get(urlEqualTo("/start")).willReturn(aResponse().withStatus(307)
        .withHeader("Location", local("/final").toString())));
    HttpClient client = X402HttpClient.wrap(noRedirects(), x402, HostPolicy.of(
        List.of("localhost")));
    HttpResponse<String> response = client.send(HttpRequest.newBuilder(local("/start")).build(),
        BodyHandlers.ofString());
    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).isEqualTo("content");
    assertThat(response.previousResponse()).isPresent();
  }

  @Test
  void aPaymentResponseHookMayAskForOneMorePayment() throws Exception {
    wm.stubFor(get(urlEqualTo("/r")).inScenario("r").whenScenarioStateIs(Scenario.STARTED)
        .willSetStateTo("paid-once").willReturn(aResponse().withStatus(402)
            .withHeader("PAYMENT-REQUIRED", required("http://localhost/r"))));
    wm.stubFor(get(urlEqualTo("/r")).inScenario("r").whenScenarioStateIs("paid-once")
        .willSetStateTo("paid-twice").willReturn(aResponse().withStatus(402)
            .withHeader("PAYMENT-REQUIRED", required("http://localhost/r"))));
    wm.stubFor(get(urlEqualTo("/r")).inScenario("r").whenScenarioStateIs("paid-twice")
        .willReturn(aResponse().withStatus(200).withBody("ok")));
    x402.onPaymentResponse(ctx -> ctx.paymentRequired() != null);
    HttpResponse<String> response = X402HttpClient.wrap(HttpClient.newHttpClient(), x402)
        .send(HttpRequest.newBuilder(local("/r")).build(), BodyHandlers.ofString());
    assertThat(response.statusCode()).isEqualTo(200);
    wm.verify(2, getRequestedFor(urlEqualTo("/r")).withHeader("PAYMENT-SIGNATURE",
        matching(".+")));
  }

  @Test
  void non402AndNonX402ResponsesPassThroughAndBadHeadersFail() throws Exception {
    wm.stubFor(get(urlEqualTo("/free")).willReturn(aResponse().withStatus(200).withBody("hi")));
    wm.stubFor(get(urlEqualTo("/plain402")).willReturn(aResponse().withStatus(402)
        .withBody("legacy")));
    wm.stubFor(get(urlEqualTo("/bad")).willReturn(aResponse().withStatus(402)
        .withHeader("PAYMENT-REQUIRED", "%%%")));
    HttpClient client = X402HttpClient.wrap(HttpClient.newHttpClient(), x402);
    assertThat(client.send(HttpRequest.newBuilder(local("/free")).build(),
        BodyHandlers.ofString()).body()).isEqualTo("hi");
    HttpResponse<byte[]> plain = client.send(HttpRequest.newBuilder(local("/plain402")).build(),
        BodyHandlers.ofByteArray());
    assertThat(new String(plain.body())).isEqualTo("legacy");
    assertThat(X402HttpClient.paymentResponse(plain)).isEmpty();
    assertThatThrownBy(() -> client.send(HttpRequest.newBuilder(local("/bad")).build(),
        BodyHandlers.ofString())).isInstanceOf(X402ClientException.class)
        .hasMessageStartingWith("Failed to parse payment requirements");
  }

  @Test
  void refusalsToPayAreClientErrors() {
    paywall("/paid", "localhost");
    HttpClient client = X402HttpClient.wrap(HttpClient.newHttpClient(),
        new X402Client().register("eip155:1", new FakeClientScheme()));
    assertThatThrownBy(() -> client.send(HttpRequest.newBuilder(local("/paid")).build(),
        BodyHandlers.ofString())).isInstanceOf(X402ClientException.class)
        .hasMessageStartingWith("Failed to create payment payload: No network/scheme registered");
  }

  @Test
  void aRequestThatAlreadyCarriesASignatureIsNotPaidAgain() {
    wm.stubFor(get(urlEqualTo("/again")).willReturn(aResponse().withStatus(402)
        .withHeader("PAYMENT-REQUIRED", required("http://localhost/again"))));
    HttpClient client = X402HttpClient.wrap(HttpClient.newHttpClient(), x402);
    assertThatThrownBy(() -> client.send(HttpRequest.newBuilder(local("/again"))
        .header("PAYMENT-SIGNATURE", "old").build(), BodyHandlers.ofString()))
        .isInstanceOf(X402ClientException.class).hasMessage("Payment already attempted");
  }

  @Test
  void sendAsyncPaysToo() throws Exception {
    paywall("/paid", "localhost");
    HttpClient client = X402HttpClient.wrap(HttpClient.newHttpClient(), x402);
    assertThat(client.sendAsync(HttpRequest.newBuilder(local("/paid")).build(),
        BodyHandlers.ofString()).get().body()).isEqualTo("content");
    assertThat(client.sendAsync(HttpRequest.newBuilder(local("/paid")).build(),
        BodyHandlers.ofString(), null).get().statusCode()).isEqualTo(200);
  }

  @Test
  void theDefaultTimeoutCoversTheWorstServerPath() {
    HttpFacilitatorClient defaults = HttpFacilitatorClient.builder().build();
    Duration worst = defaults.verifyTimeout().multipliedBy(2)
        .plus(defaults.settleTimeout().multipliedBy(2));
    assertThat(worst).isEqualTo(Duration.ofSeconds(210));
    assertThat(X402HttpClient.DEFAULT_REQUEST_TIMEOUT).isEqualTo(Duration.ofSeconds(240))
        .isGreaterThanOrEqualTo(worst);
    X402HttpClient client = X402HttpClient.wrap(HttpClient.newHttpClient(), x402);
    assertThat(client.defaultRequestTimeout()).isEqualTo(X402HttpClient.DEFAULT_REQUEST_TIMEOUT);
    assertThat(client.withDefaultTimeout(HttpRequest.newBuilder(local("/")).build()).timeout())
        .contains(Duration.ofSeconds(240));
    assertThat(client.withDefaultTimeout(HttpRequest.newBuilder(local("/"))
        .timeout(Duration.ofSeconds(5)).build()).timeout()).contains(Duration.ofSeconds(5));
    assertThat(X402HttpClient.DEFAULT_MAX_REPLAY_BODY).isEqualTo(1 << 20);
  }

  @Test
  void hostPoliciesMatchExactHostsAndSubdomainWildcards() {
    HostPolicy policy = HostPolicy.of(List.of("api.example.com", "*.masumi.network"));
    assertThat(policy.allows("API.example.com")).isTrue();
    assertThat(policy.allows("x.masumi.network")).isTrue();
    assertThat(policy.allows("a.b.masumi.network")).isTrue();
    assertThat(policy.allows("masumi.network")).isFalse();
    assertThat(policy.allows("evilmasumi.network")).isFalse();
    assertThat(policy.allows("example.com")).isFalse();
    assertThat(policy.allows((String) null)).isFalse();
    assertThat(policy.allows(URI.create("https://api.example.com:8443/x"))).isTrue();
    assertThat(policy.allows(URI.create("mailto:x"))).isFalse();
    assertThat(HostPolicy.of(List.of()).allows("api.example.com")).isFalse();
    assertThat(policy.patterns()).containsExactly("api.example.com", "*.masumi.network");
    assertThatThrownBy(() -> HostPolicy.of(List.of("*"))).isInstanceOf(
        IllegalArgumentException.class);
    assertThatThrownBy(() -> HostPolicy.of(List.of("api.example.com:443")))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> HostPolicy.of(List.of("a.*.com")))
        .isInstanceOf(IllegalArgumentException.class);
  }
}
