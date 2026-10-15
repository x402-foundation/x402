package org.x402.core.client;

import java.util.List;
import org.x402.core.types.PaymentRequirements;

/** Picks the final option; the default takes the first. */
@FunctionalInterface
public interface PaymentRequirementsSelector {

  /**
   * Picks one option.
   *
   * @param x402Version the protocol version
   * @param requirements the options left after filtering, never empty
   * @return the chosen option
   */
  PaymentRequirements select(int x402Version, List<PaymentRequirements> requirements);
}
