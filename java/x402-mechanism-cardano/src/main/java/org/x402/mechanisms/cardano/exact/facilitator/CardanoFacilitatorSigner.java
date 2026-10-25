package org.x402.mechanisms.cardano.exact.facilitator;

import java.util.List;
import org.x402.mechanisms.cardano.utils.MnemonicAccounts;

/**
 * The facilitator's own addresses for {@code /supported} (the chain backend does not
 * supply them). A Cardano facilitator needs no funds and signs nothing: the
 * buyer pays the fee. Without a signer the facilitator runs provider-only.
 */
@FunctionalInterface
public interface CardanoFacilitatorSigner {

  /**
   * The addresses managed by this facilitator.
   *
   * @return bech32 addresses
   */
  List<String> getAddresses();

  /**
   * A signer that advertises fixed addresses.
   *
   * @param addresses the addresses
   * @return the signer
   */
  static CardanoFacilitatorSigner ofAddresses(List<String> addresses) {
    List<String> copy = List.copyOf(addresses);
    return () -> copy;
  }

  /**
   * A signer advertising the base address of a mnemonic (account 0).
   *
   * @param mnemonic the BIP-39 phrase
   * @param network the x402 Cardano network
   * @return the signer
   */
  static CardanoFacilitatorSigner fromMnemonic(String mnemonic, String network) {
    return fromMnemonic(mnemonic, network, 0);
  }

  /**
   * A signer advertising the base address of a mnemonic.
   *
   * @param mnemonic the BIP-39 phrase
   * @param network the x402 Cardano network
   * @param accountIndex the account index
   * @return the signer
   */
  static CardanoFacilitatorSigner fromMnemonic(String mnemonic, String network, int accountIndex) {
    return ofAddresses(List.of(MnemonicAccounts.account(mnemonic, network, accountIndex).baseAddress()));
  }
}
