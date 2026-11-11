package org.x402.mechanisms.cardano.chain;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.okJson;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;

/** An {@code Error} inside the provider check does not leave later callers waiting on it. */
class BlockfrostTrustErrorRecoveryTest {

  @RegisterExtension
  static WireMockExtension wm = WireMockExtension.newInstance().options(wireMockConfig().dynamicPort()).build();

  /** Throws on its second reading: inside the first tip check. */
  private static final class FailingOnceClock extends Clock {
    final AtomicInteger reads = new AtomicInteger();
    final long millis = 1_655_769_600_000L + 1_000_000L;

    @Override
    public ZoneId getZone() {
      return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(ZoneId zone) {
      return this;
    }

    @Override
    public Instant instant() {
      return Instant.ofEpochMilli(millis());
    }

    @Override
    public long millis() {
      if (reads.incrementAndGet() == 2) {
        throw new AssertionError("clock broke once");
      }
      return millis;
    }
  }

  @Test
  void theNextCallRunsAFreshCheckInsteadOfWaiting() {
    wm.stubFor(get("/blocks/latest").willReturn(okJson("{\"slot\":1}")));
    wm.stubFor(get("/txs/" + "ab".repeat(32) + "/utxos").willReturn(aResponse().withStatus(404)));
    BlockfrostChainBackend backend = new BlockfrostChainBackend(
        BlockfrostChainBackend.Config.builder()
            .network("cardano:preprod")
            .baseUrl(wm.baseUrl() + "/")
            .projectId("preprodKey")
            .requestTimeout(Duration.ofSeconds(5))
            .maxTipAge(Duration.ofDays(3650))
            .clock(new FailingOnceClock())
            .build());
    String ref = "ab".repeat(32) + "#0";

    assertThatThrownBy(() -> backend.getUtxo(ref, "cardano:preprod")).isInstanceOf(AssertionError.class);
    UtxoSnapshot next = assertTimeoutPreemptively(Duration.ofSeconds(3),
        () -> backend.getUtxo(ref, "cardano:preprod"));
    assertThat(next.exists()).isFalse();
  }
}
