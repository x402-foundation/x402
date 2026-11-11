package org.x402.mechanisms.cardano.chain;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.assertj.core.api.Assertions.assertThat;

import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;

/**
 * A failing provider check runs once for every caller waiting on it, outside the lock, and its
 * failure is answered again for a moment: a hanging tip read costs one request, not one per caller.
 */
class BlockfrostTrustSingleFlightTest {

  @RegisterExtension
  static WireMockExtension wm = WireMockExtension.newInstance().options(wireMockConfig().dynamicPort()).build();

  private static final Clock CLOCK = Clock.fixed(Instant.ofEpochMilli(1_655_769_600_000L + 1_000_000L), ZoneOffset.UTC);

  @Test
  void concurrentCallersShareOneFailingTipCheck() throws Exception {
    wm.stubFor(get("/blocks/latest").willReturn(aResponse().withStatus(500).withBody("down")
        .withFixedDelay(800)));
    BlockfrostChainBackend backend = new BlockfrostChainBackend(
        BlockfrostChainBackend.Config.builder()
            .network("cardano:preprod")
            .baseUrl(wm.baseUrl() + "/")
            .projectId("preprodKey")
            .requestTimeout(Duration.ofSeconds(5))
            .maxTipAge(Duration.ofMinutes(5))
            .clock(CLOCK)
            .build());

    ExecutorService pool = Executors.newFixedThreadPool(10);
    try {
      List<Callable<Throwable>> calls = new ArrayList<>();
      for (int i = 0; i < 10; i++) {
        calls.add(() -> {
          try {
            backend.getUtxo("ab".repeat(32) + "#0", "cardano:preprod");
            return null;
          } catch (RuntimeException e) {
            return e;
          }
        });
      }
      long start = System.nanoTime();
      List<Future<Throwable>> results = pool.invokeAll(calls, 30, TimeUnit.SECONDS);
      long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);

      for (Future<Throwable> result : results) {
        assertThat(result.get()).isInstanceOf(ChainLookupException.class);
      }
      wm.verify(1, getRequestedFor(urlEqualTo("/blocks/latest")));
      assertThat(elapsedMs).isLessThan(4_000L);
    } finally {
      pool.shutdownNow();
    }
  }
}
