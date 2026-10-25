package org.x402.spring.facilitator;

import java.util.List;
import java.util.Map;
import org.x402.core.FacilitatorContext;
import org.x402.core.SchemeNetworkFacilitator;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;

/**
 * A facilitator scheme for the facilitator-server tests: valid unless {@code payload.mode} is
 * {@code invalid}; settles with transaction {@code tx-fake}; advertises {@code {marker}}.
 */
public final class FakeFacilitatorScheme implements SchemeNetworkFacilitator {

  private final String marker;

  /**
   * Creates the scheme.
   *
   * @param marker a value advertised in {@code extra.marker}
   */
  public FakeFacilitatorScheme(String marker) {
    this.marker = marker;
  }

  @Override
  public String scheme() {
    return "exact";
  }

  @Override
  public String caipFamily() {
    return "test:*";
  }

  @Override
  public Map<String, Object> getExtra(String network) {
    return Map.of("marker", marker);
  }

  @Override
  public List<String> getSigners(String network) {
    return List.of();
  }

  @Override
  public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements,
      FacilitatorContext context) {
    return "invalid".equals(payload.payload().get("mode"))
        ? VerifyResponse.invalid("invalid_payload", "fake")
        : VerifyResponse.valid("payer-" + marker);
  }

  @Override
  public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements,
      FacilitatorContext context) {
    return SettleResponse.success("tx-" + marker, requirements.network(), "payer-" + marker);
  }
}
