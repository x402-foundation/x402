package org.x402.core.client;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.Function;
import org.x402.core.types.PaymentRequirements;

/**
 * Built-in policies. {@code preferNetwork} and {@code preferScheme} are stable partitions taking
 * several values, the first being most preferred. {@code maxAmount} applies to one asset only.
 */
public final class PaymentPolicies {

  private PaymentPolicies() {}

  /**
   * Moves options on the given networks to the front; the first network is most preferred.
   *
   * @param networks networks in preference order
   * @return the policy
   */
  public static PaymentPolicy preferNetwork(String... networks) {
    return prefer(PaymentRequirements::network, List.of(networks));
  }

  /**
   * Moves options of the given schemes to the front; the first scheme is most preferred.
   *
   * @param schemes schemes in preference order
   * @return the policy
   */
  public static PaymentPolicy preferScheme(String... schemes) {
    return prefer(PaymentRequirements::scheme, List.of(schemes));
  }

  /**
   * Drops options in {@code asset} whose atomic amount exceeds {@code maxAtomic}; options in other
   * assets, or with a non-integer amount, are kept.
   *
   * @param asset the asset identifier
   * @param maxAtomic the cap in atomic units
   * @return the policy
   */
  public static PaymentPolicy maxAmount(String asset, String maxAtomic) {
    Objects.requireNonNull(asset, "asset");
    BigInteger cap = new BigInteger(maxAtomic);
    return (version, reqs) -> reqs.stream()
        .filter(r -> !asset.equals(r.asset()) || !r.amount().matches("\\d+")
            || new BigInteger(r.amount()).compareTo(cap) <= 0)
        .toList();
  }

  private static PaymentPolicy prefer(
      Function<PaymentRequirements, String> key, List<String> preferred) {
    return (version, reqs) -> {
      List<PaymentRequirements> out = new ArrayList<>(reqs);
      for (int i = preferred.size() - 1; i >= 0; i--) {
        String value = preferred.get(i);
        List<PaymentRequirements> front = new ArrayList<>();
        List<PaymentRequirements> rest = new ArrayList<>();
        for (PaymentRequirements r : out) {
          (value.equals(key.apply(r)) ? front : rest).add(r);
        }
        front.addAll(rest);
        out = front;
      }
      return out;
    };
  }
}
