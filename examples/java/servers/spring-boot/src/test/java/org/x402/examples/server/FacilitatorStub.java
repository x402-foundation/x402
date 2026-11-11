package org.x402.examples.server;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;
import com.github.tomakehurst.wiremock.verification.LoggedRequest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.x402.core.json.X402Json;

/**
 * A WireMock facilitator under {@code /x402} that lists Cardano {@code exact} on preprod and
 * mainnet (all three transfer methods), verifies every payment and settles it. No chain access.
 */
final class FacilitatorStub implements AutoCloseable {

  static final String BASE = "/x402";

  private final WireMockServer server;

  FacilitatorStub() {
    server = new WireMockServer(WireMockConfiguration.options().dynamicPort()
        .globalTemplating(true));
    server.start();
    reset();
  }

  /** The facilitator URL, as configured in {@code x402.facilitators[].url}. */
  String url() {
    return "http://127.0.0.1:" + server.port() + BASE;
  }

  void reset() {
    server.resetAll();
    List<Map<String, Object>> kinds = new ArrayList<>();
    for (String network : List.of("cardano:preprod", "cardano:mainnet")) {
      Map<String, Object> extra = new LinkedHashMap<>();
      extra.put("assetTransferMethods", List.of("default", "masumi", "script"));
      extra.put("areFeesSponsored", false);
      extra.put("l1Confirmations", Map.of("minimum", 0, "maximum", 20));
      Map<String, Object> kind = new LinkedHashMap<>();
      kind.put("x402Version", 2);
      kind.put("scheme", "exact");
      kind.put("network", network);
      kind.put("extra", extra);
      kinds.add(kind);
    }
    Map<String, Object> supported = new LinkedHashMap<>();
    supported.put("kinds", kinds);
    supported.put("extensions", List.of());
    supported.put("signers", Map.of());
    server.stubFor(get(urlEqualTo(BASE + "/supported")).willReturn(json(200,
        X402Json.write(supported))));
    server.stubFor(post(urlEqualTo(BASE + "/verify")).willReturn(json(200,
        "{\"isValid\":true,\"payer\":\"addr_test1buyer\"}")));
    server.stubFor(post(urlEqualTo(BASE + "/settle")).willReturn(json(200,
        "{\"success\":true,\"transaction\":\"" + "ab".repeat(32) + "\","
            + "\"network\":\"{{jsonPath request.body '$.paymentRequirements.network'}}\","
            + "\"payer\":\"addr_test1buyer\"}")));
  }

  /** Every {@code /verify} answers 503 without {@code isValid}: a transport-level failure. */
  void verifyUnavailable() {
    server.stubFor(post(urlEqualTo(BASE + "/verify")).atPriority(1)
        .willReturn(json(503, "{\"error\":\"maintenance\"}")));
  }

  int count(String endpoint) {
    if ("supported".equals(endpoint)) {
      return server.countRequestsMatching(
          getRequestedFor(urlEqualTo(BASE + "/supported")).build()).getCount();
    }
    return server.countRequestsMatching(
        postRequestedFor(urlEqualTo(BASE + "/" + endpoint)).build()).getCount();
  }

  List<LoggedRequest> requests(String endpoint) {
    return server.findAll(postRequestedFor(urlEqualTo(BASE + "/" + endpoint)));
  }

  private static com.github.tomakehurst.wiremock.client.ResponseDefinitionBuilder json(
      int status, String body) {
    return aResponse().withStatus(status).withHeader("Content-Type", "application/json")
        .withBody(body);
  }

  @Override
  public void close() {
    server.stop();
  }
}
