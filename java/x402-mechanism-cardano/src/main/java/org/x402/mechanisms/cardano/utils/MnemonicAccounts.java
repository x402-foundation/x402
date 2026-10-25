package org.x402.mechanisms.cardano.utils;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Network;
import com.bloxbean.cardano.client.common.model.Networks;
import java.util.Locale;

/**
 * BIP-39 mnemonic → CIP-1852 account (account {@code
 * m/1852'/1815'/accountIndex'}, payment key {@code /0/0}, base address with the {@code /2/0}
 * stake key).
 */
public final class MnemonicAccounts {

  private MnemonicAccounts() {}

  /**
   * Normalizes a mnemonic: trims, collapses whitespace, lowercases.
   *
   * @param mnemonic the raw phrase
   * @return the normalized phrase
   */
  public static String normalize(String mnemonic) {
    return mnemonic.strip().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
  }

  /**
   * The account of a mnemonic on a network.
   *
   * @param mnemonic the phrase
   * @param network the x402 Cardano network
   * @param accountIndex the account index
   * @return the account
   */
  public static Account account(String mnemonic, String network, int accountIndex) {
    Network net = CardanoNetworks.networkId(network) == 1 ? Networks.mainnet() : Networks.testnet();
    return new Account(net, normalize(mnemonic), accountIndex);
  }
}
