package org.x402.examples.restclient;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.matching;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.RestClient;
import org.x402.core.SchemeNetworkClient;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.SettleResponse;
import org.x402.http.HeaderCodec;
import org.x402.mechanisms.cardano.CardanoConstants;
import org.x402.mechanisms.cardano.DefaultAssets;
import org.x402.spring.X402ClientCustomizer;

/**
 * The example's YAML against a WireMock resource server. A recording scheme replaces the Cardano
 * wallet (a customizer registered after the auto-configured one wins), so nothing is signed and
 * the wallet never queries Blockfrost.
 */
@SpringBootTest(properties = {
    "example.call-on-startup=false",
    "BUYER_MNEMONIC=abandon abandon abandon abandon abandon abandon abandon abandon abandon "
        + "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon "
        + "abandon abandon abandon abandon art",
    "BLOCKFROST_PREPROD_PROJECT_ID=preprodExampleTest"})
class RestClientExampleTest {

  private static final String NETWORK = "cardano:preprod";
  private static final String PAY_TO =
      "addr_test1vz09v9yfxguvlp0zsnrpa3tdtm7el8xufp3m5lsm7qxzclgmzkket";
  private static final List<PaymentRequirements> PAID = new CopyOnWriteArrayList<>();
  private static final WireMockServer SERVER =
      new WireMockServer(WireMockConfiguration.options().dynamicPort());

  static {
    SERVER.start();
  }

  @DynamicPropertySource
  static void resourceServer(DynamicPropertyRegistry registry) {
    registry.add("RESOURCE_SERVER_URL", () -> "http://127.0.0.1:" + SERVER.port());
  }

  @AfterAll
  static void stop() {
    SERVER.stop();
  }

  @TestConfiguration
  static class RecordingWallet {
    @Bean
    X402ClientCustomizer recordingScheme() {
      return client -> client.register(NETWORK, new SchemeNetworkClient() {
        @Override
        public String scheme() {
          return "exact";
        }

        @Override
        public PaymentPayloadResult createPaymentPayload(int x402Version,
            PaymentRequirements requirements, PaymentPayloadContext context) {
          PAID.add(requirements);
          return new PaymentPayloadResult(x402Version, Map.of("transaction", "84a400"), null);
        }

        @Override
        public DefaultAsset findDefaultAsset(String asset, String network) {
          return DefaultAssets.find(asset, network);
        }
      });
    }
  }

  @Autowired
  PaidApi api;

  @Autowired
  RestClient selfBuiltRestClient;

  @BeforeEach
  void reset() {
    SERVER.resetAll();
    PAID.clear();
  }

  @Test
  void theHttpExchangeInterfacePaysAUsdmOffer() {
    offer("/weather", option(CardanoConstants.USDM_PREPROD_ASSET, "10000"));

    ResponseEntity<Map<String, Object>> response = api.weather();

    assertThat(response.getStatusCode().value()).isEqualTo(200);
    assertThat(response.getBody()).containsEntry("ok", true);
    assertThat(HeaderCodec.decodePaymentResponse(
        response.getHeaders().getFirst("PAYMENT-RESPONSE")).success()).isTrue();
    assertThat(PAID).extracting(PaymentRequirements::asset)
        .containsExactly(CardanoConstants.USDM_PREPROD_ASSET);
  }

  @Test
  void aSelfBuiltRestClientWithTheDecoratedFactoryPaysToo() {
    offer("/weather", option(CardanoConstants.USDM_PREPROD_ASSET, "10000"));

    ResponseEntity<String> response = selfBuiltRestClient.get().uri("/weather").retrieve()
        .toEntity(String.class);

    assertThat(response.getStatusCode().value()).isEqualTo(200);
    assertThat(PAID).hasSize(1);
  }

  @Test
  void lovelaceIsPaidBecauseItIsAnAllowedAsset() {
    offer("/report", option("lovelace", "1500000"));

    assertThat(api.report().getStatusCode().value()).isEqualTo(200);
    assertThat(PAID).extracting(PaymentRequirements::asset).containsExactly("lovelace");
  }

  @Test
  void lovelaceAboveTheConfiguredCapIsNeverSigned() {
    offer("/report", option("lovelace", "5000000"));

    assertThatThrownBy(api::report).hasStackTraceContaining("lovelace");
    assertThat(PAID).isEmpty();
    SERVER.verify(0, getRequestedFor(urlEqualTo("/report"))
        .withHeader("PAYMENT-SIGNATURE", matching(".+")));
  }

  private static PaymentRequirements option(String asset, String amount) {
    return new PaymentRequirements("exact", NETWORK, asset, amount, PAY_TO, 300, Map.of());
  }

  private static void offer(String path, PaymentRequirements... options) {
    PaymentRequired required = new PaymentRequired(2, "Payment required",
        ResourceInfo.of("http://127.0.0.1:" + SERVER.port() + path), List.of(options), null);
    SERVER.stubFor(get(urlEqualTo(path)).withHeader("PAYMENT-SIGNATURE", absent())
        .willReturn(aResponse().withStatus(402)
            .withHeader("PAYMENT-REQUIRED", HeaderCodec.encodePaymentRequired(required))
            .withHeader("Content-Type", "application/json").withBody("{}")));
    SettleResponse settled = new SettleResponse(true, null, null, "addr_test1buyer",
        "ab".repeat(32), NETWORK, null, null, null, null);
    SERVER.stubFor(get(urlEqualTo(path)).withHeader("PAYMENT-SIGNATURE", matching(".+"))
        .willReturn(aResponse().withStatus(200)
            .withHeader("PAYMENT-RESPONSE", HeaderCodec.encodePaymentResponse(settled))
            .withHeader("Content-Type", "application/json").withBody("{\"ok\":true}")));
  }
}
