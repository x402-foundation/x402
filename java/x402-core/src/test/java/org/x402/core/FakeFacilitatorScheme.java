package org.x402.core;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BiFunction;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;

/** A configurable facilitator scheme recording the contexts it was called with. */
public final class FakeFacilitatorScheme implements SchemeNetworkFacilitator {

  private final String name;
  private final String family;
  public BiFunction<PaymentRequirements, FacilitatorContext, VerifyResponse> verify =
      (r, c) -> VerifyResponse.valid("payer");
  public BiFunction<PaymentRequirements, FacilitatorContext, SettleResponse> settle =
      (r, c) -> SettleResponse.success("tx", r.network(), "payer");
  public Map<String, Object> extra = Map.of("areFeesSponsored", false);
  public List<String> signers = List.of("addr_signer");
  public final List<FacilitatorContext> contexts = new CopyOnWriteArrayList<>();
  public final List<String> calls = new CopyOnWriteArrayList<>();

  public FakeFacilitatorScheme(String name, String family) {
    this.name = name;
    this.family = family;
  }

  public FakeFacilitatorScheme() {
    this("exact", "cardano:*");
  }

  @Override
  public String scheme() {
    return name;
  }

  @Override
  public String caipFamily() {
    return family;
  }

  @Override
  public Map<String, Object> getExtra(String network) {
    return extra;
  }

  @Override
  public List<String> getSigners(String network) {
    return signers;
  }

  @Override
  public VerifyResponse verify(
      PaymentPayload payload, PaymentRequirements requirements, FacilitatorContext context) {
    contexts.add(context);
    calls.add("verify:" + requirements.network());
    return verify.apply(requirements, context);
  }

  @Override
  public SettleResponse settle(
      PaymentPayload payload, PaymentRequirements requirements, FacilitatorContext context) {
    contexts.add(context);
    calls.add("settle:" + requirements.network());
    return settle.apply(requirements, context);
  }
}
