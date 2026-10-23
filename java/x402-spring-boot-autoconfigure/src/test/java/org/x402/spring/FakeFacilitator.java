package org.x402.spring;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.matchingJsonPath;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;
import com.github.tomakehurst.wiremock.stubbing.Scenario;
import com.github.tomakehurst.wiremock.verification.LoggedRequest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.x402.core.json.X402Json;

/**
 * A WireMock facilitator speaking the x402 wire contract. Requests choose an outcome through
 * {@code paymentPayload.payload.mode}: absent = valid + settled, {@code verify-invalid}, {@code
 * settle-fail}, {@code pending} (first settle pending, the retry succeeds).
 */
public final class FakeFacilitator implements AutoCloseable {

  private static final String NETWORK = "{{jsonPath request.body '$.paymentRequirements.network'}}";

  private final WireMockServer server;

  private FakeFacilitator(WireMockServer server) {
    this.server = server;
  }

  /**
   * Starts a facilitator listing {@code exact} on the given networks.
   *
   * @param networks the networks
   * @return the started facilitator
   */
  public static FakeFacilitator start(String... networks) {
    WireMockServer server = new WireMockServer(
        WireMockConfiguration.options().dynamicPort().globalTemplating(true));
    server.start();
    FakeFacilitator f = new FakeFacilitator(server);
    f.reset(networks);
    return f;
  }

  /**
   * The base URL.
   *
   * @return the URL
   */
  public String url() {
    return server.baseUrl();
  }

  /**
   * The WireMock server.
   *
   * @return the server
   */
  public WireMockServer server() {
    return server;
  }

  /**
   * Drops all stubs and requests and installs the default behaviour.
   *
   * @param networks the networks listed by {@code /supported}
   */
  public void reset(String... networks) {
    server.resetAll();
    supported(networks);
    server.stubFor(post(urlEqualTo("/verify")).atPriority(5).willReturn(json(200,
        "{\"isValid\":true,\"payer\":\"buyer\"}")));
    server.stubFor(post(urlEqualTo("/verify")).atPriority(1)
        .withRequestBody(matchingJsonPath("$.paymentPayload.payload.mode",
            equalTo("verify-invalid")))
        .willReturn(json(200,
            "{\"isValid\":false,\"invalidReason\":\"invalid_payload\",\"payer\":\"buyer\"}")));
    server.stubFor(post(urlEqualTo("/settle")).atPriority(5).willReturn(json(200,
        "{\"success\":true,\"transaction\":\"tx-1\",\"network\":\"" + NETWORK
            + "\",\"payer\":\"buyer\"}")));
    server.stubFor(post(urlEqualTo("/settle")).atPriority(1)
        .withRequestBody(matchingJsonPath("$.paymentPayload.payload.mode",
            equalTo("settle-fail")))
        .willReturn(json(200, "{\"success\":false,\"errorReason\":\"insufficient_funds\","
            + "\"transaction\":\"\",\"network\":\"" + NETWORK + "\"}")));
    server.stubFor(post(urlEqualTo("/settle")).atPriority(1)
        .withRequestBody(matchingJsonPath("$.paymentPayload.payload.mode",
            equalTo("settle-garbage")))
        .willReturn(json(200, "this is not json")));
    server.stubFor(post(urlEqualTo("/settle")).atPriority(1)
        .withRequestBody(matchingJsonPath("$.paymentPayload.payload.mode",
            equalTo("slow-settle")))
        .willReturn(json(200, "{\"success\":true,\"transaction\":\"tx-slow\",\"network\":\""
            + NETWORK + "\"}").withFixedDelay(1500)));
    server.stubFor(post(urlEqualTo("/settle")).atPriority(1).inScenario("pending")
        .whenScenarioStateIs(Scenario.STARTED)
        .withRequestBody(matchingJsonPath("$.paymentPayload.payload.mode", equalTo("pending")))
        .willReturn(json(200, "{\"success\":false,\"errorReason\":\"settlement_pending\","
            + "\"transaction\":\"tx-pending\",\"network\":\"" + NETWORK + "\"}"))
        .willSetStateTo("retried"));
    server.stubFor(post(urlEqualTo("/settle")).atPriority(1).inScenario("pending")
        .whenScenarioStateIs("retried")
        .withRequestBody(matchingJsonPath("$.paymentPayload.payload.mode", equalTo("pending")))
        .willReturn(json(200, "{\"success\":true,\"transaction\":\"tx-pending\",\"network\":\""
            + NETWORK + "\"}"))
        .willSetStateTo(Scenario.STARTED));
  }

  /**
   * Replaces {@code /supported} with {@code exact} kinds on the given networks.
   *
   * @param networks the networks
   */
  public void supported(String... networks) {
    Map<String, Map<String, Object>> kinds = new LinkedHashMap<>();
    for (String n : networks) {
      kinds.put(n, null);
    }
    supportedWithExtra(kinds);
  }

  /**
   * Replaces {@code /supported} with {@code exact} kinds carrying an {@code extra} per network.
   *
   * @param kinds network → kind extra (may be {@code null})
   */
  public void supportedWithExtra(Map<String, Map<String, Object>> kinds) {
    List<Map<String, Object>> list = new ArrayList<>();
    kinds.forEach((network, extra) -> {
      Map<String, Object> kind = new LinkedHashMap<>();
      kind.put("x402Version", 2);
      kind.put("scheme", "exact");
      kind.put("network", network);
      if (extra != null) {
        kind.put("extra", extra);
      }
      list.add(kind);
    });
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("kinds", list);
    body.put("extensions", List.of());
    body.put("signers", Map.of());
    server.stubFor(get(urlEqualTo("/supported")).willReturn(json(200, X402Json.write(body))));
  }

  /**
   * Makes {@code /supported} fail with a status.
   *
   * @param status the status
   */
  public void supportedFails(int status) {
    server.stubFor(get(urlEqualTo("/supported")).willReturn(json(status, "{\"error\":\"down\"}")));
  }

  /**
   * Makes {@code /supported} answer slowly (the kinds stay as they are given here).
   *
   * @param delayMillis the delay
   * @param status the status
   */
  public void supportedSlow(int delayMillis, int status) {
    server.stubFor(get(urlEqualTo("/supported")).willReturn(json(status, "{\"error\":\"down\"}")
        .withFixedDelay(delayMillis)));
  }

  /**
   * Makes every {@code /verify} answer with a status and body.
   *
   * @param status the status
   * @param body the body
   */
  public void verifyAnswers(int status, String body) {
    server.stubFor(post(urlEqualTo("/verify")).atPriority(0).willReturn(json(status, body)));
  }

  /**
   * Number of {@code POST /verify} or {@code /settle}, or {@code GET /supported}, requests.
   *
   * @param endpoint {@code verify}, {@code settle} or {@code supported}
   * @return the count
   */
  public int count(String endpoint) {
    if ("supported".equals(endpoint)) {
      return server.countRequestsMatching(getRequestedFor(urlEqualTo("/supported")).build())
          .getCount();
    }
    return server.countRequestsMatching(postRequestedFor(urlEqualTo("/" + endpoint)).build())
        .getCount();
  }

  /**
   * Bodies of the requests to an endpoint.
   *
   * @param endpoint {@code verify} or {@code settle}
   * @return the bodies, oldest first
   */
  public List<String> bodies(String endpoint) {
    List<LoggedRequest> requests =
        server.findAll(postRequestedFor(urlEqualTo("/" + endpoint)));
    return requests.stream().map(LoggedRequest::getBodyAsString).toList();
  }

  private static com.github.tomakehurst.wiremock.client.ResponseDefinitionBuilder json(int status,
      String body) {
    return aResponse().withStatus(status).withHeader("Content-Type", "application/json")
        .withBody(body);
  }

  @Override
  public void close() {
    server.stop();
  }
}
