package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.MAINNET;
import static org.x402.core.Fixtures.PREPROD;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.x402.core.facilitator.InMemoryPendingSettlementStore;
import org.x402.core.facilitator.X402Facilitator;
import org.x402.core.hooks.HookResults.Decision;
import org.x402.core.hooks.HookResults.Recovery;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedResponse;
import org.x402.core.types.VerifyResponse;

/** Facilitator hook result semantics, extension lookup and the pending store. */
class FacilitatorHooksTest {

  private final FakeFacilitatorScheme scheme = new FakeFacilitatorScheme();
  private final X402Facilitator facilitator =
      new X402Facilitator().register(List.of(PREPROD, MAINNET), scheme);
  private final List<String> calls = new CopyOnWriteArrayList<>();
  private final PaymentRequirements req = Fixtures.requirements();

  @Test
  void beforeVerifyAbortAnswersInvalidWithTheReason() {
    facilitator.onBeforeVerify(ctx -> Decision.abort("payee_not_allowed"));
    VerifyResponse v = facilitator.verify(Fixtures.payload(req), req);
    assertThat(v).isEqualTo(VerifyResponse.invalid("payee_not_allowed", null));
    assertThat(scheme.calls).isEmpty();
  }

  @Test
  void beforeSettleAbortThrowsSettleAborted() {
    facilitator.onBeforeSettle(ctx -> Decision.abort("rate_limited"));
    assertThatThrownBy(() -> facilitator.settle(Fixtures.payload(req), req))
        .isInstanceOfSatisfying(SettleAbortedException.class,
            e -> assertThat(e.reason()).isEqualTo("rate_limited"))
        .hasMessage("Settlement aborted: rate_limited");
    assertThat(scheme.calls).isEmpty();
  }

  @Test
  void anInvalidVerdictGoesToFailureHooksAndARecoveryRunsAfterHooks() {
    scheme.verify = (r, c) -> VerifyResponse.invalid("nonce_spent", "already used");
    VerifyResponse recovered = VerifyResponse.valid("recovered");
    facilitator.onVerifyFailure(ctx -> {
      calls.add("failure:" + ctx.error().getMessage());
      return Recovery.recovered(recovered);
    });
    facilitator.onAfterVerify(ctx -> calls.add("after:" + ctx.result().payer()));
    assertThat(facilitator.verify(Fixtures.payload(req), req)).isSameAs(recovered);
    assertThat(calls).containsExactly("failure:nonce_spent: already used", "after:recovered");
  }

  @Test
  void anUnrecoveredInvalidVerdictIsReturnedWithoutAfterHooks() {
    scheme.verify = (r, c) -> VerifyResponse.invalid(null, null);
    facilitator.onVerifyFailure(ctx -> {
      calls.add("failure:" + ctx.error().getMessage());
      return Recovery.none();
    });
    facilitator.onAfterVerify(ctx -> calls.add("after"));
    assertThat(facilitator.verify(Fixtures.payload(req), req).isValid()).isFalse();
    assertThat(calls).containsExactly("failure:Verification failed");
  }

  @Test
  void aThrowingVerifyMayBeRecoveredWithoutAfterHooks() {
    scheme.verify = (r, c) -> {
      throw new IllegalStateException("chain down");
    };
    VerifyResponse recovered = VerifyResponse.invalid("unavailable", null);
    facilitator.onVerifyFailure(ctx -> Recovery.recovered(recovered));
    facilitator.onAfterVerify(ctx -> calls.add("after"));
    assertThat(facilitator.verify(Fixtures.payload(req), req)).isSameAs(recovered);
    assertThat(calls).isEmpty();
  }

  @Test
  void settleFailureHooksMayRecoverOtherwiseTheErrorPropagates() {
    IllegalStateException boom = new IllegalStateException("submit failed");
    scheme.settle = (r, c) -> {
      throw boom;
    };
    assertThatThrownBy(() -> facilitator.settle(Fixtures.payload(req), req)).isSameAs(boom);

    SettleResponse recovered = SettleResponse.failure("submit_failed", null, "", PREPROD);
    facilitator.onSettleFailure(ctx -> {
      calls.add("failure:" + ctx.error().getMessage());
      return Recovery.recovered(recovered);
    });
    assertThat(facilitator.settle(Fixtures.payload(req), req)).isSameAs(recovered);
    assertThat(calls).containsExactly("failure:submit failed");
  }

  @Test
  void afterSettleSeesTheResult() {
    facilitator.onAfterSettle(ctx -> calls.add("after:" + ctx.result().transaction()));
    facilitator.settle(Fixtures.payload(req), req);
    assertThat(calls).containsExactly("after:tx");
  }

  @Test
  void schemesReadExtensionsThroughTheFacilitatorContext() {
    record BatchSigner(String key, String id) implements FacilitatorExtension {}
    facilitator.registerExtension(new BatchSigner("batch", "signer-1"));
    scheme.verify = (r, c) -> VerifyResponse.valid(c.getExtension("batch", BatchSigner.class).id());
    assertThat(facilitator.verify(Fixtures.payload(req), req).payer()).isEqualTo("signer-1");
    assertThat(scheme.contexts.get(0).getExtension("missing")).isNull();
    assertThat(scheme.contexts.get(0).getExtension("batch", FacilitatorExtensionOther.class))
        .isNull();
    assertThat(facilitator.getExtension("batch")).isInstanceOf(BatchSigner.class);
  }

  @Test
  void supportedListsKindsExtensionKeysAndSignersByFamily() {
    facilitator.registerExtension(() -> "bazaar");
    FakeFacilitatorScheme other = new FakeFacilitatorScheme("exact", "eip155:*");
    other.extra = null;
    other.signers = List.of("0xabc");
    facilitator.register("eip155:8453", other);

    SupportedResponse supported = facilitator.getSupported();
    assertThat(supported.kinds()).extracting(k -> k.network())
        .containsExactly(PREPROD, MAINNET, "eip155:8453");
    assertThat(supported.kinds().get(0).extra()).containsEntry("areFeesSponsored", false);
    assertThat(supported.kinds().get(2).extra()).isNull();
    assertThat(supported.extensions()).containsExactly("bazaar");
    assertThat(supported.signers()).containsEntry("cardano:*", List.of("addr_signer"))
        .containsEntry("eip155:*", List.of("0xabc"));
    assertThat(facilitator.getExtensions()).containsExactly("bazaar");
  }

  @Test
  void pendingStoreDeletesOnResolutionAndExpiresAfterItsTtl() {
    MutableClock clock = new MutableClock();
    InMemoryPendingSettlementStore store = new InMemoryPendingSettlementStore(clock);
    store.set("k1", "tx1");
    store.set("k2", "tx2");
    assertThat(store.get("k1")).contains("tx1");
    store.delete("k1");
    assertThat(store.get("k1")).isEmpty();
    assertThat(store.entriesSnapshot()).containsOnlyKeys("k2");

    clock.advance(InMemoryPendingSettlementStore.TTL);
    assertThat(store.get("k2")).contains("tx2");
    clock.advance(Duration.ofMillis(1));
    assertThat(store.get("k2")).isEmpty();
    assertThat(store.entriesSnapshot()).isEmpty();
    assertThat(InMemoryPendingSettlementStore.TTL).isEqualTo(Duration.ofMinutes(5));
    assertThat(new InMemoryPendingSettlementStore().get("x")).isEmpty();
  }

  @Test
  void pendingStoreIsThreadSafe() throws Exception {
    InMemoryPendingSettlementStore store = new InMemoryPendingSettlementStore(new MutableClock());
    ExecutorService pool = Executors.newFixedThreadPool(8);
    for (int t = 0; t < 8; t++) {
      int id = t;
      pool.submit(() -> {
        for (int i = 0; i < 1000; i++) {
          store.set(id + ":" + i, "tx");
          store.get(id + ":" + (i / 2));
          if (i % 2 == 0) {
            store.delete(id + ":" + i);
          }
        }
      });
    }
    pool.shutdown();
    assertThat(pool.awaitTermination(30, TimeUnit.SECONDS)).isTrue();
    assertThat(store.entriesSnapshot()).hasSize(8 * 500);
  }

  interface FacilitatorExtensionOther extends FacilitatorExtension {}

  static final class MutableClock extends Clock {
    private Instant now = Instant.parse("2026-10-12T00:00:00Z");

    void advance(Duration d) {
      now = now.plus(d);
    }

    @Override
    public java.time.ZoneId getZone() {
      return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(java.time.ZoneId zone) {
      return this;
    }

    @Override
    public Instant instant() {
      return now;
    }
  }
}
