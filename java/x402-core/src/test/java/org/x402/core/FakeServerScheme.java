package org.x402.core;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.x402.core.server.ServerHooks.SchemeServerHooks;
import org.x402.core.server.ServerHooks.SettleContext;
import org.x402.core.server.ServerHooks.SettleResultContext;
import org.x402.core.server.ServerHooks.VerifiedPaymentCanceledContext;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.Money;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.Price;
import org.x402.core.types.SupportedKind;
import org.x402.core.utils.Amounts;

/**
 * A configurable server scheme: {@code $x} → x × 10⁶ {@code USDM}; copies the facilitator kind's
 * {@code feePayer} into {@code extra}.
 */
public final class FakeServerScheme implements SchemeNetworkServer {

  private final String scheme;
  public Map<String, PaymentFlow.Config> flows =
      new LinkedHashMap<>(Map.of("default", PaymentFlow.Config.authorizationOnly()));
  public String defaultMethod = "default";
  public SchemeServerHooks hooks;
  public List<String> dynamicExtra = List.of();
  public Function<SupportedKind, String> capabilityCheck = k -> null;
  public final List<SupportedKind> enhancedWith = new ArrayList<>();
  public final List<List<String>> enhancedExtensions = new ArrayList<>();
  public Function<PaymentRequiredContext, List<PaymentRequirements>> enrich402;
  public Function<SettleContext, Map<String, Object>> enrichPayload;
  public Function<SettleResultContext, Map<String, Object>> enrichResponse;
  public Function<VerifiedPaymentCanceledContext, PaymentRequirements> onCancel;
  public Integer decimals = 6;

  public FakeServerScheme() {
    this("exact");
  }

  public FakeServerScheme(String scheme) {
    this.scheme = scheme;
  }

  @Override
  public String scheme() {
    return scheme;
  }

  @Override
  public String defaultAssetTransferMethod() {
    return defaultMethod;
  }

  @Override
  public Map<String, PaymentFlow.Config> paymentFlows() {
    return flows;
  }

  @Override
  public AssetAmount parsePrice(Price price, String network) {
    if (price instanceof AssetAmount a) {
      return a;
    }
    Amounts.ParsedMoney parsed = Amounts.parseMoney(((Money) price).value());
    if (parsed.symbol() != null && !parsed.symbol().equals(Fixtures.USDM)) {
      throw new IllegalArgumentException("unknown ticker " + parsed.symbol());
    }
    String atomic = new BigDecimal(parsed.amount()).movePointRight(6).toBigInteger().toString();
    return AssetAmount.of(Fixtures.USDM, atomic);
  }

  @Override
  public PaymentRequirements enhancePaymentRequirements(
      PaymentRequirements requirements, SupportedKind supportedKind, List<String> extensions) {
    enhancedWith.add(supportedKind);
    enhancedExtensions.add(extensions);
    Object feePayer = supportedKind.extra() == null ? null : supportedKind.extra().get("feePayer");
    return feePayer == null ? requirements : requirements.withExtra("feePayer", feePayer);
  }

  @Override
  public SchemeServerHooks schemeHooks() {
    return hooks;
  }

  @Override
  public List<String> dynamicExtraFields() {
    return dynamicExtra;
  }

  @Override
  public String validateFacilitatorSupport(
      String network, SupportedKind supportedKind, List<String> facilitatorExtensions) {
    return capabilityCheck.apply(supportedKind);
  }

  @Override
  public Integer getAssetDecimals(String asset, String network) {
    return decimals;
  }

  @Override
  public List<PaymentRequirements> enrichPaymentRequiredResponse(PaymentRequiredContext context) {
    return enrich402 == null ? null : enrich402.apply(context);
  }

  @Override
  public Map<String, Object> enrichSettlementPayload(SettleContext context) {
    return enrichPayload == null ? null : enrichPayload.apply(context);
  }

  @Override
  public Map<String, Object> enrichSettlementResponse(SettleResultContext context) {
    return enrichResponse == null ? null : enrichResponse.apply(context);
  }

  @Override
  public PaymentRequirements settleOnCancel(VerifiedPaymentCanceledContext context) {
    return onCancel == null ? null : onCancel.apply(context);
  }
}
