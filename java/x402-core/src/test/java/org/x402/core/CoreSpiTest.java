package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.hooks.HookResults.Abort;
import org.x402.core.hooks.HookResults.AfterVerifyResult;
import org.x402.core.hooks.HookResults.BeforeResult;
import org.x402.core.hooks.HookResults.Decision;
import org.x402.core.hooks.HookResults.Recovered;
import org.x402.core.hooks.HookResults.Recovery;
import org.x402.core.hooks.HookResults.Skip;
import org.x402.core.hooks.HookResults.SkipHandler;
import org.x402.core.hooks.HookResults.SkipHandlerDirective;
import org.x402.core.json.X402Json;
import org.x402.core.server.ServerHooks;
import org.x402.core.server.ServerHooks.CancellationReason;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.Money;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedKind;
import org.x402.core.types.VerifyResponse;
import org.x402.http.HeaderCodec;

class CoreSpiTest {

  private static PaymentRequirements req() {
    return new PaymentRequirements("exact", "cardano:preprod", "lovelace", "1", "addr", 300, null);
  }

  @Test
  void paymentFlowsCarryTsPhasesAndNames() {
    assertThat(PaymentFlow.AUTHORIZATION.verifyBeforeHandler()).isTrue();
    assertThat(PaymentFlow.AUTHORIZATION.settleAfterHandler()).isTrue();
    assertThat(PaymentFlow.AUTHORIZATION.settleBeforeHandler()).isFalse();
    assertThat(PaymentFlow.UPFRONT.settleBeforeHandler()).isTrue();
    assertThat(PaymentFlow.ESCROW.verifyBeforeHandler()).isFalse();
    assertThat(PaymentFlow.fromWire("escrow")).isEqualTo(PaymentFlow.ESCROW);
    assertThat(PaymentFlow.fromWire("nope")).isNull();
    assertThat(X402Json.write(PaymentFlow.UPFRONT)).isEqualTo("\"upfront\"");
    assertThat(PaymentFlow.Config.authorizationOnly().defaultFlow())
        .isEqualTo(PaymentFlow.AUTHORIZATION);
    assertThatThrownBy(() -> new PaymentFlow.Config(List.of(PaymentFlow.UPFRONT),
        PaymentFlow.AUTHORIZATION)).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void requirementsWithersKeepOrderAndImmutability() {
    PaymentRequirements r = req().withExtra("a", 1).withExtra("b", null);
    assertThat(r.extra()).containsExactly(Map.entry("a", 1), new java.util.AbstractMap
        .SimpleEntry<>("b", null));
    assertThat(r.withAmount("2").amount()).isEqualTo("2");
    assertThat(r.withPayTo("x").payTo()).isEqualTo("x");
    assertThat(req().extra()).isEmpty();
    assertThatThrownBy(() -> r.extra().put("c", 1)).isInstanceOf(UnsupportedOperationException.class);
    assertThat(X402Json.write(req())).endsWith("\"extra\":{}}");
  }

  @Test
  void responseFactories() {
    SettleResponse ok = SettleResponse.success("tx", "cardano:preprod", "payer");
    assertThat(ok.success()).isTrue();
    assertThat(ok.isPending()).isFalse();
    SettleResponse fail = SettleResponse.failure("r", "m", null, "cardano:preprod");
    assertThat(fail.transaction()).isEmpty();
    SettleResponse pending = SettleResponse.failure(SettleResponse.SETTLEMENT_PENDING, null, "tx",
        "n");
    assertThat(pending.isPending()).isTrue();
    assertThat(VerifyResponse.valid("p").isValid()).isTrue();
    assertThat(VerifyResponse.invalid("r", "m").invalidReason()).isEqualTo("r");
    assertThat(X402Json.write(VerifyResponse.valid(null))).isEqualTo("{\"isValid\":true}");
  }

  @Test
  void exceptionsFormatLikeTs() {
    VerifyException v = new VerifyException(400, VerifyResponse.invalid("bad", "detail"));
    assertThat(v).hasMessage("bad: detail");
    assertThat(v.statusCode()).isEqualTo(400);
    assertThat(v.response().invalidReason()).isEqualTo("bad");
    assertThat(new VerifyException(500, VerifyResponse.invalid(null, null)))
        .hasMessage("unknown reason");
    SettleException s = new SettleException(502, SettleResponse.failure("r", null, "", "n"));
    assertThat(s).hasMessage("r");
    assertThat(s.statusCode()).isEqualTo(502);
    assertThat(s.response().errorReason()).isEqualTo("r");
    FacilitatorResponseException.Timeout t = new FacilitatorResponseException.Timeout("settle", 90);
    assertThat(t.operation()).isEqualTo("settle");
    assertThat(t.timeoutMillis()).isEqualTo(90);
    assertThat(t.statusCode()).isZero();
    assertThat(new SettleAbortedException("why")).hasMessage("Settlement aborted: why");
    assertThat(new SettleAbortedException("why").reason()).isEqualTo("why");
  }

  @Test
  void hookResults() {
    assertThat(Decision.proceed()).hasToString("Proceed");
    assertThat(Decision.abort("x")).isEqualTo(new Abort("x", null));
    BeforeResult<String> skip = BeforeResult.skip("r");
    assertThat(((Skip<String>) skip).result()).isEqualTo("r");
    assertThat(BeforeResult.<String>proceed()).isSameAs(Decision.proceed());
    assertThat(BeforeResult.abort("a", "m")).isInstanceOf(Abort.class);
    assertThat(AfterVerifyResult.proceed()).isSameAs(Decision.proceed());
    assertThat(AfterVerifyResult.abort("a", null)).isInstanceOf(Abort.class);
    SkipHandlerDirective d = new SkipHandlerDirective("text/plain", "hi");
    assertThat(((SkipHandler) AfterVerifyResult.skipHandler(d)).response()).isEqualTo(d);
    Recovery<String> rec = Recovery.recovered("v");
    assertThat(((Recovered<String>) rec).value()).isEqualTo("v");
    assertThat(Recovery.none()).hasToString("NotRecovered");
    assertThatThrownBy(() -> new Abort(null, null)).isInstanceOf(NullPointerException.class);
  }

  @Test
  void serverEnumsExposeTsNames() {
    assertThat(SettlePhase.BEFORE_HANDLER.wire()).isEqualTo("before-handler");
    assertThat(SettlePhase.CANCEL.wire()).isEqualTo("cancel");
    assertThat(CancellationReason.HANDLER_FAILED.wire()).isEqualTo("handler_failed");
    assertThat(ServerHooks.SchemeServerHooks.NONE.onBeforeVerify()).isNull();
  }

  @Test
  void spiDefaults() {
    SchemeNetworkServer server = new SchemeNetworkServer() {
      @Override
      public String scheme() {
        return "exact";
      }

      @Override
      public String defaultAssetTransferMethod() {
        return "default";
      }

      @Override
      public Map<String, PaymentFlow.Config> paymentFlows() {
        return Map.of();
      }

      @Override
      public AssetAmount parsePrice(org.x402.core.types.Price price, String network) {
        return AssetAmount.of("lovelace", "1");
      }

      @Override
      public PaymentRequirements enhancePaymentRequirements(
          PaymentRequirements requirements, SupportedKind kind, List<String> exts) {
        return requirements;
      }
    };
    assertThat(server.schemeHooks()).isNull();
    assertThat(server.dynamicExtraFields()).isEmpty();
    assertThat(server.validateFacilitatorSupport("n", null, List.of())).isNull();
    assertThat(server.getAssetDecimals("a", "n")).isNull();
    assertThat(server.enrichPaymentRequiredResponse(null)).isNull();
    assertThat(server.enrichSettlementPayload(null)).isNull();
    assertThat(server.enrichSettlementResponse(null)).isNull();
    assertThat(server.settleOnCancel(null)).isNull();

    SchemeNetworkClient client = new SchemeNetworkClient() {
      @Override
      public String scheme() {
        return "exact";
      }

      @Override
      public PaymentPayloadResult createPaymentPayload(
          int v, PaymentRequirements r, PaymentPayloadContext c) {
        return new PaymentPayloadResult(v, Map.of(), null);
      }
    };
    assertThat(client.schemeHooks()).isNull();
    assertThat(client.findDefaultAsset("a", "n")).isNull();

    FacilitatorExtension ext = () -> "bazaar";
    FacilitatorContext ctx = key -> "bazaar".equals(key) ? ext : null;
    assertThat(ctx.getExtension("bazaar", FacilitatorExtension.class)).isSameAs(ext);
    assertThat(ctx.getExtension("other", FacilitatorExtension.class)).isNull();
    assertThat(FacilitatorContext.EMPTY.getExtension("x")).isNull();
  }

  @Test
  void valueHelpers() {
    assertThat(Money.of(new BigDecimal("1.500")).value()).isEqualTo("1.5");
    assertThat(AssetAmount.of("lovelace", "5").extra()).isNull();
    assertThat(ResourceInfo.of("https://x").url()).isEqualTo("https://x");
    assertThatThrownBy(() -> X402Json.read("{", VerifyResponse.class))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(X402Json.convert(Map.of("isValid", true), VerifyResponse.class).isValid()).isTrue();
    assertThatThrownBy(() -> HeaderCodec.decodePaymentRequired("not base64!"))
        .hasMessage("Invalid payment required header");
    assertThatThrownBy(() -> HeaderCodec.decodePaymentSignature(null))
        .hasMessage("Invalid payment signature header");
    assertThatThrownBy(() -> HeaderCodec.decodePaymentResponse("a"))
        .hasMessage("Invalid payment response header");
  }

  @Test
  void contextsCarryTheirFields() {
    var payload = new org.x402.core.types.PaymentPayload(2, null, req(), Map.of(), null);
    var ok = SettleResponse.success("tx", "n", null);
    var err = new IllegalStateException("x");
    assertThat(new ServerHooks.VerifyContext(payload, req(), Map.of(), "t").transportContext())
        .isEqualTo("t");
    assertThat(new ServerHooks.VerifyResultContext(payload, req(), Map.of(), null,
        VerifyResponse.valid(null)).result().isValid()).isTrue();
    assertThat(new ServerHooks.VerifyFailureContext(payload, req(), Map.of(), null, err).error())
        .isSameAs(err);
    assertThat(new ServerHooks.SettleContext(payload, req(), Map.of(), SettlePhase.AFTER_HANDLER,
        null).phase()).isEqualTo(SettlePhase.AFTER_HANDLER);
    assertThat(new ServerHooks.SettleResultContext(payload, req(), Map.of(), SettlePhase.CANCEL,
        null, ok).result()).isSameAs(ok);
    assertThat(new ServerHooks.SettleFailureContext(payload, req(), Map.of(),
        SettlePhase.BEFORE_HANDLER, null, err).error()).isSameAs(err);
    assertThat(new ServerHooks.VerifiedPaymentCanceledContext(payload, req(), Map.of(),
        SettlePhase.CANCEL, null, CancellationReason.HANDLER_THREW, err, 500,
        List.of(SettlePhase.BEFORE_HANDLER)).settledPhases()).hasSize(1);
    assertThat(new SchemeNetworkServer.PaymentRequiredContext(List.of(req()), payload,
        ResourceInfo.of("u"), "e", null, null).error()).isEqualTo("e");
    assertThat(new org.x402.core.facilitator.FacilitatorHooks.SettleResultContext(payload, req(),
        ok).result()).isSameAs(ok);
    assertThat(new org.x402.core.facilitator.FacilitatorHooks.VerifyFailureContext(payload, req(),
        err).error()).isSameAs(err);
    assertThat(new org.x402.core.client.ClientHooks.PaymentResponseContext(payload, req(), ok, null,
        null).settleResponse()).isSameAs(ok);
  }
}
