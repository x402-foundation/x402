package org.x402.http;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.equalToJson;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.options;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.PREPROD;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.stubbing.Scenario;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorResponseException;
import org.x402.core.FacilitatorStatusException;
import org.x402.core.Fixtures;
import org.x402.core.SettleException;
import org.x402.core.VerifyException;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedResponse;
import org.x402.core.types.VerifyResponse;

/** The HTTP facilitator client over java.net.http. */
class HttpFacilitatorClientTest {

  private final WireMockServer wm = new WireMockServer(options().dynamicPort());
  private final List<Duration> sleeps = new CopyOnWriteArrayList<>();
  private final PaymentRequirements req = Fixtures.requirements();
  private final PaymentPayload payload = Fixtures.payload(req);

  @BeforeEach
  void start() {
    wm.start();
  }

  @AfterEach
  void stop() {
    wm.stop();
  }

  private HttpFacilitatorClient.Builder client() {
    return HttpFacilitatorClient.builder().url(wm.baseUrl() + "/").sleeper(sleeps::add);
  }

  private static String json(Object o) {
    return X402Json.write(o);
  }

  @Test
  void defaultsFollowTs() {
    HttpFacilitatorClient c = HttpFacilitatorClient.builder().build();
    assertThat(c.url()).isEqualTo("https://x402.org/facilitator");
    assertThat(c.identifier()).isEqualTo("https://x402.org/facilitator");
    assertThat(c.settleTimeout()).isEqualTo(Duration.ofSeconds(90));
    assertThat(c.verifyTimeout()).isEqualTo(Duration.ofSeconds(15));
    assertThat(HttpFacilitatorClient.builder().url("https://f.example///").identifier("team/")
        .build().identifier()).isEqualTo("team");
    assertThatThrownBy(() -> HttpFacilitatorClient.builder().timeout(Duration.ZERO).build())
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void verifyPostsTheTsBodyWithVerifyAuthHeaders() {
    wm.stubFor(post(urlEqualTo("/verify")).willReturn(aResponse()
        .withHeader("Content-Type", "application/json")
        .withHeader("EXTENSION-RESPONSES", Base64.getEncoder().encodeToString(
            "{\"bazaar\":{\"status\":\"ok\"}}".getBytes(StandardCharsets.UTF_8)))
        .withBody("{\"isValid\":true,\"payer\":\"p\",\"invalidReason\":null}")));
    HttpFacilitatorClient c = client().authProvider(() -> new FacilitatorAuthProvider.AuthHeaders(
        Map.of("Authorization", "Bearer v"), Map.of("Authorization", "Bearer s"),
        Map.of("Authorization", "Bearer x"))).build();
    VerifyResponse v = c.verify(payload, req);
    assertThat(v.isValid()).isTrue();
    assertThat(v.payer()).isEqualTo("p");
    assertThat(v.extensionResponses()).containsEntry("bazaar", Map.of("status", "ok"));
    wm.verify(postRequestedFor(urlEqualTo("/verify"))
        .withHeader("Authorization", equalTo("Bearer v"))
        .withHeader("Content-Type", equalTo("application/json"))
        .withRequestBody(equalToJson(json(Map.of("x402Version", 2, "paymentPayload", payload,
            "paymentRequirements", req)))));
  }

  @Test
  void verifyErrorStatusesMapLikeTs() {
    wm.stubFor(post(urlEqualTo("/verify")).inScenario("v").whenScenarioStateIs(Scenario.STARTED)
        .willSetStateTo("2").willReturn(aResponse().withStatus(400)
            .withBody("{\"isValid\":false,\"invalidReason\":\"nonce_spent\"}")));
    wm.stubFor(post(urlEqualTo("/verify")).inScenario("v").whenScenarioStateIs("2")
        .willSetStateTo("3").willReturn(aResponse().withStatus(503).withBody("busy  now")));
    wm.stubFor(post(urlEqualTo("/verify")).inScenario("v").whenScenarioStateIs("3")
        .willSetStateTo("4").willReturn(aResponse().withStatus(429)
            .withBody("{\"error\":\"slow\"}")));
    wm.stubFor(post(urlEqualTo("/verify")).inScenario("v").whenScenarioStateIs("4")
        .willReturn(aResponse().withStatus(200).withBody("not json")));
    HttpFacilitatorClient c = client().build();

    assertThatThrownBy(() -> c.verify(payload, req)).isInstanceOfSatisfying(
        VerifyException.class, e -> {
          assertThat(e.statusCode()).isEqualTo(400);
          assertThat(e.response().invalidReason()).isEqualTo("nonce_spent");
        });
    assertThatThrownBy(() -> c.verify(payload, req)).isInstanceOfSatisfying(
        FacilitatorStatusException.class, e -> {
          assertThat(e.statusCode()).isEqualTo(503);
          assertThat(e).hasMessage("Facilitator verify failed (503): busy now");
        });
    assertThatThrownBy(() -> c.verify(payload, req))
        .isInstanceOf(FacilitatorStatusException.class)
        .hasMessage("Facilitator verify failed (429): {\"error\":\"slow\"}");
    assertThatThrownBy(() -> c.verify(payload, req)).isInstanceOfSatisfying(
        FacilitatorResponseException.class, e -> {
          assertThat(e.statusCode()).isEqualTo(200);
          assertThat(e).hasMessage("Facilitator verify returned invalid JSON: not json");
        });
  }

  @Test
  void settleMapsResultsAndErrors() {
    SettleResponse ok = SettleResponse.success("tx", PREPROD, "p");
    wm.stubFor(post(urlEqualTo("/settle")).inScenario("s").whenScenarioStateIs(Scenario.STARTED)
        .willSetStateTo("2").willReturn(aResponse().withBody(json(ok))));
    wm.stubFor(post(urlEqualTo("/settle")).inScenario("s").whenScenarioStateIs("2")
        .willSetStateTo("3").willReturn(aResponse().withStatus(500)
            .withBody(json(Fixtures.pending(PREPROD, "tx1")))));
    wm.stubFor(post(urlEqualTo("/settle")).inScenario("s").whenScenarioStateIs("3")
        .willSetStateTo("4").willReturn(aResponse().withStatus(200)
            .withBody("{\"success\":true}")));
    wm.stubFor(post(urlEqualTo("/settle")).inScenario("s").whenScenarioStateIs("4")
        .willReturn(aResponse().withStatus(502).withBody("")));
    HttpFacilitatorClient c = client().authProvider(FacilitatorAuthProvider.of(
        new FacilitatorAuthProvider.AuthHeaders(null, Map.of("X-Key", "k"), null))).build();

    assertThat(c.settle(payload, req)).isEqualTo(ok);
    wm.verify(postRequestedFor(urlEqualTo("/settle")).withHeader("X-Key", equalTo("k")));
    assertThatThrownBy(() -> c.settle(payload, req)).isInstanceOfSatisfying(
        SettleException.class, e -> assertThat(e.response().isPending()).isTrue());
    assertThatThrownBy(() -> c.settle(payload, req))
        .isInstanceOf(FacilitatorResponseException.class)
        .hasMessage("Facilitator settle returned invalid data: {\"success\":true}");
    assertThatThrownBy(() -> c.settle(payload, req))
        .isInstanceOf(FacilitatorStatusException.class)
        .hasMessage("Facilitator settle failed (502): <empty response>");
  }

  @Test
  void supportedRetries429ThenSucceedsWithDefaults() {
    SupportedResponse body = Fixtures.supported(Fixtures.kind(PREPROD));
    wm.stubFor(get(urlEqualTo("/supported")).inScenario("r").whenScenarioStateIs(Scenario.STARTED)
        .willSetStateTo("2").willReturn(aResponse().withStatus(429).withHeader("Retry-After", "2")
            .withBody("slow")));
    wm.stubFor(get(urlEqualTo("/supported")).inScenario("r").whenScenarioStateIs("2")
        .willSetStateTo("3").willReturn(aResponse().withStatus(429).withBody("slow")));
    wm.stubFor(get(urlEqualTo("/supported")).inScenario("r").whenScenarioStateIs("3")
        .willReturn(aResponse().withBody("{\"kinds\":" + json(body.kinds()) + "}")));
    HttpFacilitatorClient c = client().authProvider(() -> new FacilitatorAuthProvider.AuthHeaders(
        null, null, Map.of("Authorization", "Bearer sup"))).build();
    SupportedResponse s = c.getSupported();
    assertThat(s.kinds()).isEqualTo(body.kinds());
    assertThat(s.extensions()).isEmpty();
    assertThat(s.signers()).isEmpty();
    assertThat(sleeps).containsExactly(Duration.ofSeconds(2), Duration.ofSeconds(2));
    wm.verify(3, getRequestedFor(urlEqualTo("/supported"))
        .withHeader("Authorization", equalTo("Bearer sup")));
  }

  @Test
  void supportedGivesUpAfterThreeAttemptsAndDoesNotRetryOtherErrors() {
    wm.stubFor(get(urlEqualTo("/supported")).willReturn(aResponse().withStatus(429)
        .withBody("slow")));
    assertThatThrownBy(() -> client().build().getSupported())
        .isInstanceOf(FacilitatorStatusException.class)
        .hasMessage("Facilitator getSupported failed (429): slow");
    wm.verify(3, getRequestedFor(urlEqualTo("/supported")));
    assertThat(sleeps).containsExactly(Duration.ofSeconds(1), Duration.ofSeconds(2));

    wm.resetAll();
    wm.stubFor(get(urlEqualTo("/supported")).willReturn(aResponse().withStatus(500)
        .withBody("x".repeat(300))));
    assertThatThrownBy(() -> client().build().getSupported())
        .hasMessage("Facilitator getSupported failed (500): " + "x".repeat(197) + "...");
    wm.verify(1, getRequestedFor(urlEqualTo("/supported")));

    wm.resetAll();
    wm.stubFor(get(urlEqualTo("/supported")).willReturn(aResponse()
        .withBody("{\"kinds\":[{\"scheme\":\"exact\"}]}")));
    assertThatThrownBy(() -> client().build().getSupported())
        .isInstanceOf(FacilitatorResponseException.class)
        .hasMessageStartingWith("Facilitator supported returned invalid data");
  }

  @Test
  void verifyUsesItsOwnShorterTimeout() {
    wm.stubFor(post(urlEqualTo("/verify")).willReturn(aResponse().withFixedDelay(1500)
        .withBody("{\"isValid\":true}")));
    HttpFacilitatorClient c = client().verifyTimeout(Duration.ofMillis(200))
        .timeout(Duration.ofSeconds(5)).build();
    long start = System.nanoTime();
    assertThatThrownBy(() -> c.verify(payload, req))
        .isInstanceOfSatisfying(FacilitatorResponseException.Timeout.class, e -> {
          assertThat(e.operation()).isEqualTo("verify");
          assertThat(e.timeoutMillis()).isEqualTo(200);
          assertThat(e.statusCode()).isZero();
        });
    assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofMillis(1400));
  }

  @Test
  void aRefusedConnectionIsATransportError() {
    HttpFacilitatorClient c = HttpFacilitatorClient.builder().url("http://127.0.0.1:1").build();
    assertThatThrownBy(() -> c.verify(payload, req)).isInstanceOfSatisfying(
        FacilitatorResponseException.class, e -> {
          assertThat(e.statusCode()).isZero();
          assertThat(e).hasMessageStartingWith("Facilitator verify request failed");
        });
  }

  @Test
  void retryDelaysFollowTs() {
    Clock clock = Clock.fixed(Instant.parse("2026-10-12T00:00:00Z"), ZoneOffset.UTC);
    assertThat(HttpFacilitatorClient.computeRetryDelay("3", 0, clock))
        .isEqualTo(Duration.ofSeconds(3));
    assertThat(HttpFacilitatorClient.computeRetryDelay(" 120 ", 0, clock))
        .isEqualTo(Duration.ofSeconds(30));
    assertThat(HttpFacilitatorClient.computeRetryDelay("Mon, 12 Oct 2026 00:00:05 GMT", 0, clock))
        .isEqualTo(Duration.ofSeconds(5));
    assertThat(HttpFacilitatorClient.computeRetryDelay("Sun, 11 Oct 2026 00:00:05 GMT", 1, clock))
        .isEqualTo(Duration.ofSeconds(2));
    assertThat(HttpFacilitatorClient.computeRetryDelay("garbage", 2, clock))
        .isEqualTo(Duration.ofSeconds(4));
    assertThat(HttpFacilitatorClient.computeRetryDelay(null, 0, clock))
        .isEqualTo(Duration.ofSeconds(1));
    assertThat(HttpFacilitatorClient.computeRetryDelay("0", 0, clock))
        .isEqualTo(Duration.ofSeconds(1));
  }
}
