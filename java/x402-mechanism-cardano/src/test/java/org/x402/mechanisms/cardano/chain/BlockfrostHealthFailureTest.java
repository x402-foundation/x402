package org.x402.mechanisms.cardano.chain;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.okJson;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;

/**
 * A health probe that finds the provider on another network withdraws the passing checks it had,
 * so the very next read refuses that provider instead of trusting it until the window lapses.
 */
class BlockfrostHealthFailureTest {

  @RegisterExtension
  static WireMockExtension wm = WireMockExtension.newInstance().options(wireMockConfig().dynamicPort()).build();

  @Test
  void theNextReadAfterAFailedProbeReChecksTheProvider() {
    wm.stubFor(get("/genesis").willReturn(okJson("{\"network_magic\":1}")));
    wm.stubFor(get("/blocks/latest").willReturn(okJson("{\"slot\":1}")));
    wm.stubFor(get("/txs/" + "ab".repeat(32) + "/utxos").willReturn(aResponse().withStatus(404)));
    BlockfrostChainBackend backend = new BlockfrostChainBackend(
        BlockfrostChainBackend.Config.builder()
            .network("cardano:preprod")
            .baseUrl(wm.baseUrl() + "/")
            .projectId("preprodKey")
            .networkMagic(1)
            .requestTimeout(Duration.ofSeconds(5))
            .maxTipAge(Duration.ofDays(3650))
            .clock(Clock.fixed(Instant.ofEpochMilli(1_655_769_600_000L + 1_000_000L),
                ZoneOffset.UTC))
            .build());
    String ref = "ab".repeat(32) + "#0";
    backend.getUtxo(ref, "cardano:preprod");

    wm.stubFor(get("/genesis").willReturn(okJson("{\"network_magic\":764824073}")));
    assertThatThrownBy(() -> backend.checkHealth("cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);

    assertThatThrownBy(() -> backend.getUtxo(ref, "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class)
        .hasMessageContaining("configured network");
  }
}
