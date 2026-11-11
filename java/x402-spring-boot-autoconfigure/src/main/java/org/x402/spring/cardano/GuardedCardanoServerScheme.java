package org.x402.spring.cardano;

import java.util.List;
import java.util.Set;
import java.util.function.Function;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SupportedKind;
import org.x402.mechanisms.cardano.utils.CardanoConstants;
import org.x402.mechanisms.cardano.exact.server.ExactCardanoServerConfig;
import org.x402.mechanisms.cardano.exact.server.ExactCardanoServerScheme;

/**
 * The Cardano server scheme the starter registers. Before every 402 it re-checks the receiver of
 * plain options, so a {@code pay-to-ref} that resolves to an escrow address or
 * to an address on another network is refused (500, logged) instead of advertised.
 */
public class GuardedCardanoServerScheme extends ExactCardanoServerScheme {

  private final Function<String, Set<String>> escrows;
  private final Function<String, Set<String>> escrowScripts;

  /**
   * Creates the scheme.
   *
   * @param config storage and Masumi issuer
   * @param escrows escrow addresses per network
   * @param escrowScripts escrow script hashes per network
   */
  public GuardedCardanoServerScheme(ExactCardanoServerConfig config,
      Function<String, Set<String>> escrows, Function<String, Set<String>> escrowScripts) {
    super(config);
    this.escrows = escrows;
    this.escrowScripts = escrowScripts;
  }

  @Override
  public PaymentRequirements enhancePaymentRequirements(PaymentRequirements requirements,
      SupportedKind supportedKind, List<String> facilitatorExtensions) {
    Object method = requirements.extra().get("assetTransferMethod");
    if (!CardanoConstants.METHOD_MASUMI.equals(method) && requirements.payTo() != null) {
      try {
        CardanoAddressRules.checkPlainPayTo(requirements.network(), requirements.payTo(),
            escrows.apply(requirements.network()), escrowScripts.apply(requirements.network()));
      } catch (IllegalArgumentException e) {
        throw new IllegalStateException("x402: refused to advertise a Cardano receiver: "
            + e.getMessage(), e);
      }
    }
    return super.enhancePaymentRequirements(requirements, supportedKind, facilitatorExtensions);
  }
}
