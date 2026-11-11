package org.x402.spring;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.x402.core.SchemeNetworkClient;
import org.x402.core.types.PaymentRequirements;

/** A client scheme that "signs" by echoing the amount; {@code USDM} is its default asset. */
public final class TestClientScheme implements SchemeNetworkClient {

  /** Every requirement this scheme signed. */
  public final List<PaymentRequirements> signed = new CopyOnWriteArrayList<>();

  @Override
  public String scheme() {
    return "exact";
  }

  @Override
  public PaymentPayloadResult createPaymentPayload(
      int x402Version, PaymentRequirements requirements, PaymentPayloadContext context) {
    signed.add(requirements);
    return new PaymentPayloadResult(x402Version, Map.of("signed", requirements.amount()), null);
  }

  @Override
  public DefaultAsset findDefaultAsset(String asset, String network) {
    return TestServerScheme.USDM.equals(asset)
        ? new DefaultAsset(TestServerScheme.USDM, 6, "USDM") : null;
  }
}
