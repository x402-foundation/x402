package org.x402.core.client;

import java.util.List;
import org.x402.core.types.PaymentRequirements;

/** Filters or reorders payment options. */
@FunctionalInterface
public interface PaymentPolicy {

  /**
   * Applies the policy.
   *
   * @param x402Version the protocol version
   * @param requirements the remaining options, in preference order
   * @return the options to keep, in the new order
   */
  List<PaymentRequirements> apply(int x402Version, List<PaymentRequirements> requirements);
}
