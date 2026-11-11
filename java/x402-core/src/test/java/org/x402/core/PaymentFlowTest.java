package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.PAY_TO;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.map;
import static org.x402.core.Fixtures.supported;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.x402.core.server.CancelOptions;
import org.x402.core.server.CompletedSettlement;
import org.x402.core.server.FacilitatorRoute;
import org.x402.core.server.PaymentCancellationDispatcher;
import org.x402.core.server.PaymentFlows;
import org.x402.core.server.ResourceConfig;
import org.x402.core.server.ServerHooks.CancellationReason;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.server.ServerHooks.VerifiedPaymentCanceledContext;
import org.x402.core.server.SettlementRouting;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.Money;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;

/** Payment flows and the cancel dispatch. */
class PaymentFlowTest {

  private static FakeServerScheme schemeWithFlows() {
    FakeServerScheme scheme = new FakeServerScheme();
    scheme.flows = new java.util.LinkedHashMap<>();
    scheme.flows.put("default", PaymentFlow.Config.authorizationOnly());
    scheme.flows.put("escrow", new PaymentFlow.Config(
        List.of(PaymentFlow.ESCROW, PaymentFlow.UPFRONT), PaymentFlow.ESCROW));
    return scheme;
  }

  @Test
  void phasesMatchTsPaymentFlows() {
    assertThat(PaymentFlow.ESCROW.verifyBeforeHandler()).isFalse();
    assertThat(PaymentFlow.ESCROW.settleBeforeHandler()).isTrue();
    assertThat(PaymentFlow.ESCROW.settleAfterHandler()).isTrue();
    assertThat(PaymentFlow.UPFRONT.settleAfterHandler()).isFalse();
  }

  @Test
  void resolveUsesTheDefaultMethodUnlessExtraOverridesIt() {
    FakeServerScheme scheme = schemeWithFlows();
    PaymentRequirements plain = Fixtures.requirements();
    assertThat(PaymentFlows.resolve(scheme, plain))
        .isEqualTo(new PaymentFlows.Resolved("default", PaymentFlow.AUTHORIZATION));
    PaymentRequirements escrow = plain.withExtra("assetTransferMethod", "escrow");
    assertThat(PaymentFlows.resolve(scheme, escrow).flow()).isEqualTo(PaymentFlow.ESCROW);
    assertThat(PaymentFlows.resolve(scheme, escrow.withExtra(map("assetTransferMethod", "escrow",
        "paymentFlow", "upfront"))).flow()).isEqualTo(PaymentFlow.UPFRONT);
  }

  @Test
  void unsupportedMethodsAndFlowsFailWithTsMessages() {
    FakeServerScheme scheme = schemeWithFlows();
    assertThatThrownBy(() -> PaymentFlows.resolve(scheme,
        Fixtures.requirements().withExtra("assetTransferMethod", "masumi")))
        .hasMessage("[x402] Scheme \"exact\" does not support assetTransferMethod \"masumi\". "
            + "Supported: default, escrow.");
    assertThatThrownBy(() -> PaymentFlows.resolve(scheme,
        Fixtures.requirements().withExtra("paymentFlow", "upfront")))
        .hasMessage("[x402] Scheme \"exact\" assetTransferMethod \"default\" does not support "
            + "paymentFlow \"upfront\". Supported: authorization (default: authorization).");
    assertThatThrownBy(() -> PaymentFlows.resolve(scheme,
        Fixtures.requirements().withExtra("paymentFlow", "nonsense")))
        .hasMessageContaining("does not support paymentFlow \"nonsense\"");
  }

  @Test
  void wireExtraStripsTheSdkDefaultMethodAndAnnouncesNonAuthorizationFlows() {
    assertThat(PaymentFlows.applyWireExtra(map("assetTransferMethod", "default", "x", 1),
        new PaymentFlows.Resolved("default", PaymentFlow.AUTHORIZATION)))
        .containsExactly(Map.entry("x", 1));
    assertThat(PaymentFlows.applyWireExtra(map("assetTransferMethod", "escrow"),
        new PaymentFlows.Resolved("escrow", PaymentFlow.ESCROW)))
        .containsExactly(Map.entry("assetTransferMethod", "escrow"),
            Map.entry("paymentFlow", "escrow"));
  }

  @Test
  void builtRequirementsCarryTheFlowAndNonAuthorizationFlowsSkipFacilitatorVerify() {
    FakeFacilitatorClient f = new FakeFacilitatorClient("f", supported(kind(PREPROD)));
    X402ResourceServer server = X402ResourceServer.builder().facilitator(f).build();
    server.register(PREPROD, schemeWithFlows());
    server.initialize();
    PaymentRequirements r = server.buildPaymentRequirements(new ResourceConfig("exact", PREPROD,
        PAY_TO, new Money("$1"), null, map("assetTransferMethod", "escrow"), null)).get(0);
    assertThat(r.extra()).containsEntry("paymentFlow", "escrow");
    PaymentPayload p = Fixtures.payload(r);
    assertThat(server.getPaymentFlow(p, r)).isEqualTo(PaymentFlow.ESCROW);
    assertThat(server.verifyPayment(p, r, null, null).isValid()).isTrue();
    assertThat(f.verifyCalls).hasValue(0);
    assertThatThrownBy(() -> server.getPaymentFlow(p, Fixtures.requirements("eip155:1", "1")))
        .hasMessage("[x402] No server implementation registered for scheme: exact, network: "
            + "eip155:1");
  }

  @Test
  void cancelDispatchFiresOnceAndSettlesOnCancelOnlyAfterABeforeHandlerSettle() {
    FakeServerScheme scheme = schemeWithFlows();
    List<VerifiedPaymentCanceledContext> seen = new CopyOnWriteArrayList<>();
    scheme.onCancel = ctx -> Fixtures.requirements(PREPROD, "1");
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind(PREPROD)));
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", supported(kind(PREPROD)));
    X402ResourceServer server = X402ResourceServer.builder().facilitators(List.of(a, b)).build();
    server.register(PREPROD, scheme);
    server.onVerifiedPaymentCanceled(seen::add);
    server.initialize();
    PaymentRequirements r = Fixtures.requirements();
    PaymentPayload p = Fixtures.payload(r);

    PaymentCancellationDispatcher noSettle = server.createPaymentCancellationDispatcher(p, r, null,
        null, List.of(), SettlementRouting.auto());
    assertThat(noSettle.cancel(new CancelOptions(CancellationReason.HANDLER_FAILED, null, 500)))
        .isNull();
    assertThat(seen).singleElement().satisfies(c -> {
      assertThat(c.reason()).isEqualTo(CancellationReason.HANDLER_FAILED);
      assertThat(c.responseStatus()).isEqualTo(500);
    });

    PaymentCancellationDispatcher refund = server.createPaymentCancellationDispatcher(p, r, null,
        null, List.of(SettlePhase.BEFORE_HANDLER),
        new SettlementRouting(FacilitatorRoute.auto(), "B", null));
    IllegalStateException err = new IllegalStateException("handler threw");
    SettleResponse first = refund.cancel(new CancelOptions(CancellationReason.HANDLER_THREW, err,
        null));
    SettleResponse second = refund.cancel(new CancelOptions(CancellationReason.HANDLER_FAILED,
        null, 500));
    assertThat(first.success()).isTrue();
    assertThat(second).isSameAs(first);
    assertThat(seen).hasSize(2);
    assertThat(seen.get(1).error()).isSameAs(err);
    assertThat(seen.get(1).settledPhases()).containsExactly(SettlePhase.BEFORE_HANDLER);
    assertThat(b.settleCalls).hasValue(1);
    assertThat(b.settledRequirements.get(0).amount()).isEqualTo("1");
    assertThat(a.settleCalls).hasValue(0);
  }

  @Test
  void aFailedSettleOnCancelIsReturnedNotThrown() {
    FakeServerScheme scheme = schemeWithFlows();
    scheme.onCancel = ctx -> Fixtures.requirements(PREPROD, "1");
    FakeFacilitatorClient f = new FakeFacilitatorClient("f", supported(kind(PREPROD)))
        .settleAlways((p, r) -> {
          throw new SettleException(400, SettleResponse.failure("refund_failed", "nope", "",
              PREPROD));
        });
    X402ResourceServer server = X402ResourceServer.builder().facilitator(f).build();
    server.register(PREPROD, scheme);
    server.initialize();
    PaymentRequirements r = Fixtures.requirements();
    SettleResponse result = server.createPaymentCancellationDispatcher(Fixtures.payload(r), r,
        null, null, List.of(SettlePhase.BEFORE_HANDLER), SettlementRouting.auto())
        .cancel(new CancelOptions(CancellationReason.HANDLER_FAILED, null, 500));
    assertThat(result.success()).isFalse();
    assertThat(result.errorReason()).isEqualTo("refund_failed");
    assertThat(result.errorMessage()).isEqualTo("nope");
    assertThat(result.transaction()).isEmpty();
    assertThat(result.network()).isEqualTo(PREPROD);
  }

  @Test
  void failurePathSettlementFollowsTs() {
    PaymentRequirements r = Fixtures.requirements();
    SettleResponse deposit = new SettleResponse(true, null, null, null, "deposit-tx", PREPROD,
        "10000", null, null, null);
    CompletedSettlement before = new CompletedSettlement(SettlePhase.BEFORE_HANDLER,
        PaymentFlow.ESCROW, deposit, r);
    SettleResponse okCancel = SettleResponse.success("refund", PREPROD, null);
    SettleResponse failedCancel = new SettleResponse(false, "refund_failed", "m", "payer", "x",
        PREPROD, null, null, null, map("k", "v"));
    PaymentPayload channel = new PaymentPayload(2, null, r, map("channelId", "ch-1"), null);

    assertThat(PaymentFlows.resolveFailurePathSettlement(okCancel, before, channel))
        .isSameAs(okCancel);
    SettleResponse receipt = PaymentFlows.resolveFailurePathSettlement(failedCancel, before,
        channel);
    assertThat(receipt.success()).isFalse();
    assertThat(receipt.transaction()).isEmpty();
    assertThat(receipt.payer()).isEqualTo("payer");
    assertThat(receipt.extra()).containsExactly(Map.entry("k", "v"),
        Map.entry("depositTransaction", "deposit-tx"), Map.entry("depositAmount", "10000"),
        Map.entry("channelId", "ch-1"));
    assertThat(PaymentFlows.resolveFailurePathSettlement(null, before, channel))
        .isSameAs(deposit);
    assertThat(PaymentFlows.resolveFailurePathSettlement(null, null, channel)).isNull();
  }
}
