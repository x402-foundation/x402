package org.x402.core;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.x402.core.client.ClientHooks.SchemeClientHooks;
import org.x402.core.types.PaymentRequirements;

/** A client scheme that "signs" by echoing the amount; {@code USDM} is its default asset. */
public final class FakeClientScheme implements SchemeNetworkClient {

  private final String scheme;
  public SchemeClientHooks hooks;
  public RuntimeException fail;
  public Map<String, Object> extensions;
  public final List<PaymentPayloadContext> contexts = new CopyOnWriteArrayList<>();

  public FakeClientScheme() {
    this("exact");
  }

  public FakeClientScheme(String scheme) {
    this.scheme = scheme;
  }

  @Override
  public String scheme() {
    return scheme;
  }

  @Override
  public PaymentPayloadResult createPaymentPayload(
      int x402Version, PaymentRequirements requirements, PaymentPayloadContext context) {
    contexts.add(context);
    if (fail != null) {
      throw fail;
    }
    return new PaymentPayloadResult(x402Version, Map.of("signed", requirements.amount()),
        extensions);
  }

  @Override
  public SchemeClientHooks schemeHooks() {
    return hooks;
  }

  @Override
  public DefaultAsset findDefaultAsset(String asset, String network) {
    return Fixtures.USDM.equals(asset) ? new DefaultAsset(Fixtures.USDM, 6, "USDM") : null;
  }
}
