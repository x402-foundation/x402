package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.pending;
import static org.x402.core.Fixtures.supported;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.x402.core.hooks.HookResults.Recovery;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;

/** A {@code settlement_pending} settle outcome is retried once. */
class PendingSettleRetryTest {

  private final FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind(PREPROD)));
  private final FakeFacilitatorClient b = new FakeFacilitatorClient("B", supported(kind(PREPROD)));
  private final List<Throwable> failures = new CopyOnWriteArrayList<>();
  private final X402ResourceServer server =
      X402ResourceServer.builder().facilitators(List.of(a, b)).build();
  private final PaymentRequirements req = Fixtures.requirements();

  PendingSettleRetryTest() {
    server.register(PREPROD, new FakeServerScheme());
    server.onSettleFailure(ctx -> {
      failures.add(ctx.error());
      return Recovery.none();
    });
    server.initialize();
  }

  private SettleResponse settle() {
    return server.settlePayment(Fixtures.payload(req), req, null, null, null,
        SettlePhase.AFTER_HANDLER);
  }

  @Test
  void pendingThenSuccessIsRetriedOnceAtTheSameFacilitatorWithIdenticalInputs() {
    a.thenSettle((p, r) -> pending(PREPROD, "tx1"));
    SettleResponse result = settle();
    assertThat(result.success()).isTrue();
    assertThat(a.settleCalls).hasValue(2);
    assertThat(b.settleCalls).hasValue(0);
    assertThat(a.settledRequirements.get(1)).isEqualTo(a.settledRequirements.get(0));
    assertThat(a.settledPayloads.get(1)).isEqualTo(a.settledPayloads.get(0));
    assertThat(failures).isEmpty();
  }

  @Test
  void aThrownPendingSettleErrorIsRetriedToo() {
    a.thenSettle((p, r) -> {
      throw new SettleException(500, pending(PREPROD, "tx1"));
    });
    assertThat(settle().success()).isTrue();
    assertThat(a.settleCalls).hasValue(2);
  }

  @Test
  void pendingTwiceIsReturnedAfterExactlyOneRetry() {
    a.settleAlways((p, r) -> pending(PREPROD, "tx1"));
    SettleResponse result = settle();
    assertThat(result.isPending()).isTrue();
    assertThat(a.settleCalls).hasValue(2);
    assertThat(failures).singleElement().isInstanceOfSatisfying(SettleException.class,
        e -> assertThat(e.response().errorReason()).isEqualTo("settlement_pending"));
  }

  @Test
  void pendingWithoutATransactionIsNotRetried() {
    a.thenSettle((p, r) -> pending(PREPROD, ""));
    assertThat(settle().isPending()).isTrue();
    assertThat(a.settleCalls).hasValue(1);
  }

  @Test
  void otherFailuresAreNotRetried() {
    a.thenSettle((p, r) -> SettleResponse.failure("insufficient_funds", null, "", PREPROD));
    SettleResponse result = settle();
    assertThat(result.success()).isFalse();
    assertThat(a.settleCalls).hasValue(1);
    assertThat(failures).singleElement().extracting(Throwable::getMessage)
        .isEqualTo("insufficient_funds");

    SettleException thrown = new SettleException(400,
        SettleResponse.failure("invalid", null, "", PREPROD));
    a.thenSettle((p, r) -> {
      throw thrown;
    });
    assertThatThrownBy(this::settle).isSameAs(thrown);
    assertThat(a.settleCalls).hasValue(2);
  }

  @Test
  void aFailedResultWithoutReasonReachesFailureHooksAsSettlementFailed() {
    a.thenSettle((p, r) -> new SettleResponse(false, null, null, null, "", PREPROD, null, null,
        null, null));
    settle();
    assertThat(failures).singleElement().isInstanceOfSatisfying(SettleException.class, e -> {
      assertThat(e.statusCode()).isEqualTo(500);
      assertThat(e.response().errorReason()).isEqualTo("Settlement failed");
    });
  }
}
