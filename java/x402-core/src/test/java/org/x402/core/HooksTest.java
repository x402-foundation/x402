package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.map;
import static org.x402.core.Fixtures.supported;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.x402.core.client.ClientHooks.SchemeClientHooks;
import org.x402.core.client.SpendControls;
import org.x402.core.client.X402Client;
import org.x402.core.client.X402ClientException;
import org.x402.core.hooks.HookResults.AfterVerifyResult;
import org.x402.core.hooks.HookResults.BeforeResult;
import org.x402.core.hooks.HookResults.Decision;
import org.x402.core.hooks.HookResults.Recovery;
import org.x402.core.hooks.HookResults.SkipHandlerDirective;
import org.x402.core.server.ResourceServerExtension;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.server.ServerHooks.SettleResultContext;
import org.x402.core.server.ServerHooks.VerifyContext;
import org.x402.core.server.ServerVerifyResult;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;

/** Server-wide, extension and client hook semantics. */
class HooksTest {

  private final List<String> calls = new CopyOnWriteArrayList<>();
  private final FakeServerScheme scheme = new FakeServerScheme();
  private final FakeFacilitatorClient f = new FakeFacilitatorClient("f", supported(kind(PREPROD)));
  private final X402ResourceServer server = X402ResourceServer.builder().facilitator(f).build();
  private final PaymentRequirements req = Fixtures.requirements();
  private final PaymentPayload payload = Fixtures.payload(req);

  HooksTest() {
    server.register(PREPROD, scheme);
  }

  private ServerVerifyResult verify(Map<String, Object> extensions) {
    server.initialize();
    return server.verifyPayment(payload, req, extensions, "transport");
  }

  private SettleResponse settle(Map<String, Object> extensions) {
    server.initialize();
    return server.settlePayment(payload, req, extensions, "transport", null,
        SettlePhase.AFTER_HANDLER);
  }

  @Test
  void beforeVerifyAbortReturnsInvalidWithoutCallingTheFacilitator() {
    server.onBeforeVerify(ctx -> BeforeResult.abort("blocked", "by policy"));
    ServerVerifyResult v = verify(null);
    assertThat(v.response()).isEqualTo(VerifyResponse.invalid("blocked", "by policy"));
    assertThat(v.verifiedBy()).isNull();
    assertThat(f.verifyCalls).hasValue(0);
  }

  @Test
  void beforeVerifySkipRunsAfterVerifyHooksWithTheSubstitute() {
    VerifyResponse substitute = VerifyResponse.valid("cached");
    server.onBeforeVerify(ctx -> BeforeResult.skip(substitute));
    server.onAfterVerify(ctx -> {
      calls.add("after:" + ctx.result().payer() + ":" + ctx.transportContext());
      return AfterVerifyResult.proceed();
    });
    assertThat(verify(null).response()).isSameAs(substitute);
    assertThat(calls).containsExactly("after:cached:transport");
    assertThat(f.verifyCalls).hasValue(0);
  }

  @Test
  void throwingHooksWarnAndDoNotFailTheRequest() {
    server.onBeforeVerify(ctx -> {
      throw new IllegalStateException("before boom");
    });
    server.onAfterVerify(ctx -> {
      throw new IllegalStateException("after boom");
    });
    server.onBeforeSettle(ctx -> {
      throw new IllegalStateException("before settle boom");
    });
    server.onAfterSettle(ctx -> {
      throw new IllegalStateException("after settle boom");
    });
    server.onVerifiedPaymentCanceled(ctx -> {
      throw new IllegalStateException("cancel boom");
    });
    assertThat(verify(null).isValid()).isTrue();
    assertThat(settle(null).success()).isTrue();
  }

  @Test
  void verifyFailureHooksMayRecoverAndAfterHooksThenSeeTheRecoveredResult() {
    IllegalStateException boom = new IllegalStateException("facilitator down");
    f.verifyAlways((p, r) -> {
      throw boom;
    });
    server.onVerifyFailure(ctx -> {
      calls.add("failure:" + ctx.error().getMessage());
      throw new IllegalStateException("hook boom");
    });
    server.onVerifyFailure(ctx -> Recovery.recovered(VerifyResponse.valid("recovered")));
    server.onAfterVerify(ctx -> {
      calls.add("after:" + ctx.result().payer());
      return AfterVerifyResult.proceed();
    });
    assertThat(verify(null).response().payer()).isEqualTo("recovered");
    assertThat(calls).containsExactly("failure:facilitator down", "after:recovered");
  }

  @Test
  void unrecoveredVerifyFailureRethrowsTheOriginal() {
    IllegalStateException boom = new IllegalStateException("facilitator down");
    f.verifyAlways((p, r) -> {
      throw boom;
    });
    server.onVerifyFailure(ctx -> Recovery.none());
    assertThatThrownBy(() -> verify(null)).isSameAs(boom);
  }

  @Test
  void afterVerifyMaySkipTheHandler() {
    SkipHandlerDirective directive = new SkipHandlerDirective("text/plain", "refunded");
    server.onAfterVerify(ctx -> AfterVerifyResult.skipHandler(directive));
    ServerVerifyResult v = verify(null);
    assertThat(v.isValid()).isTrue();
    assertThat(v.skipHandler()).isEqualTo(directive);

    X402ResourceServer other = X402ResourceServer.builder().facilitator(f).build();
    other.register(PREPROD, scheme);
    other.onAfterVerify(ctx -> AfterVerifyResult.skipHandler(null));
    other.initialize();
    assertThat(other.verifyPayment(payload, req, null, null).skipHandler())
        .isEqualTo(new SkipHandlerDirective(null, null));
  }

  @Test
  void beforeSettleSkipRunsAfterSettleAndSkipsTheFacilitator() {
    SettleResponse substitute = SettleResponse.success("pre-settled", PREPROD, null);
    server.onBeforeSettle(ctx -> BeforeResult.skip(substitute));
    server.onAfterSettle(ctx -> calls.add("after:" + ctx.result().transaction() + ":"
        + ctx.phase().wire()));
    assertThat(settle(null)).isEqualTo(substitute);
    assertThat(calls).containsExactly("after:pre-settled:after-handler");
    assertThat(f.settleCalls).hasValue(0);
  }

  @Test
  void aReturnedFailureGoesThroughSettleFailureHooks() {
    SettleResponse failed = SettleResponse.failure("insufficient_funds", "low", "", PREPROD);
    f.settleAlways((p, r) -> failed);
    server.onAfterSettle(ctx -> calls.add("after"));
    server.onSettleFailure(ctx -> {
      calls.add("failure:" + ctx.error().getMessage());
      return Recovery.none();
    });
    assertThat(settle(null)).isSameAs(failed);
    assertThat(calls).containsExactly("failure:insufficient_funds: low");

    SettleResponse rescued = SettleResponse.success("rescued", PREPROD, null);
    X402ResourceServer other = X402ResourceServer.builder().facilitator(f).build();
    other.register(PREPROD, scheme);
    other.onSettleFailure(ctx -> Recovery.recovered(rescued));
    other.initialize();
    assertThat(other.settlePayment(payload, req, null, null, null, SettlePhase.AFTER_HANDLER))
        .isSameAs(rescued);
  }

  @Test
  void thrownSettleFailuresMayBeRecoveredOtherwiseRethrown() {
    IllegalStateException boom = new IllegalStateException("network");
    f.settleAlways((p, r) -> {
      throw boom;
    });
    server.onSettleFailure(ctx -> {
      throw new IllegalStateException("hook boom");
    });
    assertThatThrownBy(() -> settle(null)).isSameAs(boom);
  }

  @Test
  void schemeEnrichmentOfSettlementIsAdditive() {
    scheme.enrichPayload = ctx -> map("extraField", "v");
    scheme.enrichResponse = ctx -> map("receipt", map("id", 1));
    SettleResponse result = settle(null);
    assertThat(f.settledPayloads.get(0).payload()).containsEntry("extraField", "v")
        .containsEntry("transaction", "tx");
    assertThat(payload.payload()).doesNotContainKey("extraField");
    assertThat(result.extra()).containsEntry("receipt", map("id", 1));

    scheme.enrichPayload = ctx -> map("transaction", "replaced");
    assertThatThrownBy(() -> settle(null))
        .hasMessage("[x402] scheme \"exact\" enrichSettlementPayload violated settlement payload "
            + "enrichment policy: \"transaction\" already exists on the client payload");
  }

  @Test
  void conflictingSettlementResponseEnrichmentIsIgnoredWithAWarning() {
    f.settleAlways((p, r) -> new SettleResponse(true, null, null, null, "tx", PREPROD, null, null,
        null, map("receipt", "facilitator")));
    scheme.enrichResponse = ctx -> map("receipt", "scheme");
    assertThat(settle(null).extra()).containsEntry("receipt", "facilitator");
  }

  @Test
  void extensionHooksRunOnlyWhenTheRouteDeclaresTheExtension() {
    server.registerExtension(new ResourceServerExtension() {
      @Override
      public String key() {
        return "audit";
      }

      @Override
      public BeforeResult<VerifyResponse> onBeforeVerify(Object declaration, VerifyContext ctx) {
        calls.add("ext-before:" + declaration);
        return BeforeResult.proceed();
      }

      @Override
      public Object enrichSettlementResponse(Object declaration, SettleResultContext ctx) {
        return map("audited", true);
      }
    });
    server.onBeforeVerify(ctx -> {
      calls.add("manual-before");
      return BeforeResult.proceed();
    });
    verify(null);
    assertThat(calls).containsExactly("manual-before");
    verify(map("audit", "on"));
    assertThat(calls).containsExactly("manual-before", "manual-before", "ext-before:on");
    assertThat(settle(map("audit", "on")).extensions()).containsEntry("audit", map("audited", true));
    assertThat(server.hasExtension("audit")).isTrue();
    assertThat(server.getExtensions()).hasSize(1);
  }

  @Test
  void extensionDeclarationsAreEnrichedAndFailuresKeepTheDeclaration() {
    server.registerExtension(new ResourceServerExtension() {
      @Override
      public String key() {
        return "bazaar";
      }

      @Override
      public Object enrichDeclaration(Object declaration, Object transportContext) {
        return map("enriched", declaration, "by", transportContext);
      }
    });
    server.registerExtension(new ResourceServerExtension() {
      @Override
      public String key() {
        return "broken";
      }

      @Override
      public Object enrichDeclaration(Object declaration, Object transportContext) {
        throw new IllegalStateException("broken");
      }
    });
    Map<String, Object> enriched = server.enrichExtensions(
        map("bazaar", 1, "broken", 2, "unknown", 3), "ctx");
    assertThat(enriched).containsExactly(Map.entry("bazaar", map("enriched", 1, "by", "ctx")),
        Map.entry("broken", 2), Map.entry("unknown", 3));
  }

  // ---- client hooks ----

  @Test
  void clientBeforeHookMayAbort() {
    X402Client client = new X402Client().register(PREPROD, new FakeClientScheme());
    client.setSpendControls(SpendControls.disabled());
    client.onBeforePaymentCreation(ctx -> Decision.abort("budget"));
    assertThatThrownBy(() -> client.createPaymentPayload(Fixtures.paymentRequired(req)))
        .isInstanceOf(X402ClientException.class)
        .hasMessage("Payment creation aborted: budget");
  }

  @Test
  void clientAfterAndFailureHooksAndSchemeHooksRunInOrder() {
    FakeClientScheme scheme = new FakeClientScheme();
    scheme.hooks = new SchemeClientHooks(ctx -> {
      calls.add("scheme-before");
      return Decision.proceed();
    }, ctx -> calls.add("scheme-after"), null, ctx -> {
      calls.add("scheme-response");
      return false;
    });
    X402Client client = new X402Client().register(PREPROD, scheme);
    client.setSpendControls(SpendControls.disabled());
    client.onBeforePaymentCreation(ctx -> {
      calls.add("before:" + ctx.selectedRequirements().amount());
      return Decision.proceed();
    });
    client.onAfterPaymentCreation(ctx -> calls.add("after:" + ctx.paymentPayload().x402Version()));
    client.onPaymentResponse(ctx -> {
      calls.add("response:" + ctx.settleResponse().transaction());
      return true;
    });
    PaymentRequired required = Fixtures.paymentRequired(req);
    PaymentPayload created = client.createPaymentPayload(required);
    assertThat(calls).containsExactly("before:10000", "scheme-before", "after:2", "scheme-after");
    boolean recovered = client.handlePaymentResponse(
        new org.x402.core.client.ClientHooks.PaymentResponseContext(created, req,
            Fixtures.settled(PREPROD), null, null));
    assertThat(recovered).isTrue();
    assertThat(calls).endsWith("response:tx-cardano:preprod");
  }

  @Test
  void clientFailureHookMayRecoverWithAPayload() {
    FakeClientScheme scheme = new FakeClientScheme();
    scheme.fail = new IllegalStateException("wallet locked");
    PaymentPayload rescue = Fixtures.payload(req);
    X402Client client = new X402Client().register(PREPROD, scheme);
    client.setSpendControls(SpendControls.disabled());
    client.onPaymentCreationFailure(ctx -> {
      calls.add("failure:" + ctx.error().getMessage());
      return Recovery.recovered(rescue);
    });
    assertThat(client.createPaymentPayload(Fixtures.paymentRequired(req))).isSameAs(rescue);
    assertThat(calls).containsExactly("failure:wallet locked");

    X402Client strict = new X402Client().register(PREPROD, scheme);
    strict.setSpendControls(SpendControls.disabled());
    assertThatThrownBy(() -> strict.createPaymentPayload(Fixtures.paymentRequired(req)))
        .isSameAs(scheme.fail);
  }
}
