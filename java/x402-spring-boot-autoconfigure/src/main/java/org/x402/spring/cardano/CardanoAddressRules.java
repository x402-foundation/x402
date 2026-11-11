package org.x402.spring.cardano;

import java.util.Set;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;

/** The receiver checks, shared by startup and the per-request guard. */
final class CardanoAddressRules {

  private CardanoAddressRules() {}

  /**
   * Checks a plain (non-Masumi) receiver.
   *
   * @param network the option's network
   * @param payTo the receiver
   * @param escrows escrow addresses known on the network
   * @param escrowScripts escrow script hashes known on the network
   * @throws IllegalArgumentException when the address is on another network or pays into an
   *     escrow script (enterprise or base form, whatever the stake part)
   */
  static void checkPlainPayTo(String network, String payTo, Set<String> escrows,
      Set<String> escrowScripts) {
    CardanoAddresses.Parsed parsed;
    try {
      parsed = CardanoAddresses.parse(payTo);
    } catch (RuntimeException e) {
      throw new IllegalArgumentException("pay-to " + payTo + " is not a Cardano address on "
          + network + ": " + e.getMessage());
    }
    if (parsed.networkId() != CardanoNetworks.networkId(network)) {
      throw new IllegalArgumentException("pay-to " + payTo + " is not an address on " + network
          + " (address network id " + parsed.networkId() + ")");
    }
    boolean escrowScript = CardanoAddresses.isScript(parsed.payment())
        && escrowScripts.contains(CardanoAddresses.hashHex(parsed.payment()));
    if (escrows.contains(payTo) || escrowScript) {
      throw new IllegalArgumentException("pay-to " + payTo + " pays into a Masumi escrow script "
          + "on " + network + "; a plain transfer into the escrow script, without a datum, "
          + "cannot be recovered");
    }
  }
}
