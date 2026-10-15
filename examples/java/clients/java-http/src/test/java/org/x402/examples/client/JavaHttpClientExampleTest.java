package org.x402.examples.client;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.client.WireMock;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.x402.core.SchemeNetworkClient;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.SettleResponse;
import org.x402.http.HeaderCodec;
import org.x402.http.X402HttpClient;
import org.x402.mechanisms.cardano.CardanoConstants;
import org.x402.mechanisms.cardano.DefaultAssets;

/**
 * The example's client wiring against a WireMock resource server. A recording scheme stands in
 * for the Cardano wallet, so nothing is signed and no chain is contacted.
 */
class JavaHttpClientExampleTest {

  private static final String PAY_TO = "addr_test1vz09v9yfxguvlp0zsnrpa3tdtm7el8xufp3m5lsm7qxzclgmzkket";

  private WireMockServer server;
  private final RecordingScheme scheme = new RecordingScheme();

  @BeforeEach
  void start() {
    server = new WireMockServer(WireMockConfiguration.options().dynamicPort());
    server.start();
  }

  @AfterEach
  void stop() {
    server.stop();
  }

  @Test
  void aUsdmOfferIsPaidAndThePaymentResponseIsReadable() throws Exception {
    offer("/weather", option(CardanoConstants.USDM_PREPROD_ASSET, "10000"));

    HttpResponse<String> response = send("/weather", false);

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(X402HttpClient.paymentResponse(response)).get()
        .extracting(SettleResponse::success).isEqualTo(true);
    assertThat(scheme.paid).extracting(PaymentRequirements::asset)
        .containsExactly(CardanoConstants.USDM_PREPROD_ASSET);
  }

  @Test
  void payWithAdaPicksTheLovelaceOptionWithinItsCap() throws Exception {
    offer("/report", option(CardanoConstants.USDM_PREPROD_ASSET, "500000"),
        option("lovelace", "1500000"));

    assertThat(send("/report", true).statusCode()).isEqualTo(200);
    assertThat(scheme.paid).extracting(PaymentRequirements::asset).containsExactly("lovelace");
  }

  @Test
  void lovelaceAboveTheCapIsNeverSigned() {
    offer("/expensive", option("lovelace", "5000000"));

    assertThatThrownBy(() -> send("/expensive", true)).hasStackTraceContaining("lovelace");
    assertThat(scheme.paid).isEmpty();
    server.verify(0, getRequestedFor(urlEqualTo("/expensive"))
        .withHeader("PAYMENT-SIGNATURE", WireMock.matching(".+")));
  }

  private HttpResponse<String> send(String path, boolean preferAda) throws Exception {
    URI url = URI.create(base() + path);
    try (X402HttpClient http = JavaHttpClientExample.payingHttpClient(
        JavaHttpClientExample.paymentClient(scheme, preferAda), url)) {
      return http.send(HttpRequest.newBuilder(url).GET().build(),
          HttpResponse.BodyHandlers.ofString());
    }
  }

  private String base() {
    return "http://127.0.0.1:" + server.port();
  }

  private static PaymentRequirements option(String asset, String amount) {
    return new PaymentRequirements("exact", JavaHttpClientExample.NETWORK, asset, amount, PAY_TO,
        300, Map.of());
  }

  /** 402 with the options unless PAYMENT-SIGNATURE is present, then 200 + PAYMENT-RESPONSE. */
  private void offer(String path, PaymentRequirements... options) {
    PaymentRequired required = new PaymentRequired(2, "Payment required",
        ResourceInfo.of(base() + path), List.of(options), null);
    server.stubFor(get(urlEqualTo(path)).withHeader("PAYMENT-SIGNATURE", absent())
        .willReturn(aResponse().withStatus(402)
            .withHeader("PAYMENT-REQUIRED", HeaderCodec.encodePaymentRequired(required))
            .withBody("{}")));
    SettleResponse settled = new SettleResponse(true, null, null, "addr_test1buyer",
        "ab".repeat(32), JavaHttpClientExample.NETWORK, null, null, null, null);
    server.stubFor(get(urlEqualTo(path)).withHeader("PAYMENT-SIGNATURE", WireMock.matching(".+"))
        .willReturn(aResponse().withStatus(200)
            .withHeader("PAYMENT-RESPONSE", HeaderCodec.encodePaymentResponse(settled))
            .withHeader("Content-Type", "application/json")
            .withBody("{\"ok\":true}")));
  }

  /** Records what it is asked to pay; knows USDM as the default asset, like the real scheme. */
  static final class RecordingScheme implements SchemeNetworkClient {
    final List<PaymentRequirements> paid = new ArrayList<>();

    @Override
    public String scheme() {
      return "exact";
    }

    @Override
    public PaymentPayloadResult createPaymentPayload(int x402Version,
        PaymentRequirements requirements, PaymentPayloadContext context) {
      paid.add(requirements);
      return new PaymentPayloadResult(x402Version, Map.of("transaction", "84a400"), null);
    }

    @Override
    public DefaultAsset findDefaultAsset(String asset, String network) {
      return DefaultAssets.find(asset, network);
    }
  }
}
