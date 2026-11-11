package org.x402.http;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.anyRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.options;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.github.tomakehurst.wiremock.WireMockServer;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorResponseException;
import org.x402.core.Fixtures;
import org.x402.core.types.PaymentRequirements;

/**
 * The default transport never follows a facilitator redirect, so per-endpoint
 * auth headers cannot reach another host; a 3xx answer is a {@link FacilitatorResponseException}.
 */
class HttpFacilitatorClientRedirectTest {

  private final WireMockServer facilitator = new WireMockServer(options().dynamicPort());
  private final WireMockServer elsewhere = new WireMockServer(options().dynamicPort());

  @BeforeEach
  void start() {
    facilitator.start();
    elsewhere.start();
  }

  @AfterEach
  void stop() {
    facilitator.stop();
    elsewhere.stop();
  }

  @Test
  void redirectsAreNotFollowedAndAreErrors() {
    facilitator.stubFor(post(urlEqualTo("/verify")).willReturn(aResponse().withStatus(307)
        .withHeader("Location", elsewhere.baseUrl() + "/verify")));
    facilitator.stubFor(get(urlEqualTo("/supported")).willReturn(aResponse().withStatus(301)
        .withHeader("Location", elsewhere.baseUrl() + "/supported")));
    HttpFacilitatorClient client = HttpFacilitatorClient.builder().url(facilitator.baseUrl())
        .authProvider(FacilitatorAuthProvider.of(new FacilitatorAuthProvider.AuthHeaders(
            Map.of("Authorization", "Bearer v"), null, Map.of("Authorization", "Bearer s"))))
        .build();
    PaymentRequirements req = Fixtures.requirements();

    assertThatThrownBy(() -> client.verify(Fixtures.payload(req), req))
        .isInstanceOfSatisfying(FacilitatorResponseException.class, e ->
            org.assertj.core.api.Assertions.assertThat(e.statusCode()).isEqualTo(307))
        .hasMessageContaining("redirect");
    assertThatThrownBy(client::getSupported)
        .isInstanceOf(FacilitatorResponseException.class).hasMessageContaining("redirect");
    elsewhere.verify(0, anyRequestedFor(com.github.tomakehurst.wiremock.client.WireMock
        .anyUrl()));
  }
}
