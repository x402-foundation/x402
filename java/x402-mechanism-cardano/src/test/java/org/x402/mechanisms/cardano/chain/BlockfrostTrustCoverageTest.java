package org.x402.mechanisms.cardano.chain;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.okJson;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;

import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;

/**
 * A caller never passes on a provider check that covered less than it needs: a health probe, or
 * a caller whose identity re-check is due, re-reads {@code /genesis} even while a tip-only check
 * is in flight.
 */
class BlockfrostTrustCoverageTest {

  @RegisterExtension
  static WireMockExtension wm = WireMockExtension.newInstance().options(wireMockConfig().dynamicPort()).build();

  private static final String REF = "ab".repeat(32) + "#0";

  private static final class MovableClock extends Clock {
    final AtomicLong millis = new AtomicLong(1_655_769_600_000L + 1_000_000L);

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
      return Instant.ofEpochMilli(millis.get());
    }
  }

  private final MovableClock clock = new MovableClock();
  private BlockfrostChainBackend backend;

  @BeforeEach
  void checkedOnce() {
    wm.stubFor(get("/genesis").willReturn(okJson("{\"network_magic\":1}")));
    wm.stubFor(get("/blocks/latest").willReturn(okJson("{\"slot\":1}")));
    wm.stubFor(get("/txs/" + "ab".repeat(32) + "/utxos").willReturn(aResponse().withStatus(404)));
    backend = new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder()
        .network("cardano:preprod")
        .baseUrl(wm.baseUrl() + "/")
        .projectId("preprodKey")
        .networkMagic(1)
        .requestTimeout(Duration.ofSeconds(5))
        .maxTipAge(Duration.ofDays(3650))
        .clock(clock)
        .build());
    backend.getUtxo(REF, "cardano:preprod");
    wm.verify(1, getRequestedFor(urlEqualTo("/genesis")));
  }

  /** Starts a tip-only check (the tip is due, the identity is not) whose read takes a second. */
  private CompletableFuture<Void> slowTipOnlyCheck() throws InterruptedException {
    wm.stubFor(get("/blocks/latest").willReturn(okJson("{\"slot\":1}").withFixedDelay(1_000)));
    clock.millis.addAndGet(6_000);
    CompletableFuture<Void> running = CompletableFuture.runAsync(
        () -> backend.getUtxo(REF, "cardano:preprod"));
    TimeUnit.MILLISECONDS.sleep(300);
    return running;
  }

  @Test
  void aHealthProbeReReadsTheIdentityInsteadOfJoiningATipOnlyCheck() throws Exception {
    CompletableFuture<Void> running = slowTipOnlyCheck();
    backend.checkHealth("cardano:preprod");
    running.get(10, TimeUnit.SECONDS);
    wm.verify(2, getRequestedFor(urlEqualTo("/genesis")));
  }

  @Test
  void aCallerWhoseIdentityIsDueRunsItsOwnCheckAfterATipOnlyOne() throws Exception {
    CompletableFuture<Void> running = slowTipOnlyCheck();
    clock.millis.addAndGet(30_000);
    backend.getUtxo(REF, "cardano:preprod");
    running.get(10, TimeUnit.SECONDS);
    wm.verify(2, getRequestedFor(urlEqualTo("/genesis")));
  }
}
